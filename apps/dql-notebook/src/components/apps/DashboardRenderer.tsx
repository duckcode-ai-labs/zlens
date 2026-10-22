import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useHostUi } from '../../host/host-ui';
import { EXPORT_LABELS, exportAppTile, type ExportFormat } from '../../api/exports';
import { Activity, AlertTriangle, BarChart3, Bot, Code2, Download, FileText, MoreHorizontal, ChartArea, ChartColumnBig, ChartColumnIncreasing, ChartColumnStacked, ChartScatter, CheckCircle2, Donut, Filter, Gauge, GitBranch, Grid3x3, GripVertical, Hash, LineChart, Loader2, Maximize2, PieChart, Plus, ShieldCheck, SlidersHorizontal, Sparkles, Table2, Trash2, Wand2, Workflow, Wrench, X } from 'lucide-react';
import {
  api,
  type AppBlockRecommendation,
  type DashboardDatasetCrossFilter,
  type DashboardDatasetHierarchyDrill,
  type DashboardDocumentResponse,
  type DashboardRunResponse,
  type DashboardDriverAnalysisV1,
  type DashboardDriverDefinitionV1,
  type StoryEditionV1,
  type DashboardStoryBrief,
  type DashboardViewerFilter,
} from '../../api/client';
import { isViewerLink } from '../../api/server-auth';
import { useNotebook } from '../../store/NotebookStore';
import type { CellChartConfig, QueryResult, ThemeMode } from '../../store/types';
import { ChartOutput, CHART_TYPE_OPTIONS, type ChartType } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { usePersistedAgentThreadId } from '../agent/usePersistedAgentThreadId';
import { AiSidePanel, AI_SIDE_PANEL_EXPANDED_WIDTH, AI_SIDE_PANEL_WIDTH } from '../agent/AiSidePanel';
import { renderMarkdown } from '../cells/MarkdownCellEditor';
import { inferColumnKind, columnKindToChartRole, type ChartColumnRole } from '../../utils/column-kind';
import { classifyColumns } from '../../utils/semantic-fields';
import { NODE_TYPE_COLORS, TYPE_LABELS, TYPE_TITLES } from '../lineage/lineage-constants';
import { themes, type ThemeMode as NotebookThemeMode } from '../../themes/notebook-theme';
import { encodedTileResult, mergeDashboardTileChartConfig, normalizeDashboardChartType, summarizeDashboardKpiResult } from './dashboard-chart-config';
import {
  chartToDashboardViz, coerceLayoutIntent, coerceReviewStatus, coerceTrustState, compactChartConfig,
  componentForDashboardViz, displayWithVisualization, getDashboardItemBlockId, getDqlGenUi, isRecord,
  normalizeViz, roleForDisplayComponent, textTileDisplay, uniqueStrings, type DqlGenUiMetadata,
} from './dashboard-tile-model';
import { autoLayoutDashboardItems, autoLayoutRank, layoutScore, packDashboardItems, reorderTileForDrop } from './dashboard-layout';
import { READER_TRUST_LABELS, readerTileFreshness, readerTileReceipt, readerTileTrust, readerTrustCounts } from './reader-trust';
import { pageShowsSummary } from './reader-page-structure';
import { appTrustSummary, type AppTrustSummary, type ReaderTrustItem, type ReaderTrustTile } from '@zlens/core/apps/reader-trust';
import { dashboardTileFilterChoice, isDashboardNarrativeTile } from '@zlens/core/apps/filter-reach';
import { plainDescription, ReaderTrustBadge, TrustLensBar } from './ReaderTrust';
import { DriverPanel, DriverView } from './DriverView';
import { StoryView, storyEditionSummary } from './StoryView';
import { SnapshotExportMenu, type SnapshotFormat } from './SnapshotExportMenu';
import { PageAlertsMenu } from './PageAlertsMenu';
import { ShareLinkMenu } from './ShareLinkMenu';
import { buildSnapshotBody, downloadFile, printSnapshot, snapshotToPng } from './snapshot-export';
import { CanvasPageFrame } from './CanvasPageFrame';
import { buildStoryBindingCatalog, type StoryBindingCatalog, type StoryBindingTileInput } from '@zlens/core/apps/story-bindings';
import { resultLeaderRow, selectResultMeasures } from '@zlens/core/apps/result-measures';
import { driverProbeFor } from './driver-probe';
import { drillFilters } from './mark-actions';
import { useMarkInteractions } from './useMarkInteractions';
import { numberReceiptInfo, type NumberReceiptInfo } from './NumberReceipt';
import type { MarkPointer } from '../output/echarts/EChartsChart';
import {
  autoTileSizeForItem, autoTileSizeForViz, clamp, narrowTileMinHeight, normalizeSizePreset,
  presetMatches, tileSizeForPreset, tileSizePatch, TILE_SIZE_PRESETS, type TileSizePresetId,
} from './dashboard-tile-sizing';
import {
  buildDashboardStory, isStakeholderHiddenReviewTile, prepareStakeholderItems, storyFilterChips,
} from './dashboard-presentation';
import {
  escapeRegExp, evidenceMetricRank, formatDashboardValue, formatGenUiLabel, isNumericColumn,
  pickEvidenceLabelColumn, resultValueSamples, type DashboardStory,
} from './dashboard-format';

/** Single client chart vocabulary; see `normalizeDashboardChartType`. */
function normalizeChartType(value: unknown): ChartType {
  return normalizeDashboardChartType(value) as ChartType;
}
import { useOpenAnswerInNotebook } from '../../utils/answer-to-notebook';
import { formatDisplayValue } from '../../utils/value-format';
import type { InsertDqlPayload } from '../agent/UnifiedAgentRunPanel';
import {
  buildDatasetCrossFilter,
  appendDatasetHierarchyDrill,
  carriedNavigationVariables,
  datasetAffectedTileIds,
  datasetCrossFilterFields,
  datasetMarkActions,
  popDatasetHierarchyDrill,
  removeDatasetCrossFilter,
  replaceDatasetCrossFilter,
} from './app-dataset-interactions';
import { formatDatasetGrainEvidenceDetail } from './dataset-grain-evidence';
import {
  datasetTileNotices,
  isCurrentDatasetTileEvidence,
  presentDashboardTileRunEvidence,
  presentDatasetTileEvidence,
  type DatasetEvidenceRow,
} from './dataset-tile-evidence';
import { datasetComparisonSummary } from './app-dataset-comparison';
import { datasetTileVisualizationCompatibility } from '@zlens/core/apps/tile-query';
import { pivotLayout } from '@zlens/core/apps/pivot';
import { encodingFromQuery } from '@zlens/core/apps/viz-encoding';
import { PivotTable } from './PivotTable';
import { dashboardPageRevision, dashboardRunKey, shouldRerunStaleDashboardRun } from './dashboard-run-key';
import { KpiCard, usesKpiCard } from './KpiCard';
import { plainSourceText } from './source-names';
import { dataSourceCountWords, describeDashboardFilterValues, formatDashboardFilterValue, runDataSourceCount } from './dashboard-filter-words';
import { BarCapNote } from './builder/BarCapNote';
import { barCategoryCap, withBarCategoryLimit } from './builder/sort-top-n';

const UnifiedAgentRunPanel = lazy(() => import('../agent/UnifiedAgentRunPanel')
  .then((module) => ({ default: module.UnifiedAgentRunPanel })));

type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type DashboardRunTile = DashboardRunResponse['tiles'][number];
type DashboardHierarchyCandidate = NonNullable<NonNullable<DashboardRunTile['dataset']>['hierarchy']>['candidates'][number];
const SIDE_PANEL_HEIGHT = 'clamp(320px, calc(100vh - 220px), 760px)';
const APP_CHART_TYPE_OPTIONS: Array<{ value: ChartType; label: string }> = [
  { value: 'table', label: 'Table' },
  ...CHART_TYPE_OPTIONS,
];

/**
 * Published Apps render a persisted document read-only. If an older local
 * draft somehow contains a malformed v3 Dataset scalar tile, surface the
 * authored mismatch rather than passing a multi-field result to a KPI that
 * only shows one value.
 */
const EMPTY_CATALOG: StoryBindingCatalog = {};

export function datasetTileVisualizationDisplayError(item: DashboardLayoutItem): string | undefined {
  if (!item.query) return undefined;
  const visualization = datasetTileVisualizationCompatibility(item.query, item.viz.type);
  return visualization.compatible
    ? undefined
    : `${visualization.message} Open App Studio and switch to Table or change the field selection.`;
}

/**
 * Dataset artifacts contain a declarative TileQuery specification, not a
 * Notebook-executable DQL block. Keep the App action unavailable until a
 * typed handoff exists instead of relabeling that JSON as a SQL block.
 */
export function canOpenTileInNotebook(tile: DashboardRunTile): boolean {
  const artifact = tile.artifact;
  return artifact?.sourceKind !== 'dataset_query' && Boolean(tile.result && (artifact?.dql || artifact?.sql));
}

function sampleRows(rows?: Array<Record<string, unknown>>, columns?: string[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const selectedColumns = Array.isArray(columns) && columns.length > 0 ? columns.slice(0, 8) : Object.keys(rows[0] ?? {}).slice(0, 8);
  return rows.slice(0, 5).map((row) => Object.fromEntries(selectedColumns.map((column) => [column, row[column]])));
}

/**
 * A partial response is an execution result for only declared affected tiles.
 * Preserve results for other tiles from the last settled scope, but never
 * carry its story, facts, receipt identity, or filter options forward. Those
 * describe a whole dashboard and must be obtained from a full current run.
 */
export function mergePartialDashboardRun(
  previous: DashboardRunResponse,
  partial: DashboardRunResponse,
  layoutItems: DashboardLayoutItem[],
): DashboardRunResponse {
  const updates = new Map(partial.tiles.map((tile) => [tile.tileId, tile]));
  const priorTiles = new Map(previous.tiles.map((tile) => [tile.tileId, tile]));
  const tiles = layoutItems.flatMap((item) => {
    const updated = updates.get(item.i);
    if (updated) return [updated];
    const prior = priorTiles.get(item.i);
    return prior ? [prior] : [];
  });
  return {
    ...partial,
    partial: true,
    executedTileIds: partial.executedTileIds ?? partial.tiles.map((tile) => tile.tileId),
    tiles,
    facts: [],
    story: partial.story,
    filterOptions: undefined,
  };
}

/** A mounted dashboard owns only its own supersession lane on the local server. */
function createDashboardRunScope(): string {
  return `viewer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}



/**
 * Grid renderer for `.dqld` dashboards backed by the live dashboard run API.
 */
/**
 * A run whose story can be read: not partial, not incomplete, and not stale. A stale run (superseded by a later one,
 * or the project changed while it ran) records no evidence, so asking for its story is a 404.
 */
export function dashboardRunIsSettled(result: { partial?: boolean; incomplete?: unknown; stale?: boolean } | null | undefined): boolean {
  return Boolean(result) && !result!.partial && !result!.incomplete && !result!.stale;
}

export function DashboardRenderer({
  appId,
  dashboard,
  variables,
  viewerFilters,
  editable = false,
  embeddedHeader = false,
  onDashboardChanged,
  selectedBlockId,
  onBlockFocus,
  onAskBlock,
  onAskChart,
  onOpenLineageNode,
  copilotOpen,
  onCopilotChange,
  onRunChange,
  onTrustChange,
  onNavigateDashboard,
}: {
  appId: string;
  dashboard: DashboardDocumentResponse['dashboard'];
  variables?: Record<string, unknown>;
  /**
   * The viewer's own "Filter by…" choices. Their values are also in
   * `variables`; this says which tiles they were shown to narrow, so the
   * server can bind them without the page declaring them.
   */
  viewerFilters?: DashboardViewerFilter[];
  editable?: boolean;
  embeddedHeader?: boolean;
  onDashboardChanged?: (dashboard: DashboardDocumentResponse['dashboard']) => void;
  selectedBlockId?: string | null;
  onBlockFocus?: (blockId: string) => void;
  onAskBlock?: (blockId: string, question: string) => void;
  /** A Dataset chart question carries only the server-issued settled run id. */
  onAskChart?: (input: { tileId: string; runId: string; question: string }) => void;
  onOpenLineageNode?: (nodeId: string) => void;
  copilotOpen?: boolean;
  onCopilotChange?: (open: boolean) => void;
  onRunChange?: (run: DashboardRunResponse | null) => void;
  /**
   * The page's one aggregate data trust (see `appTrustSummary`), so the App
   * header shows exactly what the Trust Lens line, story and tiles show.
   */
  onTrustChange?: (trust: AppTrustSummary | null) => void;
  /** Page navigation is owned by AppsView because it owns page filter state. */
  onNavigateDashboard?: (input: {
    fromDashboardId: string;
    toDashboardId: string;
    carryFilterIds: string[];
    variables: Record<string, unknown>;
  }) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string } | void;
}): JSX.Element {
  const { state } = useNotebook();
  const t = themes[state.themeMode as NotebookThemeMode];
  const [run, setRun] = useState<DashboardRunResponse | null>(null);
  /** When each tile's current result arrived, for the reader's freshness label. */
  const [tileRanAt, setTileRanAt] = useState<Record<string, number>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [trustLens, setTrustLens] = useState(false);
  const readOnlyLink = isViewerLink();
  // With a host, a tile's download is made on the server for the export (HH-17).
  const hosted = useHostUi().host;
  const tileExport = hosted && !editable && !readOnlyLink
    ? (tileId: string) => (format: ExportFormat) => exportAppTile(appId, dashboard.id, { tileId, format, variables: runVariables, ...viewerFilterOption() })
    : undefined;
  /** The open "Why did it move?" panel, if any. */
  const [driverPanel, setDriverPanel] = useState<{
    item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
    definition: DashboardDriverDefinitionV1;
    state: { status: 'loading' } | { status: 'ready'; analysis: DashboardDriverAnalysisV1; tile: DashboardRunResponse['tiles'][number] } | { status: 'error'; message: string };
  } | null>(null);
  const driverRequestRef = useRef(0);
  /** Whether the latest partial run came from a reader interaction (a mark or drill). */
  const [partialFromInteraction, setPartialFromInteraction] = useState(false);
  const [activeCrossFilters, setActiveCrossFilters] = useState<DashboardDatasetCrossFilter[]>([]);
  const [activeHierarchyDrills, setActiveHierarchyDrills] = useState<DashboardDatasetHierarchyDrill[]>([]);
  const [crossFilterNotice, setCrossFilterNotice] = useState<string | null>(null);
  const [businessStory, setBusinessStory] = useState<DashboardStoryBrief | null>(null);
  const latestRunIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Monotonic id so only the newest dashboard run may write state. */
  const runRequestRef = useRef(0);
  const runScopeRef = useRef(createDashboardRunScope());
  const visibleTileIdsRef = useRef<string[]>([]);
  const pendingAffectedTileIdsRef = useRef<string[] | null>(null);
  const latestSettledRunRef = useRef<DashboardRunResponse | null>(null);
  // A run reads the newest page and callback through refs, so a re-fetched copy
  // of the same page (a new object, same content) never starts a run (B1).
  const dashboardRef = useRef(dashboard);
  dashboardRef.current = dashboard;
  const onRunChangeRef = useRef(onRunChange);
  onRunChangeRef.current = onRunChange;
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  // Server-persisted conversation thread, keyed per app dashboard so a page
  // refresh resumes the same Dashboard AI conversation.
  const agentThread = usePersistedAgentThreadId(`app:${appId}:${dashboard.id}`);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog, setCatalog] = useState<AppBlockRecommendation[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [lineageOpen, setLineageOpen] = useState(false);
  const [lineage, setLineage] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingLayoutItems, setPendingLayoutItems] = useState<DashboardLayoutItem[] | null>(null);
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);
  const [retryingTileId, setRetryingTileId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [textDialogKind, setTextDialogKind] = useState<'text' | 'heading' | null>(null);
  const [textDialogValue, setTextDialogValue] = useState('');
  const [dragPreview, setDragPreview] = useState<{ tileId: string; x: number; y: number; w: number; h: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1120);
  const breakpoint = containerWidth < 720 ? 'narrow' : containerWidth < 1120 ? 'medium' : 'wide';
  const responsiveLayouts = (dashboard.layout as typeof dashboard.layout & {
    responsive?: Partial<Record<'wide' | 'medium' | 'narrow', { kind: 'grid'; cols: number; rowHeight: number; items: DashboardLayoutItem[] }>>;
  }).responsive;
  const openAnswerInNotebook = useOpenAnswerInNotebook();
  const variablesKey = useMemo(() => JSON.stringify(variables ?? {}), [variables]);
  const runVariables = useMemo<Record<string, unknown>>(() => JSON.parse(variablesKey), [variablesKey]);
  const viewerFiltersKey = useMemo(() => JSON.stringify(viewerFilters ?? []), [viewerFilters]);
  const runViewerFilters = useMemo<DashboardViewerFilter[]>(() => JSON.parse(viewerFiltersKey), [viewerFiltersKey]);
  const viewerFilterIds = useMemo(() => runViewerFilters.map((filter) => filter.column), [runViewerFilters]);
  // Every run of this page carries the viewer's filters; read through a ref so
  // the many existing run paths keep their signatures.
  const viewerFiltersRef = useRef<DashboardViewerFilter[]>(runViewerFilters);
  viewerFiltersRef.current = runViewerFilters;
  const viewerFilterOption = () => (viewerFiltersRef.current.length ? { viewerFilters: viewerFiltersRef.current } : {});
  const crossFiltersKey = useMemo(() => JSON.stringify(activeCrossFilters), [activeCrossFilters]);
  const effectiveCrossFilters = useMemo<DashboardDatasetCrossFilter[]>(() => JSON.parse(crossFiltersKey), [crossFiltersKey]);
  const hierarchyDrillsKey = useMemo(() => JSON.stringify(activeHierarchyDrills), [activeHierarchyDrills]);
  const effectiveHierarchyDrills = useMemo<DashboardDatasetHierarchyDrill[]>(() => JSON.parse(hierarchyDrillsKey), [hierarchyDrillsKey]);
  const tileResults = useMemo(() => {
    const map = new Map<string, DashboardRunResponse['tiles'][number]>();
    for (const tile of run?.tiles ?? []) map.set(tile.tileId, tile);
    return map;
  }, [run]);
  const workingLayoutItems = pendingLayoutItems ?? dashboard.layout.items;
  const activeLayout = useMemo(() => {
    const explicit = responsiveLayouts?.[breakpoint];
    const geometry = breakpoint === 'wide'
      ? { kind: 'grid' as const, cols: dashboard.layout.cols, rowHeight: dashboard.layout.rowHeight, items: workingLayoutItems }
      : explicit ?? {
          kind: 'grid' as const,
          cols: breakpoint === 'medium' ? 6 : 1,
          rowHeight: dashboard.layout.rowHeight,
          items: projectDashboardItems(workingLayoutItems, breakpoint === 'medium' ? 6 : 1),
        };
    const content = new Map(workingLayoutItems.map((item) => [item.i, item]));
    return {
      ...geometry,
      items: geometry.items.map((item) => ({ ...content.get(item.i), ...item } as DashboardLayoutItem)),
    };
  }, [breakpoint, dashboard.layout.cols, dashboard.layout.rowHeight, responsiveLayouts, workingLayoutItems]);
  const narrowGrid = breakpoint === 'narrow';
  const cols = activeLayout.cols;
  const rowHeight = activeLayout.rowHeight;
  const editableCanvas = editable && breakpoint === 'wide';
  const workingDashboard = useMemo(() => ({
    ...dashboard,
    layout: { ...dashboard.layout, items: workingLayoutItems },
  }), [dashboard, workingLayoutItems]);
  const baseVisibleItems = useMemo(
    () => editable ? activeLayout.items : activeLayout.items.filter((item) => !isStakeholderHiddenReviewTile(item)),
    [activeLayout.items, editable],
  );
  // The browser owns presentation visibility, but the server validates these
  // IDs against the authored page before using them as a bounded scheduler
  // hint. Hidden review tiles are intentionally not refreshed for a
  // stakeholder-only render.
  visibleTileIdsRef.current = baseVisibleItems.map((item) => item.i);
  const visibleItems = useMemo(
    () => editable ? baseVisibleItems : prepareStakeholderItems(baseVisibleItems, tileResults, cols),
    [baseVisibleItems, cols, editable, tileResults],
  );
  const hiddenReviewTileCount = dashboard.layout.items.length - baseVisibleItems.length;
  const hiddenPresentationTileCount = baseVisibleItems.length - visibleItems.length;
  // Server-narrated story sections (AI-built apps). In view mode they replace both
  // the client-computed story strip and the flat grid; edit mode keeps the classic
  // grid so drag/drop tooling is untouched. Old dashboards have no sections.
  const storySections = useMemo(
    () => (!editable && !dashboard.story && dashboard.sections && dashboard.sections.length > 0
      ? [...dashboard.sections].sort((a, b) => a.order - b.order)
      : null),
    [dashboard.sections, dashboard.story, editable],
  );
  // Story mode intentionally SHOWS review-required tiles: the appendix exists to
  // surface AI-generated analysis, clearly badged — so it bypasses the stakeholder
  // review-tile hiding that governs classic grids.
  const storyItems = useMemo(
    () => (storySections ? activeLayout.items : null),
    [activeLayout.items, storySections],
  );
  // The auto-written Summary is off unless the page's author added it (D6).
  const summaryAdded = pageShowsSummary(dashboard.metadata);
  const dashboardStory = useMemo(
    () => (editable || !summaryAdded || storySections || run?.partial || run?.incomplete ? null : buildDashboardStory(visibleItems, tileResults, runVariables, dashboard.filters)),
    [dashboard.filters, editable, summaryAdded, run?.incomplete, run?.partial, runVariables, storySections, tileResults, visibleItems],
  );
  useEffect(() => {
    if (editable) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [editable]);
  // Page trust covers every tile whose result feeds this page — including
  // tiles collapsed because a certified tile answers the same question, since
  // they still ran and the page story narrates them. Only review tiles hidden
  // from (and not run for) a stakeholder are outside it.
  const trustItems = storyItems ?? baseVisibleItems;
  const trustCounts = useMemo(
    () => (editable || !run ? [] : readerTrustCounts(trustItems.map((item) => readerTileTrust(item, tileResults.get(item.i))))),
    [editable, run, trustItems, tileResults],
  );
  // One aggregate trust for this page, from the same items and run evidence
  // as the tile badges. Every page-level label reads it.
  const pageTrust = useMemo(
    () => (editable ? null : appTrustSummary(
      trustItems as unknown as ReadonlyArray<ReaderTrustItem & { i: string }>,
      run ? (tileResults as unknown as ReadonlyMap<string, ReaderTrustTile>) : undefined,
    )),
    [editable, run, trustItems, tileResults],
  );
  useEffect(() => {
    onTrustChange?.(pageTrust);
  }, [onTrustChange, pageTrust]);
  const runDriverProbe = useCallback(async (
    item: DashboardDocumentResponse['dashboard']['layout']['items'][number],
    definition: DashboardDriverDefinitionV1,
  ) => {
    const requestId = driverRequestRef.current + 1;
    driverRequestRef.current = requestId;
    setDriverPanel({ item, definition, state: { status: 'loading' } });
    try {
      // No runScope: the probe must not supersede the page's own run.
      // The explanation describes what is on screen: the reader's selected
      // marks and this tile's drill path narrow both periods.
      const drilled = drillFilters(effectiveHierarchyDrills.find((drill) => drill.tileId === item.i)?.steps)
        .map((filter) => ({ field: filter.field, op: filter.op as 'eq' | 'in', values: (filter.values ?? []) as Array<string | number | boolean> }));
      const driver = drilled.length ? { ...definition, filters: [...(definition.filters ?? []), ...drilled] } : definition;
      const result = await api.runDashboard(appId, dashboard.id, runVariables, effectiveCrossFilters.length ? effectiveCrossFilters : undefined, { driverProbe: { fromTileId: item.i, driver }, ...viewerFilterOption() });
      if (driverRequestRef.current !== requestId) return;
      const tile = result.tiles.find((candidate) => candidate.tileType === 'driver');
      setDriverPanel({
        item,
        definition,
        state: tile?.status === 'ok' && tile.driver
          ? { status: 'ready', analysis: tile.driver, tile }
          : { status: 'error', message: tile?.error ?? 'The comparison did not run.' },
      });
    } catch (cause) {
      if (driverRequestRef.current !== requestId) return;
      setDriverPanel({ item, definition, state: { status: 'error', message: cause instanceof Error ? cause.message : String(cause) } });
    }
  }, [appId, dashboard.id, runVariables, effectiveCrossFilters, effectiveHierarchyDrills]);
  const explainChange = useCallback((item: DashboardDocumentResponse['dashboard']['layout']['items'][number], tile: DashboardRunResponse['tiles'][number]) => {
    const definition = driverProbeFor(item, tile);
    if (definition) void runDriverProbe(item, definition);
  }, [runDriverProbe]);
  // Story layout (RFC 0008 step 8): readers see the page as prose whose
  // figures come from this run, plus the tiles it embeds.
  const storyNarrative = !editable && dashboard.narrative?.presentation === 'story' ? dashboard.narrative : null;
  // Governed HTML page (RFC 0008 step 9).
  const canvasPage = !editable && dashboard.narrative?.presentation === 'canvas' && dashboard.canvas ? dashboard.canvas : null;
  // Every figure this run returned: stories, HTML pages, alerts and exports read it.
  const runCatalog = useMemo(
    () => (!editable && run ? buildStoryBindingCatalog(run.tiles as StoryBindingTileInput[], Object.fromEntries(dashboard.layout.items.map((item) => [item.i, item.title]))) : {}),
    [dashboard.layout.items, editable, run],
  );
  const storyCatalog = storyNarrative || canvasPage ? runCatalog : EMPTY_CATALOG;
  /** What a number in a Report or Custom layout is, where it comes from and how far to trust it. */
  const numberReceiptFor = useCallback((key: string): NumberReceiptInfo | null => {
    const binding = runCatalog[key];
    return numberReceiptInfo(binding, dashboard.layout.items, run, binding ? tileRanAt[binding.tileId] : undefined, runCatalog);
  }, [runCatalog, dashboard.layout.items, run, tileRanAt]);
  const [storyEditions, setStoryEditions] = useState<StoryEditionV1[] | null>(null);
  useEffect(() => {
    if (!storyNarrative || !run || run.partial || run.incomplete) return;
    let cancelled = false;
    void api.getStoryEditions(appId, dashboard.id).then((editions) => { if (!cancelled) setStoryEditions(editions); });
    return () => { cancelled = true; };
  }, [appId, dashboard.id, run?.runId, storyNarrative]);
  // Export (RFC 0008 step 10): one signed snapshot of the current complete
  // run; the image and PDF are drawn from the same signed document.
  const snapshotBlockedReason = loading ? 'Wait for the page to finish loading.'
    : !run ? 'Run the page first.'
      : run.partial || run.incomplete ? 'Reset your selection so the whole page shows, then export.'
        : null;
  const exportSnapshot = async (format: SnapshotFormat): Promise<string> => {
    if (!run || snapshotBlockedReason) throw new Error(snapshotBlockedReason ?? 'Run the page first.');
    const shownItems = storyNarrative || canvasPage
      ? dashboard.layout.items
      : prepareStakeholderItems(dashboard.layout.items.filter((item) => !isStakeholderHiddenReviewTile(item)), tileResults, dashboard.layout.cols);
    const { body, tileIds } = buildSnapshotBody({
      items: shownItems,
      tiles: run.tiles,
      catalog: runCatalog,
      cols: dashboard.layout.cols,
      rowHeight: dashboard.layout.rowHeight,
      narrative: storyNarrative,
      canvas: canvasPage,
    });
    const signed = await api.exportAppSnapshot(appId, dashboard.id, { runId: run.runId, body, tileIds });
    if (!signed.ok || !signed.html) throw new Error(signed.error ?? 'The snapshot could not be signed.');
    const proof = `signed by project key ${signed.keyId}, ${signed.figures} ${signed.figures === 1 ? 'figure' : 'figures'} recorded`;
    if (format === 'html') {
      downloadFile(signed.fileName, signed.html);
      return `Saved ${signed.fileName}: ${proof}. Check it with zlens app verify.`;
    }
    if (format === 'png') {
      const fileName = signed.fileName.replace(/\.signed\.html$/, '.png');
      downloadFile(fileName, await snapshotToPng(signed.html));
      return `Saved ${fileName} from a snapshot ${proof}.`;
    }
    await printSnapshot(signed.html);
    return `Opened the print dialog for a snapshot ${proof}. Choose “Save as PDF” to keep a PDF.`;
  };
  /** One tile on the grid; the story page embeds tiles through the same path. */
  const renderGridTile = (item: DashboardLayoutItem) => (
        <DashboardTile
          key={item.i}
          item={item}
          tile={tileResults.get(item.i)}
          loading={loading}
          error={error}
          themeMode={state.themeMode}
          editable={editableCanvas}
          narrow={narrowGrid}
          cols={cols}
          selected={Boolean(getDashboardItemBlockId(item) && getDashboardItemBlockId(item) === selectedBlockId)}
          onFocusBlock={onBlockFocus}
          onAskBlock={onAskBlock}
          onAskChart={onAskChart}
          runId={run?.runId}
          reader={readerContext}
          onExplainChange={editable ? undefined : explainChange}
          onMove={(point) => void moveTileToPoint(item.i, point)}
          onDragMove={(point) => updateDragPreview(item.i, point)}
          onDragEnd={clearDragPreview}
          onPatch={(patch) => void patchTile(item.i, patch)}
          onRetry={() => void retryTile(item.i)}
          retrying={retryingTileId === item.i}
          retryDisabled={Boolean(retryingTileId && retryingTileId !== item.i)}
          onOpenNotebook={(nextTile) => void openTileInNotebook(item, nextTile)}
          activeVariables={runVariables}
          viewerFilterIds={viewerFilterIds}
          filterLabels={dashboardFilterLabels(dashboard)}
          onExport={tileExport?.(item.i)}
          crossFilterFields={datasetCrossFilterFields(dashboard, item)}
          onSelectDatasetMark={(field, values) => applyDatasetMark(item, field, values)}
          onDrillDatasetMark={(candidate, row) => applyDatasetHierarchyDrill(item, candidate, row)}
          onDrillBack={() => returnFromDatasetHierarchyDrill(item.i)}
          onMark={(row, at, candidates) => openMarkMenu(item, tileResults.get(item.i), row, at, candidates)}
          onNavigate={dashboard.interactions?.navigate?.some((candidate) => candidate.fromTile === item.i)
            ? () => void navigateFromDatasetTile(item.i)
            : undefined}
        />
  );
  const readerContext = useMemo<ReaderTileContext | undefined>(
    () => (editable ? undefined : {
      ranAtByTile: tileRanAt,
      nowMs,
      run: run ? { runId: run.runId, snapshotId: run.snapshotId, filterFingerprint: run.filterFingerprint } : null,
      trustLens,
    }),
    [editable, nowMs, run, tileRanAt, trustLens],
  );

  useEffect(() => {
    setPendingLayoutItems(null);
    setLayoutNotice(null);
    setActiveCrossFilters([]);
    setActiveHierarchyDrills([]);
    setCrossFilterNotice(null);
    pendingAffectedTileIdsRef.current = null;
    latestSettledRunRef.current = null;
  }, [dashboard.id]);

  /**
   * Every published dashboard trigger uses this path. The server cancels or
   * invalidates superseded work, while this monotonic sequence prevents a late
   * browser response or story fetch from repainting an older scope.
   */
  const runLatest = useCallback(async (
    nextVariables: Record<string, unknown>,
    nextCrossFilters: DashboardDatasetCrossFilter[],
    nextHierarchyDrills: DashboardDatasetHierarchyDrill[],
    schedule?: { tileId?: string; affectedTileIds?: string[] },
    staleAttempt = 0,
  ): Promise<DashboardRunResponse | null> => {
    const onRunChange = onRunChangeRef.current;
    const layoutItems = dashboardRef.current.layout.items;
    const requestId = runRequestRef.current + 1;
    runRequestRef.current = requestId;
    const isCurrent = () => runRequestRef.current === requestId;
    const boundedRefresh = Boolean(schedule?.tileId || schedule?.affectedTileIds?.length);
    const priorRun = latestSettledRunRef.current;
    setLoading(true);
    setError(null);
    setBusinessStory(null);
    // Do not present a prior result as the scope represented by the currently
    // selected page filter or mark while the fresh governed execution runs.
    // An affected-only refresh keeps unaffected tiles only when the authored
    // mapping says their inputs cannot change; the visible status marks the
    // mapped tiles stale until their server result settles.
    if (!boundedRefresh || !priorRun) {
      setRun(null);
      onRunChange?.(null);
    } else {
      // The old rows remain visible only for unrelated tiles. Their combined
      // story, filters, and evidence are invalid until the mapped tile subset
      // has returned for this interaction scope.
      const stalePresentation = { ...priorRun, partial: true, facts: [] };
      setRun(stalePresentation);
      onRunChange?.(stalePresentation);
    }
    try {
      const result = await api.runDashboard(appId, dashboard.id, nextVariables, nextCrossFilters, {
        runScope: runScopeRef.current,
        // The server orders this viewer's requests by this number, not by when
        // they arrive, so an older request can never cancel a newer one.
        runSequence: requestId,
        ...(schedule?.tileId ? { tileId: schedule.tileId } : {}),
        // A bounded run never earns the page story, even when its set happens
        // to name every tile, so only send the bound when a tile is hidden.
        ...(schedule?.affectedTileIds?.length
          ? { affectedTileIds: schedule.affectedTileIds }
          : visibleTileIdsRef.current.length < layoutItems.length ? { visibleTileIds: visibleTileIdsRef.current } : {}),
        ...(nextHierarchyDrills.length ? { datasetDrills: nextHierarchyDrills } : {}),
        ...viewerFilterOption(),
      });
      if (!isCurrent()) return null;
      // A reader has no Run button. If the newest run went stale (a newer
      // interaction or a project change overtook it), run it again rather
      // than leave "superseded" on the page.
      if (shouldRerunStaleDashboardRun(result, staleAttempt)) {
        return runLatest(nextVariables, nextCrossFilters, nextHierarchyDrills, schedule, staleAttempt + 1);
      }
      const accepted = result?.partial && boundedRefresh && priorRun
        ? mergePartialDashboardRun(priorRun, result, layoutItems)
        : result;
      setRun(accepted);
      if (accepted) latestSettledRunRef.current = accepted;
      if (result) {
        const settledAt = Date.now();
        const ranIds = result.partial ? (result.executedTileIds ?? result.tiles.map((entry) => entry.tileId)) : result.tiles.map((entry) => entry.tileId);
        setTileRanAt((current) => {
          const next: Record<string, number> = result.partial && boundedRefresh ? { ...current } : {};
          for (const tileId of ranIds) next[tileId] = settledAt;
          return next;
        });
        setNowMs(settledAt);
        setPartialFromInteraction(Boolean(result.partial && boundedRefresh));
      }
      setBusinessStory(dashboardRunIsSettled(result) ? result?.story ?? null : null);
      latestRunIdRef.current = result?.runId ?? null;
      onRunChange?.(accepted);
      if (result?.runId && dashboardRunIsSettled(result)) {
        void api.getDashboardStory(appId, dashboard.id, result.runId).then((storyResult) => {
          if (!isCurrent() || !storyResult || latestRunIdRef.current !== storyResult.runId) return;
          if (storyResult.snapshotId !== result.snapshotId || storyResult.filterFingerprint !== result.filterFingerprint || storyResult.resultFingerprint !== result.resultFingerprint || storyResult.personaFingerprint !== result.personaFingerprint) return;
          setBusinessStory(storyResult.story);
        });
      }
      return result;
    } catch (err) {
      if (!isCurrent()) return null;
      setError(err instanceof Error ? err.message : String(err));
      onRunChange?.(null);
      return null;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [appId, dashboard.id]);

  // B1: the page runs when what a run reads changes — the page's content and
  // the effective filter values — never because a parent handed over a new
  // object with the same content.
  const pageRevision = useMemo(() => dashboardPageRevision(dashboard), [dashboard]);
  const autoRunKey = useMemo(() => dashboardRunKey({
    appId,
    page: dashboard,
    pageRevision,
    variables: runVariables,
    viewerFilters: runViewerFilters,
    crossFilters: effectiveCrossFilters,
    hierarchyDrills: effectiveHierarchyDrills,
    persona: state.activePersona?.userId ?? null,
  // `dashboard` is read for its filter defaults, which pageRevision already covers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [appId, effectiveCrossFilters, effectiveHierarchyDrills, pageRevision, runVariables, runViewerFilters, state.activePersona?.userId]);
  const autoRunInputsRef = useRef({ runVariables, effectiveCrossFilters, effectiveHierarchyDrills });
  autoRunInputsRef.current = { runVariables, effectiveCrossFilters, effectiveHierarchyDrills };

  useEffect(() => {
    const affectedTileIds = pendingAffectedTileIdsRef.current;
    pendingAffectedTileIdsRef.current = null;
    const inputs = autoRunInputsRef.current;
    void runLatest(inputs.runVariables, inputs.effectiveCrossFilters, inputs.effectiveHierarchyDrills, affectedTileIds?.length ? { affectedTileIds } : undefined);
  }, [autoRunKey, runLatest]);

  useEffect(() => {
    const rerun = () => {
      pendingAffectedTileIdsRef.current = null;
      void runLatest(runVariables, effectiveCrossFilters, effectiveHierarchyDrills);
    };
    window.addEventListener('dql-app-datasets-enabled', rerun);
    return () => window.removeEventListener('dql-app-datasets-enabled', rerun);
  }, [effectiveCrossFilters, effectiveHierarchyDrills, runLatest, runVariables]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ appId?: string; dashboardId?: string }>).detail;
      if (detail?.appId !== appId || detail.dashboardId !== dashboard.id) return;
      void api.getDashboard(appId, dashboard.id).then((next) => {
        if (next?.dashboard) onDashboardChanged?.(next.dashboard);
      });
      pendingAffectedTileIdsRef.current = null;
      void runLatest(runVariables, effectiveCrossFilters, effectiveHierarchyDrills);
    };
    window.addEventListener('dql-app-dashboard-updated', handler);
    return () => window.removeEventListener('dql-app-dashboard-updated', handler);
  }, [appId, dashboard.id, effectiveCrossFilters, effectiveHierarchyDrills, onDashboardChanged, runLatest, runVariables]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setContainerWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const chatContext = useMemo(() => {
    const tiles = dashboard.layout.items.map((item) => {
      const tile = tileResults.get(item.i);
      const blockRef = item.block
        ? ('blockId' in item.block ? item.block.blockId : item.block.ref)
        : item.query ? `dataset:${item.sourceId ?? 'field query'}`
        : item.semantic ? `semantic:${item.semantic.id}`
          : item.draftAnalysis ? `draft:${item.draftAnalysis.ref}`
          : item.aiPin ? `aiPin:${item.aiPin.id}` : 'text';
      return {
        title: item.title,
        blockRef,
        viz: item.viz.type,
        certificationStatus: tile?.certificationStatus,
        status: tile?.status,
        rowCount: tile?.result?.rowCount,
        columns: tile?.result?.columns?.slice(0, 8),
        sampleRows: sampleRows(tile?.result?.rows, tile?.result?.columns),
      };
    });
    return JSON.stringify({
      scope: 'dashboard',
      appId,
      dashboardId: dashboard.id,
      title: dashboard.metadata.title,
      description: dashboard.metadata.description,
      domain: dashboard.metadata.domain,
      filters: dashboard.filters,
      variables: runVariables,
      run: run ? {
        runId: run.runId,
        snapshotId: run.snapshotId,
        filterFingerprint: run.filterFingerprint,
        resultFingerprint: run.resultFingerprint,
        personaFingerprint: run.personaFingerprint,
        story: run.story,
        facts: run.facts,
      } : null,
      tiles,
    }, null, 2);
  }, [appId, dashboard, run, runVariables, tileResults]);

  const saveItems = useCallback(async (
    items: DashboardDocumentResponse['dashboard']['layout']['items'],
    successMessage = 'Changes saved',
  ) => {
    setSaving(true);
    setError(null);
    const next = {
      ...dashboard,
      layout: {
        ...dashboard.layout,
        items,
      },
    };
    try {
      const result = await api.patchDashboardLayout(appId, dashboard.id, next.layout);
      if (result.ok) {
        setPendingLayoutItems(null);
        setLayoutNotice(successMessage);
        onDashboardChanged?.(result.dashboard);
      } else {
        setError(result.error);
      }
    } finally {
      setSaving(false);
    }
  }, [appId, dashboard, onDashboardChanged]);

  /**
   * Geometry is staged while a layout preview is pending; content is not.
   *
   * This used to stage *everything* once "Auto layout" set a pending preview —
   * a tile rename, a viz change, even a delete would sit in React state and
   * never reach the server until Apply was clicked, with no indication the work
   * was unsaved. Only positions are provisional during a preview; a content
   * edit must save immediately and be carried into the pending preview so
   * applying the layout does not revert it.
   */
  const stageOrSaveItems = useCallback(async (items: DashboardLayoutItem[], kind: 'geometry' | 'content' = 'geometry') => {
    if (pendingLayoutItems && kind === 'geometry') {
      setPendingLayoutItems(items);
      setLayoutNotice('Layout preview ready');
      return;
    }
    if (pendingLayoutItems) setPendingLayoutItems(items);
    await saveItems(items);
  }, [pendingLayoutItems, saveItems]);

  const openCatalog = useCallback(async () => {
    setCatalogOpen(true);
    const result = await api.getAppEditorCatalog(appId);
    setCatalog(result?.blocks ?? []);
  }, [appId]);

  const addBlockTile = useCallback(async (block: AppBlockRecommendation) => {
    const vizType = normalizeViz(block.chartType);
    const recommendation = await api.recommendDashboardTile(appId, dashboard.id, {
      blockRef: block.name,
      appAudience: dashboard.metadata.audience,
      prompt: `${dashboard.metadata.title} ${block.name} ${block.description}`,
      defaultVisualization: vizType,
    });
    const size = autoTileSizeForViz(vizType, cols);
    const tile = {
      i: nextTileId(workingDashboard, block.name),
      ...nextTilePosition(workingDashboard, size),
      block: { blockId: block.name },
      viz: { type: vizType },
      ...(recommendation.ok ? {
        display: recommendation.display,
        filterBindings: 'filterBindings' in recommendation ? recommendation.filterBindings : undefined,
        parameterBindings: 'parameterBindings' in recommendation ? recommendation.parameterBindings : undefined,
        sourceEvidence: 'sourceEvidence' in recommendation ? recommendation.sourceEvidence : undefined,
        trustState: 'trustState' in recommendation ? recommendation.trustState : recommendation.display.trustState,
        reviewStatus: 'reviewStatus' in recommendation ? recommendation.reviewStatus : recommendation.display.reviewStatus,
      } : {}),
      title: block.name,
    };
    await stageOrSaveItems([...workingLayoutItems, tile], 'content');
    setCatalogOpen(false);
  }, [appId, cols, dashboard.id, dashboard.metadata.audience, dashboard.metadata.title, stageOrSaveItems, workingDashboard, workingLayoutItems]);

  const addTextTile = useCallback(async () => {
    setTextDialogKind('text');
    setTextDialogValue('');
  }, []);

  const addHeadingTile = useCallback(async () => {
    setTextDialogKind('heading');
    setTextDialogValue('');
  }, []);

  const saveTextTile = useCallback(async () => {
    const value = textDialogValue.trim();
    if (!value || !textDialogKind) return;
    if (textDialogKind === 'heading') {
      await stageOrSaveItems([
        ...workingLayoutItems,
        {
          i: nextTileId(workingDashboard, 'section'),
          ...nextTilePosition(workingDashboard, tileSizeForPreset('wide', cols, 'heading')),
          text: { markdown: value },
          viz: { type: 'heading' },
          display: textTileDisplay('heading', value),
          title: value,
        },
      ], 'content');
    } else {
      const title = value.split(/\r?\n/)[0]?.slice(0, 60) || 'Summary';
      await stageOrSaveItems([
        ...workingLayoutItems,
        {
          i: nextTileId(workingDashboard, 'text'),
          ...nextTilePosition(workingDashboard, tileSizeForPreset('standard', cols, 'text')),
          text: { markdown: value },
          viz: { type: 'text' },
          display: textTileDisplay('text', title),
          title,
        },
      ]);
    }
    setTextDialogKind(null);
    setTextDialogValue('');
  }, [cols, stageOrSaveItems, textDialogKind, textDialogValue, workingDashboard, workingLayoutItems]);

  const patchTile = useCallback(async (tileId: string, patch: Partial<DashboardLayoutItem> | null) => {
    const items = patch === null
      ? workingLayoutItems.filter((item) => item.i !== tileId)
      : workingLayoutItems.map((item) => item.i === tileId ? { ...item, ...patch } : item);
    // A removal, or any patch touching something other than position/size, is
    // content and must save even while a layout preview is pending.
    const geometryOnly = patch !== null
      && Object.keys(patch).every((key) => key === 'x' || key === 'y' || key === 'w' || key === 'h');
    await stageOrSaveItems(packDashboardItems(items, cols), geometryOnly ? 'geometry' : 'content');
  }, [cols, stageOrSaveItems, workingLayoutItems]);

  const moveTileToPoint = useCallback(async (tileId: string, point: { clientX: number; clientY: number }) => {
    const grid = gridRef.current;
    const item = workingLayoutItems.find((candidate) => candidate.i === tileId);
    if (!grid || !item) return;
    const rect = grid.getBoundingClientRect();
    const gap = 12;
    const colWidth = (rect.width - gap * (cols - 1)) / cols;
    const stepX = colWidth + gap;
    const stepY = rowHeight + gap;
    const rawX = Math.round((point.clientX - rect.left) / stepX);
    const rawY = Math.round((point.clientY - rect.top) / stepY);
    const moved = {
      ...item,
      x: clamp(rawX, 0, Math.max(0, cols - item.w)),
      y: Math.max(0, rawY),
    };
    setDragPreview(null);
    const ordered = reorderTileForDrop(workingLayoutItems, moved, cols);
    await stageOrSaveItems(packDashboardItems(ordered, cols));
  }, [cols, rowHeight, stageOrSaveItems, workingLayoutItems]);

  const updateDragPreview = useCallback((tileId: string, point: { clientX: number; clientY: number }) => {
    const grid = gridRef.current;
    const item = workingLayoutItems.find((candidate) => candidate.i === tileId);
    if (!grid || !item) return;
    const rect = grid.getBoundingClientRect();
    const gap = 12;
    const colWidth = (rect.width - gap * (cols - 1)) / cols;
    const rawX = Math.round((point.clientX - rect.left) / (colWidth + gap));
    const rawY = Math.round((point.clientY - rect.top) / (rowHeight + gap));
    setDragPreview({
      tileId,
      x: clamp(rawX, 0, Math.max(0, cols - item.w)),
      y: Math.max(0, rawY),
      w: item.w,
      h: item.h,
    });
  }, [cols, rowHeight, workingLayoutItems]);

  const clearDragPreview = useCallback(() => setDragPreview(null), []);

  const autoLayout = useCallback(() => {
    if (workingLayoutItems.length === 0) return;
    setPendingLayoutItems(autoLayoutDashboardItems(workingLayoutItems, cols));
    setLayoutNotice('Layout preview ready');
  }, [cols, workingLayoutItems]);

  const applyPendingLayout = useCallback(async () => {
    if (!pendingLayoutItems) return;
    await saveItems(pendingLayoutItems, 'Layout applied');
  }, [pendingLayoutItems, saveItems]);

  const cancelPendingLayout = useCallback(() => {
    setPendingLayoutItems(null);
    setLayoutNotice('Layout preview cancelled');
  }, []);

  const retryTile = useCallback(async (tileId: string) => {
    setRetryingTileId(tileId);
    const retried = await runLatest(runVariables, effectiveCrossFilters, effectiveHierarchyDrills, { tileId });
    setRetryingTileId(null);
    if (!retried?.tiles.some((candidate) => candidate.tileId === tileId)) {
      setError('This App tile could not be retried.');
    }
  }, [effectiveCrossFilters, effectiveHierarchyDrills, runLatest, runVariables]);

  const applyDatasetMark = useCallback((item: DashboardLayoutItem, field: string, values: unknown[], exclude = false) => {
    const selection = buildDatasetCrossFilter(dashboard, item, field, values, { exclude });
    if (!selection.crossFilter) {
      setCrossFilterNotice(selection.error ?? 'This result mark cannot be applied.');
      return;
    }
    setCrossFilterNotice(`${exclude ? 'Leaving out' : 'Keeping only'} ${formatGenUiLabel(field)} ${values.map(String).join(', ')} on this page.`);
    // A hierarchy path is bound to its source query and effective filter
    // scope. Starting a new mark selection returns it to the authored base
    // query before the server validates the next request.
    setActiveHierarchyDrills([]);
    setActiveCrossFilters((current) => {
      const next = replaceDatasetCrossFilter(current, selection.crossFilter!);
      pendingAffectedTileIdsRef.current = datasetAffectedTileIds(dashboard, [
        ...current,
        selection.crossFilter!,
        ...next,
      ]);
      return next;
    });
  }, [dashboard]);

  const clearDatasetMarks = useCallback(() => {
    if (activeCrossFilters.length === 0) return;
    setCrossFilterNotice('Selected result marks cleared. Refreshing linked tiles…');
    setActiveHierarchyDrills([]);
    // With every selection cleared the whole page runs again, so its summary returns.
    setActiveCrossFilters(() => {
      pendingAffectedTileIdsRef.current = null;
      return [];
    });
  }, [activeCrossFilters.length, dashboard]);

  const removeDatasetMark = useCallback((fromTileId: string, field: string) => {
    setActiveHierarchyDrills([]);
    setActiveCrossFilters((current) => {
      const next = removeDatasetCrossFilter(current, fromTileId, field);
      pendingAffectedTileIdsRef.current = next.length ? datasetAffectedTileIds(dashboard, current) : null;
      return next;
    });
    setCrossFilterNotice(`${field} result mark cleared. Refreshing linked tiles…`);
  }, [dashboard]);

  const applyDatasetHierarchyDrill = useCallback((
    item: DashboardLayoutItem,
    candidate: DashboardHierarchyCandidate,
    row: Record<string, unknown>,
  ) => {
    const next = appendDatasetHierarchyDrill(activeHierarchyDrills, item.i, candidate, row);
    if (!next.drills) {
      setCrossFilterNotice(next.error ?? 'This result mark cannot be used for a declared hierarchy drill.');
      return;
    }
    // This is a read-only exploration request. `runLatest` sends the selected
    // tile as a bounded partial refresh, which prevents an interactive query
    // from becoming an App-wide story or publication receipt.
    // Every active drill must be scheduled with its own replay request. The
    // server rejects a drill for an unscheduled tile so a stale browser stack
    // cannot change an unrelated result.
    pendingAffectedTileIdsRef.current = next.drills.map((drill) => drill.tileId);
    setCrossFilterNotice(`Drilling from ${formatGenUiLabel(candidate.fromField)} to ${formatGenUiLabel(candidate.toField)}…`);
    setActiveHierarchyDrills(next.drills);
  }, [activeHierarchyDrills]);

  const returnFromDatasetHierarchyDrill = useCallback((tileId: string) => {
    const existing = activeHierarchyDrills.find((drill) => drill.tileId === tileId);
    if (!existing) return;
    const next = popDatasetHierarchyDrill(activeHierarchyDrills, tileId);
    pendingAffectedTileIdsRef.current = [...new Set([tileId, ...next.map((drill) => drill.tileId)])];
    setCrossFilterNotice('Returning to the previous declared grouping…');
    setActiveHierarchyDrills(next);
  }, [activeHierarchyDrills]);

  const navigateFromDatasetTile = useCallback(async (tileId: string) => {
    const navigation = dashboard.interactions?.navigate?.find((candidate) => candidate.fromTile === tileId);
    if (!navigation || !onNavigateDashboard) {
      setCrossFilterNotice('No detail-page navigation is configured for this tile. Open its interaction settings to add one.');
      return;
    }
    const tileItem = dashboard.layout.items.find((candidate) => candidate.i === tileId);
    const outcome = await onNavigateDashboard({
      fromDashboardId: dashboard.id,
      toDashboardId: navigation.toPage,
      carryFilterIds: navigation.carryFilters,
      variables: tileItem
        ? carriedNavigationVariables({ page: dashboard, tile: tileItem, carryFilterIds: navigation.carryFilters, variables: runVariables, crossFilters: effectiveCrossFilters })
        : runVariables,
    });
    if (outcome && !outcome.ok) setCrossFilterNotice(outcome.error ?? 'The configured detail page could not be opened.');
  }, [dashboard, effectiveCrossFilters, onNavigateDashboard, runVariables]);

  // ─── The click menu and Explore panel (RFC 0009 step 6a) ────────────────
  const { openMarkMenu, overlays: markOverlays } = useMarkInteractions({
    themeMode: state.themeMode,
    runProbe: (options) => api.runDashboard(appId, dashboard.id, runVariables, effectiveCrossFilters.length ? effectiveCrossFilters : undefined, { ...options, ...viewerFilterOption() }),
    drillsFor: (tileId) => effectiveHierarchyDrills.find((drill) => drill.tileId === tileId)?.steps,
    keepOrExclude: (item, field, value, exclude) => applyDatasetMark(item, field, [value], exclude),
    drillDown: (item, candidate, row) => applyDatasetHierarchyDrill(item, candidate, row),
    hasDetailsPage: (tileId) => Boolean(dashboard.interactions?.navigate?.some((candidate) => candidate.fromTile === tileId)),
    openDetailsPage: (tileId) => void navigateFromDatasetTile(tileId),
    ...(onAskChart && run?.runId ? { ask: (item: DashboardLayoutItem, question: string) => onAskChart({ tileId: item.i, runId: run.runId, question }) } : {}),
    ...(dashboard.interactions?.detail?.columns?.length ? { authoredColumns: dashboard.interactions.detail.columns } : {}),
    label: formatGenUiLabel,
  });

  const openTileInNotebook = useCallback(async (item: DashboardLayoutItem, tile: DashboardRunTile) => {
    if (!canOpenTileInNotebook(tile)) return;
    const artifact = tile.artifact;
    const payload: InsertDqlPayload = {
      title: item.title ?? artifact?.name ?? tile.title ?? 'App analysis',
      sql: artifact?.sql,
      result: tile.result,
      chartConfig: mergeDashboardTileChartConfig(item, tile.chartConfig as CellChartConfig | undefined),
      sourceRunId: run?.runId,
      question: `App tile: ${item.title ?? tile.title ?? item.i}`,
      executionTarget: artifact?.executionTarget,
      ...(artifact?.dql ? {
        dqlArtifact: {
          kind: artifact.sourceKind === 'certified_block' ? 'certified_block' : 'sql_block',
          source: artifact.dql,
          name: artifact.name,
          sourcePath: artifact.sourcePath,
          persistence: artifact.sourcePath ? 'saved' : 'transient',
          trustState: artifact.trustState,
          compiledSql: artifact.sql,
        },
      } : {}),
    };
    await openAnswerInNotebook(payload);
  }, [openAnswerInNotebook, run?.runId]);

  const loadLineage = useCallback(async () => {
    setLineageOpen((value) => !value);
    if (!lineage) {
      const result = await api.fetchScopedLineage({
        domain: dashboard.metadata.domain,
        appId,
        dashboardId: dashboard.id,
      });
      setLineage(result);
    }
  }, [appId, dashboard.id, dashboard.metadata.domain, lineage]);

  const openLineage = useCallback(() => {
    if (onOpenLineageNode) {
      onOpenLineageNode(`dashboard:${appId}/${dashboard.id}`);
      return;
    }
    void loadLineage();
  }, [appId, dashboard.id, loadLineage, onOpenLineageNode]);

  const effectiveCopilotOpen = onCopilotChange ? Boolean(copilotOpen) : chatOpen;
  const openCopilot = useCallback(() => {
    setAddMenuOpen(false);
    if (onCopilotChange) {
      onCopilotChange(true);
      return;
    }
    setChatOpen(true);
  }, [onCopilotChange]);
  const toggleCopilot = useCallback(() => {
    setAddMenuOpen(false);
    if (onCopilotChange) {
      onCopilotChange(!copilotOpen);
      return;
    }
    setChatOpen((value) => !value);
  }, [copilotOpen, onCopilotChange]);

  return (
    <div ref={containerRef} data-dashboard-breakpoint={breakpoint} style={{ display: 'block', minHeight: 0, containerType: 'inline-size' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
      {/* Saving is automatic, so it has to be legible. This sits outside the
          editing toolbar: a write can land while the App is being viewed (an
          Ask result added from elsewhere), and a failed save used to be
          invisible because the error only rendered inside empty tiles. */}
      <SaveStatus saving={saving} error={error} pending={Boolean(pendingLayoutItems)} notice={layoutNotice} onDismissError={() => setError(null)} />
      {/* The stakeholder view deliberately hides review-required and duplicate
          tiles, which is right for published viewing — but it used to be
          announced only when EVERY tile was hidden. Adding an AI result to a
          page that already had tiles therefore looked like nothing had been
          saved. Say so whenever anything is hidden. */}
      {!editable && visibleItems.length > 0 && (hiddenReviewTileCount + hiddenPresentationTileCount) > 0 ? (
        <div role="status" style={saveStatusStyle('var(--text-tertiary)')}>
          <ShieldCheck size={13} />
          {hiddenReviewTileCount + hiddenPresentationTileCount} tile
          {hiddenReviewTileCount + hiddenPresentationTileCount === 1 ? ' is' : 's are'} hidden from this
          stakeholder view because {hiddenReviewTileCount > 0 ? 'they still need review' : 'a certified tile already answers the same question'}. Switch to Edit to see everything on this page.
        </div>
      ) : null}
      {(!embeddedHeader || editable) && (
      <div style={dashboardToolbarStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
        {embeddedHeader ? null : (
          <>
            <h2 style={{ margin: 0, fontSize: 20, lineHeight: 1.18, fontWeight: 600 }}>{dashboard.metadata.title}</h2>
            {dashboard.metadata.description ? (
              <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4, maxWidth: 680, lineHeight: 1.4 }}>
                {dashboard.metadata.description}
              </div>
            ) : null}
          </>
        )}
        </div>
        {editable && dashboard.layout.items.length > 0 && (
          <AddTileMenu
            open={addMenuOpen}
            onToggle={() => setAddMenuOpen((value) => !value)}
            buttonStyle={addTileIconButtonStyle}
            onCertifiedBlock={() => {
              setAddMenuOpen(false);
              void openCatalog();
            }}
            onText={() => {
              setAddMenuOpen(false);
              void addTextTile();
            }}
            onHeading={() => {
              setAddMenuOpen(false);
              void addHeadingTile();
            }}
            onAi={openCopilot}
          />
        )}
        {editable && dashboard.layout.items.length > 1 && !pendingLayoutItems && (
          <button
            type="button"
            onClick={autoLayout}
            disabled={saving}
            style={toolbarButtonStyle(false)}
            title="Auto-arrange every tile into a clean, gap-free grid"
          >
            <Wand2 size={15} strokeWidth={2} />
            Auto layout
          </button>
        )}
        {editable && pendingLayoutItems ? (
          <>
            <button
              type="button"
              onClick={() => void applyPendingLayout()}
              disabled={saving}
              style={toolbarButtonStyle(true)}
            >
              {saving ? 'Applying…' : 'Apply layout'}
            </button>
            <button type="button" onClick={cancelPendingLayout} disabled={saving} style={toolbarButtonStyle(false)}>
              Cancel
            </button>
          </>
        ) : null}
        {!embeddedHeader && (
          <>
            <button
              type="button"
              onClick={toggleCopilot}
              style={toolbarButtonStyle(effectiveCopilotOpen)}
            >
              <Bot size={14} strokeWidth={2} />
              {effectiveCopilotOpen ? 'Hide copilot' : 'AI Copilot'}
            </button>
            <button type="button" onClick={openLineage} style={toolbarButtonStyle(false)} title="Open focused dashboard lineage">
              <GitBranch size={14} strokeWidth={2} />
              Lineage
            </button>
          </>
        )}
      </div>
      )}
      {editable && <div style={dashboardEditHintStyle}>{editableCanvas ? 'Drag tiles, select a saved query for Copilot context, or use the tile controls for sizing and chart settings.' : `${breakpoint === 'medium' ? 'Tablet' : 'Mobile'} preview uses the saved responsive projection. Return to a wide canvas to rearrange tiles.`}</div>}

      {activeCrossFilters.length > 0 ? (
        <div
          aria-label="Selected result marks"
          style={{ margin: '8px 0', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12 }}
        >
          <span style={{ color: 'var(--text-secondary)' }}>Selected marks</span>
          {activeCrossFilters.map((filter) => (
            <button
              key={`${filter.fromTileId}:${filter.fromSourceId}:${filter.fromSourceRevision}:${filter.field}`}
              type="button"
              onClick={() => removeDatasetMark(filter.fromTileId, filter.field)}
              title="Remove this result-mark filter"
              style={{ ...generatedMetaPillStyle, cursor: 'pointer' }}
            >
              <Filter size={10} /> {formatGenUiLabel(filter.field)}: {filter.exclude ? 'not ' : ''}{filter.values.map((value) => formatDashboardFilterValue(value) ?? '(blank)').join(', ')} <X size={10} />
            </button>
          ))}
          <button type="button" onClick={clearDatasetMarks} style={toolbarButtonStyle(false)}>Reset marks</button>
        </div>
      ) : null}
      {crossFilterNotice ? (
        <div role="status" style={{ ...saveStatusStyle('var(--text-secondary)'), marginBottom: 8 }}>
          <Filter size={13} /> {crossFilterNotice}
        </div>
      ) : null}
      {run?.partial && (editable || partialFromInteraction) ? (
        <div role="status" style={{ ...saveStatusStyle('var(--text-secondary)'), marginBottom: 8 }}>
          <Activity size={13} /> {editable
            ? 'Refreshed a bounded set of components. Run the full dashboard before using a combined story or publication evidence.'
            : 'Updated the tiles linked to your selection. The page summary returns when you reset the selection.'}
        </div>
      ) : null}
      {!editable ? (
        <TrustLensBar
          counts={trustCounts}
          summary={pageTrust?.text}
          on={trustLens}
          onToggle={() => setTrustLens((current) => !current)}
          actions={(
            <>
              {/* A read-only link can export what it sees, but not share on or set alerts. */}
              {readOnlyLink ? null : <ShareLinkMenu appId={appId} pageId={dashboard.id} />}
              {readOnlyLink ? null : <PageAlertsMenu appId={appId} dashboardId={dashboard.id} runId={run && !run.partial && !run.incomplete ? run.runId : null} catalog={runCatalog} />}
              <SnapshotExportMenu disabledReason={snapshotBlockedReason} onExport={exportSnapshot} />
            </>
          )}
        />
      ) : null}
      {markOverlays}
      {driverPanel ? (
        <DriverPanel
          title={driverPanel.state.status === 'ready' ? driverPanel.state.analysis.measure.label.toLowerCase() : driverPanel.definition.measure.replace(/_/g, ' ')}
          definition={driverPanel.definition}
          state={driverPanel.state}
          onComparison={(comparison) => void runDriverProbe(driverPanel.item, { ...driverPanel.definition, comparison })}
          onClose={() => { driverRequestRef.current += 1; setDriverPanel(null); }}
          footer={driverPanel.state.status === 'ready' ? (() => {
            const trust = readerTileTrust(driverPanel.item, driverPanel.state.tile);
            return trust ? <span className={`dql-trust-badge ${trust.state}`} style={{ justifySelf: 'start', cursor: 'default' }}>{trust.label} · {trust.detail}</span> : null;
          })() : null}
        />
      ) : null}
      {run?.incomplete ? (
        <div role="status" style={{ ...saveStatusStyle('var(--text-secondary)'), marginBottom: 8 }}>
          <AlertTriangle size={13} /> {run.incomplete.message}
        </div>
      ) : null}

      {storyNarrative || canvasPage || !summaryAdded ? null : !editable && businessStory ? (
        <BusinessStoryPanel story={businessStory} onResearch={openCopilot} onEvidence={openLineage} />
      ) : dashboardStory ? <DashboardStoryStrip story={dashboardStory} /> : null}

      {visibleItems.length === 0 ? (
        <div
          style={{
            border: '1px dashed var(--border-color, rgba(0,0,0,0.15))',
            borderRadius: 8,
            padding: 36,
            textAlign: 'center',
            fontSize: 13,
            minHeight: 260,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
            {hiddenReviewTileCount > 0 || hiddenPresentationTileCount > 0 ? 'No stakeholder-ready tiles yet' : 'Build this dashboard page'}
          </div>
          <div style={{ maxWidth: 520, opacity: 0.68, lineHeight: 1.45 }}>
            {hiddenReviewTileCount > 0
              ? 'Generated analysis and trust placeholders are hidden from the stakeholder view. Open Customize or Analysis to review them, then add certified saved queries or pinned insights.'
              : hiddenPresentationTileCount > 0
                ? 'Static duplicate tiles are hidden from the stakeholder view because a filter-aware certified tile can answer the same question.'
              : 'Add certified saved queries from this domain, narrative text, or use the scoped AI drawer and pin an answer into this layout.'}
          </div>
          <div style={{ marginTop: 18, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <AddTileMenu
              open={addMenuOpen}
              onToggle={() => setAddMenuOpen((value) => !value)}
              buttonLabel="Add tile"
              buttonStyle={primaryBuilderButtonStyle}
              onCertifiedBlock={() => {
                setAddMenuOpen(false);
                void openCatalog();
              }}
              onText={() => {
                setAddMenuOpen(false);
                void addTextTile();
              }}
              onHeading={() => {
                setAddMenuOpen(false);
                void addHeadingTile();
              }}
              onAi={openCopilot}
            />
          </div>
        </div>
      ) : canvasPage ? (
        <CanvasPageFrame
          canvas={canvasPage}
          catalog={storyCatalog}
          items={dashboard.layout.items}
          tiles={run?.tiles ?? []}
          themeMode={state.themeMode}
          loading={loading}
          trust={pageTrust?.text ? pageTrust.text.charAt(0).toLowerCase() + pageTrust.text.slice(1) : null}
          onMark={(item, tile, row, pointer) => openMarkMenu(item, tile, row, pointer, [])}
          receiptFor={numberReceiptFor}
        />
      ) : storyNarrative ? (
        <StoryView
          narrative={storyNarrative}
          catalog={storyCatalog}
          receiptFor={numberReceiptFor}
          edition={run && !run.partial && storyEditions ? storyEditionSummary(storyEditions, run, storyCatalog) : null}
          trust={pageTrust?.text ? pageTrust.text.charAt(0).toLowerCase() + pageTrust.text.slice(1) : null}
          renderTile={(tileId) => {
            const item = visibleItems.find((candidate) => candidate.i === tileId);
            if (!item) return null;
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: `${rowHeight}px`, gap: 12 }}>
                {renderGridTile({ ...item, x: 0, y: 0, w: 12 })}
              </div>
            );
          }}
        />
      ) : storySections ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {storySections.map((section) => {
            const appendixSectionId = storySections.find((entry) => entry.kind === 'appendix')?.id;
            const insightFallbackId = storySections.find((entry) => entry.kind === 'insight')?.id ?? storySections[0].id;
            const resolveSection = (item: typeof dashboard.layout.items[number]) => {
              if (item.sectionId && storySections.some((entry) => entry.id === item.sectionId)) return item.sectionId;
              // An untagged review-required tile must never land in the exec/insight
              // sections — route it to the review appendix (or fall back to insight).
              if ((item.trustState === 'review_required' || item.reviewStatus === 'review_required') && appendixSectionId) {
                return appendixSectionId;
              }
              return insightFallbackId;
            };
            const sectionItems = (storyItems ?? visibleItems).filter((item) => resolveSection(item) === section.id);
            if (sectionItems.length === 0) return null;
            // Re-anchor this section's rows at 0 so each section is its own grid.
            const minY = Math.min(...sectionItems.map((item) => item.y));
            const isAppendix = section.kind === 'appendix';
            return (
              <section key={section.id} aria-label={section.title}>
                {section.kind !== 'exec_summary' ? (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dql-app-text, #0f172a)' }}>{section.title}</h3>
                      {isAppendix ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid rgba(217,119,6,0.4)', color: '#b45309', background: 'rgba(217,119,6,0.08)', borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
                          needs review
                        </span>
                      ) : null}
                    </div>
                    {section.narrative ? (
                      <p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--dql-app-text-muted, #64748b)', maxWidth: 860 }}>{section.narrative}</p>
                    ) : null}
                  </div>
                ) : null}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: narrowGrid ? 'minmax(0, 1fr)' : `repeat(${cols}, 1fr)`,
                    gridAutoRows: narrowGrid ? 'auto' : `${rowHeight}px`,
                    gap: 12,
                    ...(isAppendix ? { opacity: 0.96 } : {}),
                  }}
                >
                  {sectionItems.map((item) => (
                    <DashboardTile
                      key={item.i}
                      item={{ ...item, y: item.y - minY }}
                      tile={tileResults.get(item.i)}
                      loading={loading}
                      error={error}
                      themeMode={state.themeMode}
                      editable={false}
                      narrow={narrowGrid}
                      cols={cols}
                      selected={Boolean(getDashboardItemBlockId(item) && getDashboardItemBlockId(item) === selectedBlockId)}
                      onFocusBlock={onBlockFocus}
                      onAskBlock={onAskBlock}
                      onAskChart={onAskChart}
                      runId={run?.runId}
                      reader={readerContext}
                      onExplainChange={editable ? undefined : explainChange}
                      onMove={() => undefined}
                      onDragMove={() => undefined}
                      onDragEnd={() => undefined}
                      onPatch={(patch) => void patchTile(item.i, patch)}
                      onRetry={() => void retryTile(item.i)}
                      retrying={retryingTileId === item.i}
                      retryDisabled={Boolean(retryingTileId && retryingTileId !== item.i)}
                      onOpenNotebook={(nextTile) => void openTileInNotebook(item, nextTile)}
                      activeVariables={runVariables}
                      viewerFilterIds={viewerFilterIds}
                      filterLabels={dashboardFilterLabels(dashboard)}
                      onExport={tileExport?.(item.i)}
                      crossFilterFields={datasetCrossFilterFields(dashboard, item)}
                      onSelectDatasetMark={(field, values) => applyDatasetMark(item, field, values)}
                      onDrillDatasetMark={(candidate, row) => applyDatasetHierarchyDrill(item, candidate, row)}
                      onDrillBack={() => returnFromDatasetHierarchyDrill(item.i)}
                      onMark={(row, at, candidates) => openMarkMenu(item, tileResults.get(item.i), row, at, candidates)}
                      onNavigate={dashboard.interactions?.navigate?.some((candidate) => candidate.fromTile === item.i)
                        ? () => void navigateFromDatasetTile(item.i)
                        : undefined}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div
          ref={gridRef}
          style={{
            display: 'grid',
            gridTemplateColumns: narrowGrid ? 'minmax(0, 1fr)' : `repeat(${cols}, 1fr)`,
            gridAutoRows: narrowGrid ? 'auto' : `${rowHeight}px`,
            gap: 12,
          }}
        >
          {dragPreview && !narrowGrid && (
            <div
              aria-hidden="true"
              style={{
                gridColumn: `${dragPreview.x + 1} / span ${dragPreview.w}`,
                gridRow: `${dragPreview.y + 1} / span ${dragPreview.h}`,
                border: '2px dashed var(--dql-app-accent, var(--accent, #4f46e5))',
                background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.10))',
                borderRadius: 10,
                pointerEvents: 'none',
                zIndex: 10,
              }}
            />
          )}
          {visibleItems.map((item) => renderGridTile(item))}
        </div>
      )}
      {!editable && run ? <ReviewAppendix run={run} variables={runVariables} filters={dashboard.filters} ranAtMs={Object.values(tileRanAt).reduce<number | undefined>((latest, at) => (latest === undefined || at > latest ? at : latest), undefined)} /> : null}
      </div>

      {lineageOpen && !onOpenLineageNode && (
        <aside style={{ width: 340, minWidth: 300, maxWidth: '34vw', border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 8, overflow: 'auto', alignSelf: 'flex-start', height: SIDE_PANEL_HEIGHT, position: 'sticky', top: 12, padding: 12 }}>
          <ScopedLineagePanel lineage={lineage} />
        </aside>
      )}

      {chatOpen && !onCopilotChange && (
        <AiSidePanel
          t={t}
          title="Dashboard AI"
          subtitle="Scoped to this App dashboard first"
          expanded={chatExpanded}
          onToggleExpanded={() => setChatExpanded((value) => !value)}
          onClose={() => { setChatOpen(false); setChatExpanded(false); }}
          floating
          ariaLabel="Dashboard AI"
          style={dashboardChatDrawerStyle(chatExpanded)}
        >
          <Suspense fallback={<div style={{ padding: 16, fontSize: 12, color: t.textSecondary }}>Loading Dashboard AI…</div>}>
            <UnifiedAgentRunPanel
              key={`${appId}:${dashboard.id}`}
              themeMode={state.themeMode}
              title="Dashboard AI"
              scopeHint="Scoped to this App dashboard first"
              audience="stakeholder"
              workspaceContext={{ surface: 'apps', appId, dashboardId: dashboard.id, dashboardTitle: dashboard.metadata.title, dashboardFilters: runVariables, dashboardContext: chatContext, ...(run && !run.partial ? { dashboardRunId: run.runId } : {}) }}
              initialMode="auto"
              threadId={agentThread.threadId}
              onThreadIdChange={agentThread.onThreadIdChange}
            />
          </Suspense>
        </AiSidePanel>
      )}

      {catalogOpen && (
        <BlockCatalogDialog
          blocks={catalog}
          search={catalogSearch}
          onSearch={setCatalogSearch}
          onClose={() => setCatalogOpen(false)}
          onAdd={(block) => void addBlockTile(block)}
        />
      )}
      {textDialogKind && (
        <TextTileDialog
          kind={textDialogKind}
          value={textDialogValue}
          onChange={setTextDialogValue}
          onClose={() => {
            setTextDialogKind(null);
            setTextDialogValue('');
          }}
          onSave={() => void saveTextTile()}
        />
      )}
    </div>
  );
}

/**
 * The "Not filtered by …" pill for one tile.
 *
 * Once a run exists, every tile type uses the server's own word: Dataset
 * tiles their `dataset.unboundFilters`, every other tile its `filterReport`
 * (which page filters actually applied and which did not, with why). Before a
 * run, the page document's choices stand in. Text and heading tiles never show
 * filter pills.
 */
export function dashboardTileFilterNotices(input: {
  item: DashboardLayoutItem;
  tile?: DashboardRunTile;
  activeVariables?: Record<string, unknown>;
  /** The viewer's own session filters; whether they reached a tile is the server's word, not the document's. */
  viewerFilterIds?: string[];
  /** Page filter labels by id; a pill names the filter the reader sees. */
  filterLabels?: Record<string, string>;
}) {
  const label = (filterId: string) => input.filterLabels?.[filterId] ?? filterId;
  if (isDashboardNarrativeTile(input.item)) return { unfilteredNotice: null, datasetUnboundNotices: [] };
  const datasetUnboundNotices = input.tile?.dataset?.unboundFilters ?? [];
  // A viewer filter is never in the page document, so only the server's
  // applied list says whether it narrowed this tile — for every tile kind.
  const viewerIds = new Set(input.viewerFilterIds ?? []);
  const serverApplied = new Set((input.tile?.filters?.applied ?? []).map((entry) => entry.filter));
  const viewerIgnored = input.tile?.status === 'ok' && input.tile.tileType !== 'text'
    ? [...viewerIds].filter((filterId) => !serverApplied.has(filterId))
    : [];
  // Driver tiles run Dataset comparisons with the same page filters.
  if (input.item.query || input.item.driver) {
    return { unfilteredNotice: tileUnfilteredNotice(viewerIgnored), datasetUnboundNotices };
  }
  const report = input.tile?.filterReport;
  if (report) {
    const declared = report.notApplied.filter((entry) => !viewerIds.has(entry.filter));
    return {
      unfilteredNotice: tileUnfilteredNotice(
        [...declared.map((entry) => label(entry.filter)), ...viewerIgnored],
        declared.length ? declared.map((entry) => `${label(entry.filter)}: ${plainSourceText(entry.reason)}`).join(' ') : undefined,
      ),
      datasetUnboundNotices,
    };
  }
  const active = Object.entries(input.activeVariables ?? {})
    .filter(([key, value]) => !viewerIds.has(key) && value !== undefined && value !== null && value !== '')
    .map(([key]) => key);
  if (active.length === 0) return { unfilteredNotice: tileUnfilteredNotice(viewerIgnored), datasetUnboundNotices };
  const declaredIgnored = active
    .filter((filterId) => dashboardTileFilterChoice({}, input.item, { id: filterId }).choice !== 'applies')
    .map(label);
  return { unfilteredNotice: tileUnfilteredNotice([...declaredIgnored, ...viewerIgnored]), datasetUnboundNotices };
}

function dashboardFilterLabels(dashboard: { filters?: Array<{ id: string; label?: string }> } | null | undefined): Record<string, string> {
  return Object.fromEntries((dashboard?.filters ?? []).flatMap((filter) => filter.label ? [[filter.id, filter.label]] : []));
}

function tileUnfilteredNotice(ignored: string[], detail?: string): { label: string; detail: string } | null {
  if (ignored.length === 0) return null;
  return {
    label: ignored.length === 1 ? `Not filtered by ${ignored[0]}` : `Not filtered by ${ignored.length} page filters`,
    detail: detail ?? `This tile has no column bound to ${ignored.join(', ')}, so it shows the full scope while the rest of the page is narrowed.`,
  };
}

/** What a reader tile needs to show its trust label, freshness and receipt. */
interface ReaderTileContext {
  ranAtByTile: Record<string, number>;
  nowMs: number;
  run: { runId: string; snapshotId: string; filterFingerprint: string } | null;
  trustLens: boolean;
}

function DashboardTile({
  item,
  tile,
  loading,
  error,
  themeMode,
  editable,
  narrow,
  cols,
  selected,
  onFocusBlock,
  onAskBlock,
  onAskChart,
  runId,
  onMove,
  onDragMove,
  onDragEnd,
  onPatch,
  onRetry,
  retrying = false,
  retryDisabled = false,
  onOpenNotebook,
  activeVariables,
  viewerFilterIds,
  filterLabels,
  crossFilterFields = [],
  onSelectDatasetMark,
  onDrillDatasetMark,
  onDrillBack,
  onMark,
  onNavigate,
  reader,
  onExplainChange,
  onExport,
}: {
  /** With a host: download this tile as a file made on the server (HH-17). */
  onExport?: (format: ExportFormat) => Promise<string>;
  /** Reader: "Why did it move?" for a trend tile, with its driver definition. */
  onExplainChange?: (item: DashboardDocumentResponse['dashboard']['layout']['items'][number], tile: DashboardRunResponse['tiles'][number]) => void;
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  /** Reader-only trust context: freshness clock, run identity, Trust Lens. */
  reader?: ReaderTileContext;
  loading: boolean;
  error: string | null;
  themeMode: ThemeMode;
  editable: boolean;
  narrow: boolean;
  cols: number;
  selected?: boolean;
  onFocusBlock?: (blockId: string) => void;
  onAskBlock?: (blockId: string, question: string) => void;
  onAskChart?: (input: { tileId: string; runId: string; question: string }) => void;
  runId?: string;
  onMove: (point: { clientX: number; clientY: number }) => void;
  onDragMove?: (point: { clientX: number; clientY: number }) => void;
  onDragEnd?: () => void;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  onOpenNotebook?: (tile: DashboardRunTile) => void;
  /** Page filter values in force, so a tile can say when it ignores one. */
  activeVariables?: Record<string, unknown>;
  /** Which of `activeVariables` are the viewer's own session filters. */
  viewerFilterIds?: string[];
  /** Page filter labels, so a pill says "Not filtered by Customer Name". */
  filterLabels?: Record<string, string>;
  /** Server-owned, explicitly authored Dataset mapping origins for this tile. */
  crossFilterFields?: string[];
  onSelectDatasetMark?: (field: string, values: unknown[]) => void;
  onDrillDatasetMark?: (candidate: DashboardHierarchyCandidate, row: Record<string, unknown>) => void;
  onDrillBack?: () => void;
  onMark?: (row: Record<string, unknown>, at: MarkPointer | undefined, hierarchyCandidates: DashboardHierarchyCandidate[]) => void;
  onNavigate?: () => void;
}): JSX.Element {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const hosted = useHostUi().host;
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'how' | 'dql' | 'sql'>('how');
  const [receiptOpen, setReceiptOpen] = useState(false);
  const blockId = getDashboardItemBlockId(item);
  const readerTrust = !editable && reader && !loading ? readerTileTrust(item, tile) : null;
  const readerFreshness = readerTrust && reader ? readerTileFreshness(tile, reader.ranAtByTile[item.i], reader.nowMs) : null;
  const readerReceipt = readerTrust && reader ? readerTileReceipt(item, tile, reader.run, reader.ranAtByTile[item.i]) : [];
  const readerDescription = !editable && item.description ? plainDescription(item.description) : '';
  const canAskChart = canAskDatasetChart(tile, editable, runId, Boolean(onAskChart));
  const canAsk = canAskChart || Boolean(!editable && blockId && onAskBlock);
  const blockRef = blockId
    ? `block:${blockId}`
    : item.query
      ? `dataset:${tile?.citation?.name ?? item.sourceId ?? 'field query'}`
    : item.semantic
      ? `semantic:${item.semantic.id}`
    : item.draftAnalysis
      ? `draft:${item.draftAnalysis.ref}`
    : item.aiPin
      ? `aiPin:${item.aiPin.id}`
      : 'text';
  const [viewerViz, setViewerViz] = useState<ChartType>(() => normalizeChartType(item.viz.type));
  useEffect(() => setViewerViz(normalizeChartType(item.viz.type)), [item.i, item.viz.type]);
  const activeChart = editable ? normalizeChartType(item.viz.type) : viewerViz;
  const renderedItem = useMemo<DashboardLayoutItem>(() => editable || activeChart === normalizeChartType(item.viz.type)
    ? item
    : {
        ...item,
        viz: {
          ...item.viz,
          type: chartToDashboardViz(activeChart),
          options: { ...(item.viz.options ?? {}), chart: activeChart },
        },
      }, [activeChart, editable, item]);
  const vizType = normalizeViz(String(renderedItem.viz.type ?? 'table'));
  const genUi = getDqlGenUi(item);
  const generatedComponent = genUi?.component;
  const generatedTitle = item.title || genUi?.insightTitle || blockRef;
  const aiPinTrust = tile?.tileType === 'aiPin'
    ? tile.aiPin?.certification === 'certified' ? 'certified' : 'review_required'
    : undefined;
  const repair = tile?.repair;
  const generatedTrust = repair
    ? 'review_required'
    : tile?.artifact?.trustState ?? genUi?.trustState ?? aiPinTrust ?? (tile?.certificationStatus === 'certified' ? 'certified' : undefined);
  const isGeneratedUi = Boolean(genUi);
  const isCompactMetric = item.h <= 2 && (vizType === 'single_value' || vizType === 'kpi' || vizType === 'gauge');
  const [hovered, setHovered] = useState(false);
  const showEditChrome = editable && (hovered || selected || settingsOpen);

  useEffect(() => {
    if (!editable) return;
    const closeAnotherInspector = (event: Event) => {
      const openedTileId = (event as CustomEvent<string>).detail;
      if (openedTileId !== item.i) setSettingsOpen(false);
    };
    window.addEventListener('dql-app-tile-settings-open', closeAnotherInspector);
    return () => window.removeEventListener('dql-app-tile-settings-open', closeAnotherInspector);
  }, [editable, item.i]);

  const toggleTileSettings = () => {
    setSettingsOpen((value) => {
      const next = !value;
      if (next) window.dispatchEvent(new CustomEvent('dql-app-tile-settings-open', { detail: item.i }));
      return next;
    });
  };

  /**
   * Say so when a page filter is set but this tile ignores it.
   *
   * Without this the tile shows every row while the filter bar claims a
   * narrower scope, and the two are indistinguishable on screen — the reader
   * compares a filtered tile against an unfiltered one and never knows.
   */
  const { unfilteredNotice, datasetUnboundNotices } = dashboardTileFilterNotices({ item, tile, activeVariables, viewerFilterIds, filterLabels });
  const comparisonSummary = item.query ? datasetComparisonSummary(item.query.comparison) : undefined;

  /**
   * Rename the tile from its own header.
   *
   * The only rename used to live inside the "Chart and field settings" panel,
   * behind a hover-revealed slider icon — three hidden steps, under a label
   * about charts. Renaming is the most common edit, so it belongs on the title
   * itself. `insightTitle` is a shadow copy frozen at build time; leaving it
   * stale lets a renamed tile still render its original name elsewhere.
   */
  const renameTile = (next: string) => {
    const title = next.trim();
    if (!title || title === item.title) return;
    const currentGenUi = getDqlGenUi(item);
    onPatch({
      title,
      ...(currentGenUi
        ? { viz: { ...item.viz, options: { ...(item.viz.options ?? {}), dqlGenUi: { ...currentGenUi, insightTitle: title } } } }
        : {}),
    });
  };
  const generatedVizOptions = getGeneratedVizOptions(item, genUi);
  // Editing already has one durable visualization control in the tile
  // inspector. A second row of chart icons in the tile header made the manual
  // path look like two competing editors.
  // Readers switch between the allowed views from the tile's ⋯ menu.
  const viewerVizChoices = !editable && tile?.result && generatedVizOptions.length > 1 ? generatedVizOptions : [];
  const canInspect = Boolean(tile && tile.tileType !== 'text' && (tile.artifact || tile.result || tile.citation || tile.repair));
  const kpiOpensReceipt = Boolean(readerTrust && tile?.status === 'ok' && activeChart === 'kpi');
  // Readers reach Ask, evidence, notebook, and CSV from one ⋯ menu per tile.
  const showAskHint = Boolean(editable && canAsk && (hovered || selected));
  const [tileMenuOpen, setTileMenuOpen] = useState(false);
  const askAboutTile = () => {
    if (canAskChart && runId) {
      onAskChart?.({ tileId: item.i, runId, question: 'What does this chart show?' });
      return;
    }
    if (blockId) onFocusBlock?.(blockId);
    if (blockId) onAskBlock?.(blockId, defaultTileCopilotQuestion(item.title ?? blockId));
  };
  const openEvidence = (tab: 'how' | 'dql' | 'sql') => {
    setInspectorTab(tab);
    setInspectorOpen(true);
    setTileMenuOpen(false);
  };
  const tileResult = tile?.status === 'ok' ? tile.result : undefined;
  const canOpenNotebook = Boolean(onOpenNotebook && tile && tile.artifact?.sourceKind !== 'dataset_query');
  const switchGeneratedViz = (chart: ChartType) => {
    if (!editable) {
      setViewerViz(chart);
      return;
    }
    const dashboardViz = chartToDashboardViz(chart);
    const options = item.viz.options ?? {};
    const currentGenUi = getDqlGenUi(item);
    onPatch({
      viz: {
        ...item.viz,
        type: dashboardViz,
        options: {
          ...options,
          chart,
          ...(currentGenUi ? { dqlGenUi: { ...currentGenUi, defaultVisualization: dashboardViz } } : {}),
        },
      },
      display: displayWithVisualization(item, dashboardViz, currentGenUi),
    });
  };
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (narrow) return;
    const tileEl = tileRef.current;
    if (!tileEl) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = tileEl.getBoundingClientRect();
    const grabOffset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const start = {
      x: event.clientX,
      y: event.clientY,
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      setDragOffset({
        x: moveEvent.clientX - start.x,
        y: moveEvent.clientY - start.y,
      });
      onDragMove?.({
        clientX: moveEvent.clientX - grabOffset.x,
        clientY: moveEvent.clientY - grabOffset.y,
      });
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setDragOffset(null);
      onDragEnd?.();
      onMove({
        clientX: upEvent.clientX - grabOffset.x,
        clientY: upEvent.clientY - grabOffset.y,
      });
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  };
  return (
    <div
      ref={tileRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (blockId) onFocusBlock?.(blockId);
      }}
      style={{
        gridColumn: narrow ? '1 / -1' : `${item.x + 1} / span ${item.w}`,
        gridRow: narrow ? 'auto' : `${item.y + 1} / span ${item.h}`,
        transform: dragOffset ? `translate(${dragOffset.x}px, ${dragOffset.y}px) scale(1.02)` : undefined,
        opacity: dragOffset ? 0.92 : 1,
        zIndex: dragOffset ? 30 : undefined,
        position: 'relative',
        background: isGeneratedUi
          ? tileSurfaceForGenUi(generatedComponent)
          : 'var(--dql-app-surface, var(--surface, rgba(0,0,0,0.02)))',
        outline: readerTrust && reader?.trustLens ? `2px ${readerTrust.state === 'certified' || readerTrust.state === 'governed' ? 'solid' : 'dashed'} var(--trust-${readerTrust.state})` : undefined,
        outlineOffset: readerTrust && reader?.trustLens ? 2 : undefined,
        border: selected || dragOffset
          ? '1.5px solid var(--dql-app-accent, var(--accent, #4f46e5))'
          : isGeneratedUi
            ? '1px solid var(--dql-app-line-2, var(--border-color, rgba(15,23,42,0.10)))'
            : '1px solid var(--dql-app-line, var(--border-color, rgba(0,0,0,0.08)))',
        borderRadius: 8,
        padding: isCompactMetric ? 12 : 14,
        paddingBottom: showAskHint ? (isCompactMetric ? 42 : 46) : (isCompactMetric ? 12 : 14),
        display: 'flex',
        flexDirection: 'column',
        gap: isCompactMetric ? 4 : isGeneratedUi ? 10 : 6,
        minHeight: narrow ? narrowTileMinHeight(item, genUi) : 0,
        overflow: 'visible',
        boxShadow: dragOffset
          ? '0 16px 40px rgba(0,0,0,0.22)'
          : selected ? '0 0 0 3px var(--dql-app-accent-soft, rgba(79,70,229,0.12))' : undefined,
        cursor: dragOffset ? 'grabbing' : blockId ? 'pointer' : undefined,
        transition: dragOffset ? undefined : 'box-shadow 120ms ease, transform 120ms ease',
      }}
    >
      {showAskHint ? (
        <button
          type="button"
          style={askHintStyle}
          onClick={(event) => {
            event.stopPropagation();
            if (canAskChart && runId) {
              onAskChart?.({ tileId: item.i, runId, question: 'What does this chart show?' });
              return;
            }
            if (blockId) onFocusBlock?.(blockId);
            if (blockId) onAskBlock?.(blockId, defaultTileCopilotQuestion(item.title ?? blockId));
          }}
          title={canAskChart ? 'Ask about this current chart' : 'Open app Copilot for this tile'}
        >
          <Sparkles size={11} strokeWidth={2} /> {canAskChart ? 'Ask about chart' : 'Ask AI'}
        </button>
      ) : null}
      {!editable && (canInspect || canAsk || tileResult || viewerVizChoices.length || onExplainChange) ? (
        <div className="dql-tile-menu-anchor" style={{ opacity: hovered || tileMenuOpen ? 1 : 0 }} onClick={(event) => event.stopPropagation()}>
          <button type="button" className="dql-tile-menu-button" aria-label={`Actions for ${item.title ?? 'tile'}`} aria-haspopup="menu" aria-expanded={tileMenuOpen} onClick={() => setTileMenuOpen((open) => !open)} onFocus={() => setHovered(true)}>
            <MoreHorizontal size={15} />
          </button>
          {tileMenuOpen ? (
            <div className="dql-tile-menu" role="menu" onMouseLeave={() => setTileMenuOpen(false)}>
              {canInspect ? <button type="button" role="menuitem" onClick={() => openEvidence('how')}><ShieldCheck size={14} /> How this was computed</button> : null}
              {canInspect && (item.query || blockId) ? <button type="button" role="menuitem" onClick={() => openEvidence('dql')}><Code2 size={14} /> View DQL</button> : null}
              {onExplainChange && tile && driverProbeFor(item, tile) ? <button type="button" role="menuitem" onClick={() => { setTileMenuOpen(false); onExplainChange(item, tile); }}><Activity size={14} /> Why did it move?</button> : null}
              {canAsk ? <button type="button" role="menuitem" onClick={() => { setTileMenuOpen(false); askAboutTile(); }}><Sparkles size={14} /> {canAskChart ? 'Ask about this chart' : 'Ask AI about this'}</button> : null}
              {canOpenNotebook && tile ? <button type="button" role="menuitem" onClick={() => { setTileMenuOpen(false); onOpenNotebook?.(tile); }}><FileText size={14} /> Open in notebook</button> : null}
              {viewerVizChoices.length ? <><hr /><small className="dql-tile-menu-label">Show as</small>{viewerVizChoices.map((option) => <button key={option.value} type="button" role="menuitemradio" aria-checked={activeChart === option.value} className={activeChart === option.value ? 'on' : ''} onClick={() => { setTileMenuOpen(false); switchGeneratedViz(option.value); }}>{option.label}</button>)}</> : null}
              {onExport && tileResult ? <><hr />{(['csv', 'json', 'xlsx'] as const).map((format) => <button key={format} type="button" role="menuitem" onClick={() => { setTileMenuOpen(false); setExportNote(null); void onExport(format).catch((cause: unknown) => setExportNote(cause instanceof Error ? cause.message : String(cause))); }}><Download size={14} /> Download {EXPORT_LABELS[format]}</button>)}</> : null}
              {!onExport && !hosted && tileResult ? <><hr /><button type="button" role="menuitem" onClick={() => { setTileMenuOpen(false); downloadResultCsv(item.title ?? item.i, tileResult); }}><Download size={14} /> Download CSV</button></> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {exportNote ? <div role="alert" style={{ position: 'absolute', left: 10, right: 10, bottom: 8, zIndex: 3, fontSize: 11, lineHeight: 1.4, padding: '6px 8px', borderRadius: 6, background: 'var(--bg-2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} onClick={() => setExportNote(null)}>{exportNote}</div> : null}
      {editable && !narrow ? (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            zIndex: 3,
            opacity: showEditChrome ? 1 : 0,
            pointerEvents: showEditChrome ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}
        >
            <button
              type="button"
              title="Drag to move tile"
              onPointerDown={startDrag}
              style={dragHandleButtonStyle}
            >
              <GripVertical size={14} strokeWidth={2.2} />
            </button>
        </div>
      ) : null}
      {editable ? (
          <div
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              zIndex: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              opacity: showEditChrome ? 1 : 0,
              pointerEvents: showEditChrome ? 'auto' : 'none',
              transition: 'opacity 120ms ease',
            }}
          >
            {!isCompactMetric ? (
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'var(--surface-hover, rgba(0,0,0,0.06))',
                  opacity: 0.85,
                }}
              >
                {item.viz.type}
              </span>
            ) : null}
            <TileEditorControls
              item={item}
              cols={cols}
              settingsOpen={settingsOpen}
              onToggleSettings={toggleTileSettings}
              onPatch={onPatch}
            />
          </div>
        ) : null}
      {isGeneratedUi ? (
        <div
          style={{
            minHeight: isCompactMetric ? 26 : 42,
            paddingLeft: showEditChrome ? 30 : 0,
            paddingRight: showEditChrome ? (isCompactMetric ? 82 : 134) : 0,
            transition: 'padding 120ms ease',
            display: 'grid',
            gap: 7,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {editable ? (
                <div style={{ fontSize: isCompactMetric ? 12 : 13, fontWeight: 600, lineHeight: 1.25, minWidth: 0 }}>
                  <TileTitleInput value={generatedTitle ?? ''} compact={isCompactMetric} onCommit={(next) => renameTile(next)} />
                </div>
              ) : (
                <div
                  title={generatedTitle}
                  style={{
                    fontSize: isCompactMetric ? 12 : 13,
                    fontWeight: 600,
                    lineHeight: 1.25,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}
                >
                  {generatedTitle}
                </div>
              )}
              {readerDescription ? <p className="dql-tile-description" title={readerDescription}>{readerDescription}</p> : null}
              <div style={generatedMetaRowStyle}>
                {readerTrust ? <ReaderTrustBadge trust={readerTrust} freshness={readerFreshness} receipt={readerReceipt} open={receiptOpen} onOpenChange={setReceiptOpen} onShowEvidence={canInspect && tile ? () => openEvidence('how') : undefined} /> : generatedTrust ? <TrustPill trust={generatedTrust} /> : null}
                {repair ? (
                  <span style={generatedMetaPillStyle} title={repair.message}>
                    <Wrench size={9} /> {repair.status === 'repaired' ? `${repair.mode === 'ai' ? 'AI ' : ''}repaired · review` : 'repair blocked'}
                  </span>
                ) : null}
                {genUi ? <span style={generatedMetaPillStyle}>{componentLabelForGenUi(genUi)}</span> : null}
                {genUi?.layoutIntent ? <span style={generatedMetaPillStyle}>{formatGenUiLabel(String(genUi.layoutIntent))}</span> : null}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            minHeight: isCompactMetric ? 22 : 26,
            paddingLeft: showEditChrome ? 30 : 0,
            paddingRight: showEditChrome ? (isCompactMetric ? 82 : 134) : 0,
            transition: 'padding 120ms ease',
          }}
        >
          <div style={{ fontSize: isCompactMetric ? 12 : 13, fontWeight: 600, lineHeight: 1.25, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {editable ? (
              <TileTitleInput
                value={item.title ?? blockRef ?? ''}
                compact={isCompactMetric}
                onCommit={(next) => renameTile(next)}
              />
            ) : <span>{item.title ?? blockRef}</span>}
          </div>
          {readerDescription ? <p className="dql-tile-description" title={readerDescription}>{readerDescription}</p> : null}
          {unfilteredNotice ? (
            <div style={{ marginTop: 5 }}>
              <span style={generatedMetaPillStyle} title={unfilteredNotice.detail}>
                <Filter size={9} /> {unfilteredNotice.label}
              </span>
            </div>
          ) : null}
          {datasetUnboundNotices.length || tile?.dataset?.validation?.outcome === 'adapted' ? datasetTileNotices(tile, { filterLabels }).map((notice) => (
            <div key={notice.key} style={{ marginTop: 5 }}>
              <span style={generatedMetaPillStyle} title={notice.detail}>
                {notice.kind === 'adapted' ? <Activity size={9} /> : <Filter size={9} />} {notice.label}
              </span>
            </div>
          )) : null}
          {comparisonSummary ? (
            <div style={{ marginTop: 5 }}>
              <span style={generatedMetaPillStyle} title={comparisonSummary}>
                <Activity size={9} /> Period comparison
              </span>
            </div>
          ) : null}
          {readerTrust ? (
            <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <ReaderTrustBadge trust={readerTrust} freshness={readerFreshness} receipt={readerReceipt} open={receiptOpen} onOpenChange={setReceiptOpen} onShowEvidence={canInspect && tile ? () => openEvidence('how') : undefined} />
              {aiPinTrust ? <span style={generatedMetaPillStyle}>AI generated</span> : null}
              {repair ? (
                <span style={generatedMetaPillStyle} title={repair.message}>
                  <Wrench size={9} /> {repair.status === 'repaired' ? `${repair.mode === 'ai' ? 'AI ' : ''}repaired · review` : 'repair blocked'}
                </span>
              ) : null}
            </div>
          ) : aiPinTrust || repair ? (
            <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {aiPinTrust ? <TrustPill trust={aiPinTrust} /> : null}
              {aiPinTrust ? <span style={generatedMetaPillStyle}>AI generated</span> : null}
              {repair ? (
                <span style={generatedMetaPillStyle} title={repair.message}>
                  <Wrench size={9} /> {repair.status === 'repaired' ? `${repair.mode === 'ai' ? 'AI ' : ''}repaired · review` : 'repair blocked'}
                </span>
              ) : null}
            </div>
          ) : showTileSourceRef({ editable, compact: isCompactMetric, blockRef }) ? (
            // The source id ("block:customer_profile") is an author's detail; readers never see it, nor "text" on a text tile.
            <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{blockRef}</div>
          ) : null}
        </div>
      )}
      {editable && settingsOpen ? (
        <TileSettingsPanel
          item={item}
          tile={tile}
          cols={cols}
          onPatch={onPatch}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: 'stretch',
          marginTop: isCompactMetric ? 0 : 2,
          fontSize: 12,
          opacity: tile?.status === 'ok' ? 1 : 0.7,
          fontStyle: tile?.status === 'ok' ? 'normal' : 'italic',
          cursor: kpiOpensReceipt ? 'pointer' : undefined,
        }}
        // A KPI's number opens its receipt; the trust label is the keyboard route.
        onClick={kpiOpensReceipt ? (event) => { event.stopPropagation(); setReceiptOpen(true); } : undefined}
        title={kpiOpensReceipt ? 'Where this number comes from' : undefined}
      >
        <TileBody
          item={renderedItem}
          tile={tile}
          loading={loading}
          error={error}
          themeMode={themeMode}
          genUi={genUi}
          editable={editable}
          onEditText={(markdown) => onPatch({ text: { ...(item.text ?? {}), markdown } })}
          onRetry={onRetry}
          retrying={retrying}
          retryDisabled={retryDisabled}
          crossFilterFields={crossFilterFields}
          onSelectDatasetMark={onSelectDatasetMark}
          onDrillDatasetMark={onDrillDatasetMark}
          onDrillBack={onDrillBack}
          onNavigate={onNavigate}
          onMark={editable ? undefined : onMark}
          tooltipFooter={readerTrust ? `${readerTrust.label}${readerFreshness ? ` · ${readerFreshness}` : ''}` : undefined}
        />
      </div>
      {!editable ? <TileInsightCaption item={item} tile={tile} themeMode={themeMode} /> : null}
      {!editable && inspectorOpen && tile ? (
        <TileEvidencePanel
          item={item}
          tile={tile}
          tab={inspectorTab}
          onTab={setInspectorTab}
          onOpenNotebook={onOpenNotebook}
          onClose={() => setInspectorOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** Save a tile's settled rows as CSV. Values are quoted so commas and quotes survive. */
export function resultToCsv(result: { columns: string[]; rows: Array<Record<string, unknown>> }): string {
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [result.columns.map(cell).join(','), ...result.rows.map((row) => result.columns.map((column) => cell(row[column])).join(','))].join('\n');
}

function downloadResultCsv(title: string, result: { columns: string[]; rows: Array<Record<string, unknown>> }): void {
  const blob = new Blob([resultToCsv(result)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[^a-z0-9-_ ]+/gi, '').trim().replace(/\s+/g, '-').toLowerCase() || 'tile'}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Dataset questions are enabled only for a current, settled runtime result. */
export function canAskDatasetChart(
  tile: DashboardRunTile | undefined,
  editable: boolean,
  runId: string | undefined,
  hasHandler: boolean,
): boolean {
  return Boolean(!editable && hasHandler && runId && tile?.tileType === 'dataset' && tile.status === 'ok');
}

/** Data-driven one-line insight under a tile (the leader), computed from results. */
function TileInsightCaption({ item, tile, themeMode }: { item: DashboardLayoutItem; tile?: DashboardRunResponse['tiles'][number]; themeMode: ThemeMode }): JSX.Element | null {
  const t = themes[themeMode];
  const caption = useMemo(() => computeTileInsight(tile, item), [item, tile]);
  if (!caption) return null;
  return (
    <div style={{ padding: '4px 10px 8px', fontSize: 12, color: t.textMuted, lineHeight: 1.4, display: 'flex', gap: 5, alignItems: 'baseline' }}>
      <span style={{ color: t.accent }}>•</span>
      <span>{caption}</span>
    </div>
  );
}

/** Whether a tile shows its source id under the title: only to an author, never "text" for a text tile. */
export function showTileSourceRef(input: { editable: boolean; compact: boolean; blockRef: string }): boolean {
  return input.editable && !input.compact && input.blockRef !== 'text';
}

export function computeTileInsight(tile?: DashboardRunResponse['tiles'][number], item?: DashboardLayoutItem): string | null {
  // A driver tile's rows repeat the same periods once per breakdown, so no
  // caption can be computed from them; its own checked summary is the caption.
  if (tile?.driver || item?.driver) return tile?.driver?.summary ?? null;
  const rows = tile?.result?.rows;
  const columns = tile?.result?.columns;
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(columns) || columns.length === 0) return null;
  const toNum = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const n = Number(v.replace(/[$,%\s]/g, '')); return Number.isFinite(n) && v.trim() ? n : undefined; }
    return undefined;
  };
  // The measure is what the source declares, else a numeric column that is
  // not a rank, an id, a year or a code: "Kevin Durant leads Rank at 5" read
  // the fifth-ranked row as the leader of a ranking.
  const typedRows = rows as Array<Record<string, unknown>>;
  const selection = selectResultMeasures({
    columns,
    rows: typedRows,
    columnsMeta: tile?.result?.columnsMeta,
    declaredMeasures: tile?.declaredMeasures,
    numericStrings: true,
    // A top-N list (the source's ORDER BY … LIMIT, a "Top N" title) is led
    // by its first row, on the measure it is ordered by.
    ...(tile?.ordering ? { ordering: tile.ordering } : {}),
    ...(item?.title ?? tile?.title ? { source: { title: String(item?.title ?? tile?.title) } } : {}),
  });
  const valueCol = selection.primary;
  const labelCol = selection.labelColumn;
  const labelSamples = labelCol ? typedRows.map((row) => row[labelCol]) : [];
  const leader = resultLeaderRow({ rows: typedRows, numericStrings: true }, selection);
  const leaderLabel = leader && labelCol && leader[labelCol] !== undefined && leader[labelCol] !== null
    ? formatDashboardValue(labelCol, leader[labelCol], labelSamples)
    : undefined;
  if (!valueCol) {
    return selection.rankColumn && leaderLabel && rows.length > 1 ? `${leaderLabel} is ranked first.` : null;
  }
  const valueSamples = typedRows.map((row) => row[valueCol]);
  const metricLabel = formatGenUiLabel(valueCol);
  const valueMeta = tile?.result?.columnsMeta?.find((meta) => meta.name === valueCol);
  const formatMetric = (value: unknown, compact = true) => formatDisplayValue(valueCol, value, valueSamples, { compact, ...(valueMeta ? { meta: valueMeta } : {}) });
  if (rows.length === 1) {
    const v = toNum(typedRows[0]![valueCol]);
    return v !== undefined ? `${metricLabel}: ${formatMetric(v)}.` : null;
  }
  const leaderValue = leader ? toNum(leader[valueCol]) : undefined;
  if (!leader || leaderValue === undefined) return null;
  const label = leaderLabel ?? 'top';
  const formattedTopValue = formatMetric(leaderValue);
  // A ranking is led by the row ranked first, stated on the measure it ranks.
  if (selection.rankColumn) return `${label} is ranked first, with ${metricLabel} at ${formattedTopValue}.`;
  if (selection.ranked && selection.ordering?.direction === 'asc') return `${label} is lowest, with ${metricLabel} at ${formattedTopValue}.`;
  // No share of a total: the visible rows are not known to add up (a COUNT
  // DISTINCT or a ratio does not, a Top-N result is not the whole, and a row
  // set may repeat a period per breakdown), so a percent would be made up.
  if (item?.query?.dimensions?.length) {
    return `${label} reports ${metricLabel} at ${formattedTopValue}.`;
  }
  return `${label} leads ${metricLabel} at ${formattedTopValue}.`;
}

/**
 * A narrative tile's words, edited in place.
 *
 * Click to edit, blur or Escape to go back to rendered markdown, so the tile
 * still reads as prose rather than as a form. Escape reverts; blur saves.
 */
function TileTextEditor({ markdown, variant, themeMode, onCommit }: { markdown: string; variant: 'text' | 'heading'; themeMode: ThemeMode; onCommit: (next: string) => void }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(markdown);
  useEffect(() => { setDraft(markdown); }, [markdown]);
  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        title="Click to edit this text"
        onClick={() => setEditing(true)}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setEditing(true); } }}
        style={{ cursor: 'text', minHeight: 24, borderRadius: 6, outline: 'none' }}
      >
        {markdown.trim()
          ? <MarkdownTile markdown={markdown} variant={variant} themeMode={themeMode} />
          : <span style={{ opacity: 0.55, fontSize: 12 }}>Click to write this section…</span>}
      </div>
    );
  }
  return (
    <textarea
      autoFocus
      aria-label={variant === 'heading' ? 'Heading text' : 'Tile text'}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => { setEditing(false); if (draft !== markdown) onCommit(draft); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { setDraft(markdown); setEditing(false); }
      }}
      style={{
        width: '100%', minHeight: 72, resize: 'vertical', boxSizing: 'border-box',
        font: variant === 'heading' ? '700 17px/1.3 inherit' : 'inherit',
        color: 'inherit', background: 'var(--bg-1, #fff)',
        border: '1px solid var(--accent, #4f46e5)', borderRadius: 7, padding: '7px 9px', outline: 'none',
      }}
    />
  );
}

/**
 * The tile's name, edited where it is read.
 *
 * Styled to sit flush with the heading it replaces so the header does not jump
 * between view and edit, but it carries a real label and shows an affordance on
 * hover — the previous field had neither, and sat under a "Chart and field
 * settings" heading that gave no reason to look there for a name.
 */
function TileTitleInput({ value, compact, onCommit }: { value: string; compact: boolean; onCommit: (next: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      aria-label="Tile name"
      title="Tile name — press Enter to save"
      value={draft}
      maxLength={140}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        const next = draft.trim();
        if (next && next !== value) onCommit(next);
        else setDraft(value);
      }}
      onKeyDown={(event) => {
        event.stopPropagation(); // never let typing reach the tile's drag handlers
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        font: 'inherit',
        color: 'inherit',
        background: focused ? 'var(--bg-1, #fff)' : 'transparent',
        border: `1px solid ${focused ? 'var(--accent, #4f46e5)' : 'transparent'}`,
        borderRadius: 6,
        padding: compact ? '0 4px' : '1px 5px',
        margin: compact ? '0 0 0 -4px' : '0 0 0 -5px',
        maxWidth: '100%',
        width: `${Math.max(6, Math.min(48, draft.length + 1))}ch`,
        outline: 'none',
        cursor: focused ? 'text' : 'pointer',
      }}
      onMouseEnter={(event) => { if (!focused) event.currentTarget.style.borderColor = 'var(--border-subtle, #d8d8d8)'; }}
      onMouseLeave={(event) => { if (!focused) event.currentTarget.style.borderColor = 'transparent'; }}
    />
  );
}

function GeneratedVizSwitcher({
  value,
  options,
  onChange,
}: {
  value: ChartType;
  options: Array<{ value: ChartType; label: string }>;
  onChange: (value: ChartType) => void;
}) {
  // A server-side allow-list can reach nine visualizations, and rendering one
  // button each turned every tile header into a wall of near-identical glyphs.
  // Show a few — always including the current one — and put the rest behind a
  // labelled select.
  const INLINE_LIMIT = 4;
  const inline = options.slice(0, INLINE_LIMIT);
  if (!inline.some((option) => option.value === value)) {
    const current = options.find((option) => option.value === value);
    if (current) inline.splice(INLINE_LIMIT - 1, 1, current);
  }
  const overflow = options.filter((option) => !inline.some((item) => item.value === option.value));

  return (
    <div style={generatedVizSwitcherStyle} aria-label="Visualization">
      {inline.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.label}
          aria-label={option.label}
          aria-pressed={value === option.value}
          onClick={(event) => {
            event.stopPropagation();
            onChange(option.value);
          }}
          style={generatedVizButtonStyle(value === option.value)}
        >
          {iconForChartType(option.value)}
        </button>
      ))}
      {overflow.length > 0 ? (
        <select
          aria-label="More visualizations"
          title="More visualizations"
          value=""
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            if (event.target.value) onChange(event.target.value as ChartType);
          }}
          style={generatedVizOverflowStyle}
        >
          <option value="">More…</option>
          {overflow.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

const generatedVizOverflowStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
  maxWidth: 74,
};

/** The same words the tiles use (READER_TRUST_LABELS), so a page never says two things. */
function TrustPill({ trust }: { trust: string }) {
  const certified = trust === 'certified';
  const label = certified
    ? READER_TRUST_LABELS.certified
    : trust === 'governed' || trust === 'grounded'
      ? READER_TRUST_LABELS.governed
      : trust === 'review_required' ? READER_TRUST_LABELS.review : 'Draft';
  return (
    <span style={trustPillStyle(certified)}>
      {certified ? <ShieldCheck size={10} strokeWidth={2.4} /> : <AlertTriangle size={10} strokeWidth={2.4} />}
      {label}
    </span>
  );
}

function DashboardStoryStrip({ story }: { story: DashboardStory }): JSX.Element {
  return (
    <section style={dashboardStoryStripStyle} aria-label="Current dashboard story">
      <div style={dashboardStoryHeaderStyle}>
        <div style={dashboardStoryIconStyle}>
          <Sparkles size={15} strokeWidth={2.2} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={dashboardStoryKickerStyle}>Story from current results</div>
          <h3 style={dashboardStoryTitleStyle}>{story.title}</h3>
        </div>
        {story.trust ? <TrustPill trust={story.trust} /> : null}
      </div>
      <p style={dashboardStorySummaryStyle}>{story.summary}</p>
      <div style={dashboardStoryChipRowStyle}>
        <span style={dashboardStorySourceChipStyle}>{story.sourceTitle}</span>
        {story.filters.map((filter) => (
          <span key={`${filter.label}:${filter.value}`} style={dashboardStoryChipStyle}>
            {filter.label}: {filter.value}
          </span>
        ))}
        {story.chips.map((chip) => (
          <span key={chip} style={dashboardStoryChipStyle}>{chip}</span>
        ))}
      </div>
    </section>
  );
}

/**
 * "Verified" is said only when every source behind the story is certified.
 * Otherwise the chip says the facts come from results that still need review.
 */
export function storySourceChipLabel(story: Pick<DashboardStoryBrief, 'generatedBy' | 'trustState'>): string {
  const certified = story.trustState === 'certified';
  if (story.generatedBy === 'ai') return certified ? 'AI wording · verified facts' : 'AI wording · facts from sources that need review';
  return certified ? 'Verified result summary' : 'Result summary · sources need review';
}

/**
 * The auto-written Summary of a page's current numbers. Shown only on pages
 * whose author added it (`metadata.summary`, D6); App Studio's Preview uses
 * the same panel so authors see what readers will.
 */
export function BusinessStoryPanel({
  story,
  onEvidence,
  onResearch,
  onRemove,
}: {
  story: DashboardStoryBrief;
  onEvidence?: () => void;
  onResearch?: () => void;
  /** For the author, in App Studio: take the Summary off the page. */
  onRemove?: () => void;
}): JSX.Element {
  return (
    <section style={{ ...dashboardStoryStripStyle, padding: '20px 22px', marginBottom: 16 }} aria-label="Summary">
      <div style={dashboardStoryHeaderStyle}>
        <div style={dashboardStoryIconStyle}><Sparkles size={15} strokeWidth={2.2} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={dashboardStoryKickerStyle}>Summary (auto-written)</div>
          <h2 style={{ ...dashboardStoryTitleStyle, fontSize: 20 }}>{story.headline}</h2>
        </div>
        <TrustPill trust={story.trustState} />
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 12, maxWidth: 920 }}>
        {story.paragraphs.slice(0, 2).map((paragraph, index) => (
          <p key={index} style={{ ...dashboardStorySummaryStyle, margin: 0, fontSize: 14, lineHeight: 1.65 }}>
            {storyInlineText(paragraph)}
          </p>
        ))}
        {story.implication ? (
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, fontWeight: 600 }}>What this means: {storyInlineText(story.implication)}</p>
        ) : null}
      </div>
      <div style={{ ...dashboardStoryChipRowStyle, marginTop: 14 }}>
        <span style={dashboardStorySourceChipStyle}>{storySourceChipLabel(story)}</span>
        <span style={dashboardStoryChipStyle}>{story.evidenceRefs.length} evidence source{story.evidenceRefs.length === 1 ? '' : 's'}</span>
        {story.caveat ? <span style={dashboardStoryChipStyle}>{story.caveat}</span> : null}
        <span style={{ flex: 1 }} />
        {onEvidence ? <button type="button" onClick={onEvidence} style={storyActionButtonStyle}>View evidence</button> : null}
        {isViewerLink() || !onResearch ? null : <button type="button" onClick={onResearch} style={storyActionButtonStyle}>Research deeper</button>}
        {onRemove ? <button type="button" onClick={onRemove} style={storyActionButtonStyle}>Remove Summary</button> : null}
      </div>
    </section>
  );
}

/** The appendix's trust line in plain words, never a raw state like "draft_ready". */
export function appendixTrustWords(trustState: string | undefined): string {
  if (trustState === 'certified') return 'All sources certified';
  if (trustState === 'governed') return 'From the governed model';
  return 'Some sources need review';
}

export function ReviewAppendix({
  run,
  variables,
  filters,
  ranAtMs,
}: {
  run: DashboardRunResponse;
  variables: Record<string, unknown>;
  /** The page's declared filters, so each reads by its label. */
  filters?: DashboardDocumentResponse['dashboard']['filters'];
  /** When this run settled, for "Last refreshed". */
  ranAtMs?: number;
}): JSX.Element {
  const issues = run.tiles.filter((tile) => tile.status !== 'ok');
  const activeFilters = describeDashboardFilterValues(variables, filters);
  return (
    <details style={reviewAppendixStyle} aria-label="Evidence and review appendix">
      <summary style={reviewAppendixSummaryStyle}>
        Evidence & review appendix
        <span style={{ opacity: 0.62, fontWeight: 600 }}>
          {dataSourceCountWords(runDataSourceCount(run.tiles))} · {issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}` : 'all visible sources ran'}
        </span>
      </summary>
      <div style={{ display: 'grid', gap: 12, padding: '0 16px 16px' }}>
        {run.incomplete ? <div role="status" style={saveStatusStyle('var(--text-secondary)')}>
          <AlertTriangle size={13} /> {run.incomplete.message}
        </div> : null}
        <div style={reviewAppendixGridStyle}>
          {ranAtMs !== undefined ? <div><strong>Last refreshed</strong><br /><span>{new Date(ranAtMs).toLocaleString()}</span></div> : null}
          <div><strong>Trust</strong><br /><span>{appendixTrustWords(run.story.trustState)}</span></div>
          <div><strong>Filters</strong><br /><span>{activeFilters.length ? activeFilters.map((filter) => `${filter.label}: ${filter.value}`).join(' · ') : 'No filters'}</span></div>
        </div>
        {issues.length ? (
          <div>
            <strong style={{ fontSize: 12 }}>Items requiring review</strong>
            <ul style={{ margin: '7px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.55 }}>
              {issues.map((tile) => <li key={tile.tileId}>{tile.title ?? tile.tileId}: {tile.error ?? tile.status}</li>)}
            </ul>
          </div>
        ) : null}
        {/* Ids and the story's evidence references, for whoever needs to check them (D6). */}
        <details className="dql-technical-details">
          <summary>Technical details</summary>
          <div style={{ ...reviewAppendixGridStyle, marginTop: 8 }}>
            <div><strong>Run</strong><br /><span>{run.runId}</span></div>
            <div><strong>Snapshot</strong><br /><span>{run.snapshotId}</span></div>
            <div><strong>Trust state</strong><br /><span>{run.story.trustState}</span></div>
          </div>
          {!run.incomplete && run.story.evidenceRefs.length ? <div style={{ marginTop: 8 }}>
            <strong style={{ fontSize: 12 }}>Evidence used by the summary</strong>
            <div style={{ ...dashboardStoryChipRowStyle, marginTop: 7 }}>
              {run.story.evidenceRefs.map((ref) => <span key={ref} style={dashboardStoryChipStyle}>{ref}</span>)}
            </div>
          </div> : null}
        </details>
      </div>
    </details>
  );
}

function storyInlineText(value: string): Array<string | JSX.Element> {
  return value.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );
}

const reviewAppendixStyle: CSSProperties = {
  marginTop: 16,
  border: '1px solid var(--dql-app-line, var(--border-color, rgba(15,23,42,0.10)))',
  borderRadius: 8,
  background: 'var(--dql-app-surface, var(--surface, rgba(0,0,0,0.02)))',
  color: 'var(--dql-app-text, var(--text-primary, #0f172a))',
};

const reviewAppendixSummaryStyle: CSSProperties = {
  cursor: 'pointer',
  padding: '12px 16px',
  fontSize: 13,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

const reviewAppendixGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
  gap: 10,
  fontSize: 12,
  lineHeight: 1.45,
  color: 'var(--dql-app-text-muted, var(--text-secondary, #64748b))',
};

const askHintStyle: CSSProperties = {
  position: 'absolute',
  bottom: 10,
  right: 10,
  zIndex: 5,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 8px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--dql-app-accent, var(--accent, #4f46e5))',
  background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.12))',
  border: '1px solid var(--dql-app-accent, rgba(79,70,229,0.4))',
  cursor: 'pointer',
  lineHeight: 1.2,
  fontFamily: 'inherit',
};

function defaultTileCopilotQuestion(title: string): string {
  return `/ask Explain ${title} for a stakeholder. Start with the business meaning, current result, active filters, caveats, and recommended next action.`;
}

/**
 * A field-based tile in a project that has not turned the feature on. The
 * runtime refuses it (APP-007); the reader gets the reason in plain words and
 * one action, instead of an error code and a config file to edit.
 */
function DatasetsDisabledTileNotice(): JSX.Element {
  const [state, setState] = useState<'idle' | 'enabling' | 'failed'>('idle');
  return (
    <div role="status" style={{ display: 'grid', gap: 8, justifyItems: 'center', textAlign: 'center', padding: 8 }}>
      <span>Field-based tiles are turned off for this project.</span>
      <small style={{ opacity: 0.72 }}>Turning them on sets <code>apps.datasets</code> in <code>dql.config.json</code>.</small>
      <button
        type="button"
        disabled={state === 'enabling'}
        onClick={async (event) => {
          event.stopPropagation();
          setState('enabling');
          const result = await api.enableDatasetTiles();
          if (!result.ok) { setState('failed'); return; }
          setState('idle');
          // Every field tile on the page was refused for the same reason.
          window.dispatchEvent(new CustomEvent('dql-app-datasets-enabled'));
        }}
        style={tileRepairButtonStyle}
      >
        {state === 'enabling' ? 'Turning on…' : 'Turn on field-based tiles'}
      </button>
      {state === 'failed' ? <small>ZLens could not update dql.config.json.</small> : null}
    </div>
  );
}

export function TileBody({
  item,
  tile,
  loading,
  error,
  themeMode,
  genUi,
  editable = false,
  onEditText,
  onRetry,
  retrying,
  retryDisabled,
  crossFilterFields = [],
  onSelectDatasetMark,
  onDrillDatasetMark,
  onDrillBack,
  onNavigate,
  onMark,
  tooltipFooter,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  error: string | null;
  themeMode: ThemeMode;
  genUi?: DqlGenUiMetadata | null;
  /** A clicked mark opens the click menu (RFC 0009 step 6a) instead of one fixed action. */
  onMark?: (row: Record<string, unknown>, at: MarkPointer | undefined, hierarchyCandidates: DashboardHierarchyCandidate[]) => void;
  /** The trust line at the foot of every tooltip. */
  tooltipFooter?: string;
  editable?: boolean;
  onEditText?: (markdown: string) => void;
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  crossFilterFields?: string[];
  onSelectDatasetMark?: (field: string, values: unknown[]) => void;
  onDrillDatasetMark?: (candidate: DashboardHierarchyCandidate, row: Record<string, unknown>) => void;
  onDrillBack?: () => void;
  onNavigate?: () => void;
}): JSX.Element {
  const [markActionId, setMarkActionId] = useState<string>('filter');
  const [barShowAll, setBarShowAll] = useState(false);
  if (loading && !tile) return <span>Loading data...</span>;
  if (tile?.tileType === 'text') {
    if (genUi) {
      return (
        <GeneratedTextTile
          title={item.title ?? genUi.insightTitle ?? 'Generated section'}
          markdown={tile.text?.markdown ?? ''}
          genUi={genUi}
          themeMode={themeMode}
        />
      );
    }
    const markdown = tile.text?.markdown ?? '';
    // Narrative tiles are written for readers, so their words are exactly what
    // an author needs to revise. Editing them required hand-editing the .dqld.
    if (editable && onEditText) {
      return (
        <TileTextEditor
          markdown={markdown}
          variant={tile.viz?.type === 'heading' ? 'heading' : 'text'}
          themeMode={themeMode}
          onCommit={onEditText}
        />
      );
    }
    return <MarkdownTile markdown={markdown} variant={tile.viz?.type === 'heading' ? 'heading' : 'text'} themeMode={themeMode} />;
  }
  if (error && !tile) return <span>{error}</span>;
  if (!tile) return <span>No run result.</span>;
  if (tile.status === 'unauthorized') return <span>Not authorized.</span>;
  if (tile.status === 'unresolved') return <span>{tile.error ?? 'Saved query reference unresolved.'}</span>;
  if (tile.status === 'error' && tile.error?.startsWith('APP_DATASETS_FEATURE_DISABLED')) {
    return <DatasetsDisabledTileNotice />;
  }
  if (tile.status === 'error') return (
    <div style={{ display: 'grid', gap: 8, justifyItems: 'center', textAlign: 'center', padding: 8 }}>
      <span>{tile.error ?? 'Tile failed.'}</span>
      {tile.repair?.status === 'failed' ? <small>{tile.repair.message}</small> : null}
      {onRetry && !isViewerLink() ? (
        <button
          type="button"
          disabled={retrying || retryDisabled}
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
          style={tileRepairButtonStyle}
        >
          <Wrench size={12} /> {retrying ? 'Fixing…' : 'Fix and retry'}
        </button>
      ) : null}
    </div>
  );
  if (tile.tileType === 'driver' && tile.driver) {
    return <div style={{ width: '100%', overflow: 'auto' }}><DriverView analysis={tile.driver} compact={Boolean(item.h && item.h <= 4)} /></div>;
  }
  if (!tile.result) {
    return tile.tileType === 'aiPin' && tile.aiPin
      ? <AiPinSummary pin={tile.aiPin} themeMode={themeMode} />
      : <span>No result.</span>;
  }
  // The author's field names and formats from the tile's shelves (RFC 0009).
  const displayResult = encodedTileResult(item, tile.result);

  const datasetVisualizationError = datasetTileVisualizationDisplayError(item);
  if (datasetVisualizationError) {
    return <div role="alert" style={{ display: 'grid', gap: 6, justifyItems: 'center', textAlign: 'center', padding: 8 }}>
      <strong>Chart needs attention</strong>
      <span>{datasetVisualizationError}</span>
    </div>;
  }

  const chartConfig = { ...mergeDashboardTileChartConfig(item, tile.chartConfig as CellChartConfig | undefined), ...(tooltipFooter ? { tooltipFooter } : {}) };
  const chart = String(chartConfig.chart ?? tile.viz?.type ?? '').toLowerCase();
  const hierarchy = tile.dataset?.hierarchy;
  const hierarchyCandidates = (hierarchy?.candidates ?? []).filter((candidate) => rowValueExists(displayResult.rows, candidate.fromAlias));
  const selectableFields = crossFilterFields.filter((field) => displayResult.columns.includes(field));
  const markActions = onMark ? [] : datasetMarkActions(selectableFields, hierarchyCandidates);
  const selectedMarkAction = markActions.find((action) => action.id === markActionId) ?? markActions[0];
  const selectResultRow = onMark && item.query && !item.query.detail
    ? (row: Record<string, unknown>, at?: MarkPointer) => onMark(row, at, hierarchyCandidates)
    : selectedMarkAction
    ? (row: Record<string, unknown>) => {
      if (selectedMarkAction.kind === 'drill') {
        const candidate = selectedMarkAction.candidate;
        if (onDrillDatasetMark && row[candidate.fromAlias] !== undefined && row[candidate.fromAlias] !== null) {
          onDrillDatasetMark(candidate, row);
        }
        return;
      }
      const field = selectableFields.find((candidate) => row[candidate] !== undefined && row[candidate] !== null);
      if (field) onSelectDatasetMark?.(field, [row[field]]);
    }
    : undefined;
  let dataView: JSX.Element;
  const groupedDatasetKpi = chart === 'kpi' && Boolean(item.query?.dimensions?.length) && displayResult.rows.length > 1;
  if (chart === 'kpi' && item.query && usesKpiCard(item.query, item.viz.style)) {
    // A KPI with a date or a target: the latest period, its change, the trend and the target (RFC 0009 step 4).
    dataView = <KpiCard result={displayResult} query={item.query} style={item.viz.style} label={item.title ?? 'This KPI'} />;
  } else if (groupedDatasetKpi) {
    dataView = (
      <div style={{ width: '100%', alignSelf: 'stretch', display: 'grid', gap: 6 }}>
        <small style={{ color: 'var(--text-secondary)', lineHeight: 1.35 }}>This tile is grouped. Its values are shown at the selected grain instead of being summed into a KPI.</small>
        <TableOutput result={displayResult} themeMode={themeMode} initialPageSize={10} onRowClick={selectResultRow} />
      </div>
    );
  } else if (item.viz.type === 'pivot' && item.query && !item.query.detail) {
    // A pivot's totals are the warehouse's own, one query level each (RFC 0009 step 4).
    const layout = pivotLayout(item.viz.encoding ?? encodingFromQuery(item.query, 'pivot'), item.query);
    dataView = <div style={{ width: '100%', alignSelf: 'stretch' }}><PivotTable result={displayResult} layout={layout} themeMode={themeMode} conditionalFormats={item.viz.style?.conditional} {...(selectResultRow ? { onCellClick: selectResultRow } : {})} /></div>;
  } else if (chart === 'table' || item.viz.type === 'table' || item.viz.type === 'pivot') {
    if (tile.tileType !== 'aiPin' && (genUi?.component === 'EvidenceTable' || genUi?.component === 'PivotTable')) {
      dataView = <GeneratedEvidenceTable result={displayResult} genUi={genUi} themeMode={themeMode} />;
    } else {
      dataView = <div style={{ width: '100%', alignSelf: 'stretch' }}><TableOutput result={displayResult} themeMode={themeMode} initialPageSize={10} onRowClick={selectResultRow} conditionalFormats={item.viz.style?.conditional} /></div>;
    }
  } else {
    // Above 50 categories a bar chart draws the top 25 until the reader asks for all.
    const barCap = chart === 'kpi' ? null : barCategoryCap(displayResult, { chart, category: chartConfig.x, value: chartConfig.y, query: item.query, showAll: barShowAll });
    const chartResult = chart === 'kpi'
      ? summarizeDashboardKpiResult(displayResult, chartConfig.y)
      : barCap?.result ?? displayResult;
    // The tile header is the App title. Passing the same title into the shared
    // chart renderer duplicated it inside the plot and consumed scarce height.
    const chartFrame = (
      <DashboardChartFrame>
        {(availableHeight) => (
          <ChartOutput
            result={chartResult}
            themeMode={themeMode}
            chartConfig={withBarCategoryLimit({ ...chartConfig, title: undefined }, barCap)}
            availableHeight={availableHeight}
            onMarkSelect={selectResultRow}
          />
        )}
      </DashboardChartFrame>
    );
    dataView = barCap?.cappable
      ? <div style={{ width: '100%', alignSelf: 'stretch', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}><BarCapNote cap={barCap} showAll={barShowAll} onShowAll={setBarShowAll} /><div style={{ flex: '1 1 0', minHeight: 0 }}>{chartFrame}</div></div>
      : chartFrame;
  }
  const detailAction = onNavigate ? (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onNavigate(); }}
      style={{ marginTop: 6, alignSelf: 'flex-start', border: '1px solid var(--border-default)', borderRadius: 6, background: 'var(--bg-1)', color: 'var(--accent)', padding: '5px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
    >
      Open configured details
    </button>
  ) : null;
  const hierarchyAction = hierarchy ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
      {markActions.length > 1 ? (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)' }}>
          Click action
          <select value={selectedMarkAction?.id ?? ''} onChange={(event) => setMarkActionId(event.target.value)} style={{ fontSize: 11 }}>
            {markActions.map((action) => (
              <option key={action.id} value={action.id}>
                {action.kind === 'filter' ? 'Filter linked tiles' : `Drill to ${formatGenUiLabel(action.candidate.toField)}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {selectedMarkAction?.kind === 'drill' ? (
        <small style={{ color: 'var(--text-secondary)', lineHeight: 1.35 }}>
          {markActions.length > 1 ? 'Choose the drill action, then ' : ''}Click a {formatGenUiLabel(selectedMarkAction.candidate.fromField)} mark to drill to {formatGenUiLabel(selectedMarkAction.candidate.toField)}.
        </small>
      ) : null}
      {hierarchy.activeSteps.length > 0 && onDrillBack ? (
        <>
          <small style={{ color: 'var(--text-secondary)' }} aria-label="Drill path">
            Exploring, not saved · All › {hierarchy.activeSteps.map((step) => step.values.map(String).join(', ')).join(' › ')}
          </small>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onDrillBack(); }}
            style={{ border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--bg-1)', color: 'var(--accent)', padding: '5px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
          >
            Up one level
          </button>
        </>
      ) : null}
    </div>
  ) : null;
  return tile.tileType === 'aiPin' && tile.aiPin
    ? <AiPinSummary pin={tile.aiPin} themeMode={themeMode} dataView={dataView} />
    : <>{dataView}{hierarchyAction}{detailAction}</>;
}

function rowValueExists(rows: Array<Record<string, unknown>>, field: string): boolean {
  return rows.some((row) => row[field] !== undefined && row[field] !== null);
}

/**
 * Gives App charts the height of the tile body, not the browser viewport.
 * Fixed-height SVGs were centered inside shorter grid cells, clipping both the
 * first and last rows while leaving the surrounding tile apparently empty.
 */
function DashboardChartFrame({
  children,
}: {
  children: (availableHeight?: number) => ReactNode;
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [availableHeight, setAvailableHeight] = useState<number | undefined>();

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const update = () => {
      const next = Math.floor(element.getBoundingClientRect().height);
      setAvailableHeight(next > 0 ? next : undefined);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      data-testid="dashboard-chart-frame"
      style={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        alignSelf: 'stretch',
        overflow: 'auto',
        scrollbarWidth: 'thin',
      }}
    >
      {children(availableHeight)}
    </div>
  );
}

export function TileEvidencePanel({
  item,
  tile,
  tab,
  onTab,
  onOpenNotebook,
  onClose,
}: {
  item: DashboardLayoutItem;
  tile: DashboardRunTile;
  tab: 'how' | 'dql' | 'sql';
  onTab: (tab: 'how' | 'dql' | 'sql') => void;
  onOpenNotebook?: (tile: DashboardRunTile) => void;
  onClose: () => void;
}): JSX.Element {
  const artifact = tile.artifact;
  const grainEvidenceDetail = formatDatasetGrainEvidenceDetail(tile.dataset?.grainRuntimeEvidence);
  const isDatasetArtifact = artifact?.sourceKind === 'dataset_query';
  const currentDatasetEvidence = isDatasetArtifact && isCurrentDatasetTileEvidence(item, tile)
    ? presentDatasetTileEvidence(tile)
    : undefined;
  const comparisonSummary = isDatasetArtifact ? datasetComparisonSummary(item.query?.comparison) : undefined;
  const runEvidence = presentDashboardTileRunEvidence(tile);
  const canOpenNotebook = canOpenTileInNotebook(tile);
  const sourceLabel = artifact?.sourceKind === 'certified_block'
    ? 'Certified saved query'
    : artifact?.sourceKind === 'semantic_query'
      ? 'Governed semantic query'
      : artifact?.sourceKind === 'dataset_query'
        ? 'Governed field query'
      : artifact?.sourceKind === 'draft_analysis'
        ? 'App analysis'
        : artifact?.sourceKind === 'ai_pin'
          ? 'Saved AI insight'
          : tile.tileType ?? 'App tile';
  return (
    <div style={tileEvidenceBackdropStyle} role="presentation" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`How ${item.title ?? tile.title ?? item.i} works`}
        style={tileEvidencePanelStyle}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{item.title ?? tile.title ?? artifact?.name ?? 'App tile'}</div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>{sourceLabel} · {artifact?.trustState === 'certified' && !tile.repair ? READER_TRUST_LABELS.certified : READER_TRUST_LABELS.review}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close details" style={iconTileButtonStyle}><X size={14} /></button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 10 }}>
          {(['how', 'dql', 'sql'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => onTab(candidate)}
              style={tileEvidenceTabStyle(tab === candidate)}
            >
              {candidate === 'how'
                ? 'How it works'
                : candidate === 'dql' && isDatasetArtifact
                  ? 'Authored query spec'
                  : candidate === 'sql' && isDatasetArtifact
                    ? 'Executed SQL'
                    : candidate.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={{ minHeight: 180, maxHeight: '56vh', overflow: 'auto' }}>
          {tab === 'how' ? (
            <div style={{ display: 'grid', gap: 12, fontSize: 13, lineHeight: 1.5 }}>
              <EvidenceRow label="Source" value={artifact?.sourcePath ?? tile.citation?.path ?? tile.citation?.name ?? sourceLabel} />
              <EvidenceRow label="Result" value={runEvidence.result} />
              {comparisonSummary ? <EvidenceRow label="Period comparison" value={comparisonSummary} /> : null}
              {grainEvidenceDetail ? <EvidenceRow label="Current grain check" value={grainEvidenceDetail} /> : null}
              {/* Ids, revisions and fingerprints, for whoever needs to check them (D6). */}
              {tile.dataset?.sourceId || tile.dataset?.queryFingerprint || tile.dataset?.proofState || (isDatasetArtifact && currentDatasetEvidence) ? (
                <details className="dql-technical-details">
                  <summary>Technical details</summary>
                  <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
                    {tile.dataset?.sourceId ? <EvidenceRow label="Data source" value={`${tile.dataset.sourceId}${tile.dataset.sourceRevision ? ` · ${tile.dataset.sourceRevision}` : ''}`} /> : null}
                    {tile.dataset?.queryFingerprint ? <EvidenceRow label="Field query" value={tile.dataset.queryFingerprint} /> : null}
                    {tile.dataset?.filterFingerprint ? <EvidenceRow label="Filters" value={tile.dataset.filterFingerprint} /> : null}
                    {tile.dataset?.executionFingerprint ? <EvidenceRow label="Execution" value={tile.dataset.executionFingerprint} /> : null}
                    {tile.dataset?.proofState ? <EvidenceRow label="Grain evidence" value={tile.dataset.proofState} /> : null}
                    {isDatasetArtifact && currentDatasetEvidence ? <>
                      <EvidenceRow label="Bound parameters" value="Values are redacted; binding types and fingerprints are listed below." />
                      <EvidenceRows rows={currentDatasetEvidence.parameterEvidence} />
                      <EvidenceRows rows={currentDatasetEvidence.provenance} />
                      {currentDatasetEvidence.receipt.rows.length ? <EvidenceRows rows={currentDatasetEvidence.receipt.rows} /> : null}
                      {currentDatasetEvidence.receipt.notice ? <EvidenceRow label="Provider receipt" value={currentDatasetEvidence.receipt.notice} /> : null}
                    </> : null}
                  </div>
                </details>
              ) : null}
              {isDatasetArtifact && !currentDatasetEvidence ? <EvidenceRow label="Execution evidence" value="This result no longer matches the current data source or query. Run the dashboard again before inspecting execution evidence." /> : null}
              {isDatasetArtifact ? <EvidenceRow label="Notebook" value="Field queries cannot be opened in Notebook yet." /> : null}
              {artifact?.explanation?.length ? (
                <div>
                  <b>Execution</b>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {artifact.explanation.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </div>
              ) : null}
              {runEvidence.filters ? <EvidenceRow label="Filters" value={runEvidence.filters} /> : null}
              {runEvidence.parameters ? <EvidenceRow label="Parameters" value={runEvidence.parameters} /> : null}
              {tile.repair ? <EvidenceRow label="Repair" value={tile.repair.message} /> : null}
              <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-2)', color: 'var(--text-secondary)' }}>
                {isDatasetArtifact
                  ? 'Parameter values are intentionally omitted here. Query run evidence remains available in this App.'
                  : 'Parameter values are intentionally omitted here. Open the editable Notebook cell to inspect or change the full execution contract.'}
              </div>
            </div>
          ) : (
            <pre style={tileEvidenceCodeStyle}>
              {tab === 'dql'
                ? isDatasetArtifact
                  ? currentDatasetEvidence?.authoredQuerySpec ?? currentDatasetEvidence?.authoredQuerySpecUnavailable ?? 'This result no longer matches the current data source or query. Run the dashboard again before inspecting execution evidence.'
                  : artifact?.dql ?? 'This tile does not expose DQL source. Its governed semantic intent is composed into SQL at runtime.'
                : isDatasetArtifact
                  ? currentDatasetEvidence?.executedSql ?? currentDatasetEvidence?.executedSqlUnavailable ?? 'This result no longer matches the current data source or query. Run the dashboard again before inspecting execution evidence.'
                  : artifact?.sql ?? 'Executed SQL is not available for this saved result.'}
            </pre>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <button type="button" onClick={onClose} style={toolbarButtonStyle(false)}>Close</button>
          {canOpenNotebook ? (
            <button type="button" onClick={() => onOpenNotebook?.(tile)} style={toolbarButtonStyle(true)}>
              Open in Notebook
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function EvidenceRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: 12 }}>
      <b>{label}</b>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: 'var(--text-secondary)' }}>{value}</span>
    </div>
  );
}

function EvidenceRows({ rows }: { rows: DatasetEvidenceRow[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  return <>{rows.map((row) => <EvidenceRow key={`${row.label}:${row.value}`} label={row.label} value={row.value} />)}</>;
}

function TileEditorControls({
  item,
  cols,
  settingsOpen,
  onToggleSettings,
  onPatch,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  cols: number;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
}) {
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const applyPreset = (preset: TileSizePresetId) => {
    setSizeMenuOpen(false);
    onPatch(tileSizePatch(item, cols, preset));
  };
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          title="Choose tile size"
          onClick={() => setSizeMenuOpen((value) => !value)}
          style={iconTileButtonStyle}
        >
          <Maximize2 size={13} strokeWidth={2} />
        </button>
        {sizeMenuOpen ? (
          <TileSizeMenu
            onPick={applyPreset}
            onClose={() => setSizeMenuOpen(false)}
          />
        ) : null}
      </div>
      <button
        type="button"
        title="Tile settings"
        aria-label="Tile settings"
        onClick={onToggleSettings}
        style={iconTileButtonStyle}
      >
        <SlidersHorizontal size={13} strokeWidth={2} color={settingsOpen ? 'var(--accent, #4f46e5)' : undefined} />
      </button>
      <button
        type="button"
        title="Remove tile"
        onClick={() => onPatch(null)}
        style={iconTileButtonStyle}
      >
        <Trash2 size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

function TileSizeMenu({
  onPick,
  onClose,
}: {
  onPick: (preset: TileSizePresetId) => void;
  onClose: () => void;
}) {
  return (
    <div
      style={tileSizeMenuStyle}
      onMouseLeave={onClose}
    >
      {TILE_SIZE_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => onPick(preset.id)}
          style={tileSizeMenuItemStyle}
        >
          <span style={{ fontSize: 12, fontWeight: 600 }}>{preset.label}</span>
          <span style={{ fontSize: 11, opacity: 0.66 }}>{preset.description}</span>
        </button>
      ))}
    </div>
  );
}

function TileSettingsPanel({
  item,
  tile,
  cols,
  onPatch,
  onClose,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  cols: number;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
  onClose: () => void;
}) {
  const result = tile?.result;
  const chartConfig = mergeDashboardTileChartConfig(item, tile?.chartConfig as CellChartConfig | undefined);
  const chart = normalizeChartType(chartConfig.chart);
  const genUi = getDqlGenUi(item);
  const [recommendBusy, setRecommendBusy] = useState(false);
  const [recommendNote, setRecommendNote] = useState<string | null>(null);
  const [recommendError, setRecommendError] = useState<string | null>(null);
  const classified = useMemo(() => classifyColumns(result), [result]);
  const columnKinds = useMemo(() => {
    const map = new Map<string, ChartColumnRole>();
    if (!result) return map;
    const metricSet = new Set(classified.metrics);
    const dimSet = new Set(classified.dimensions);
    for (const column of result.columns) {
      if (metricSet.has(column)) map.set(column, 'measure');
      else if (dimSet.has(column)) map.set(column, 'dimension');
      else map.set(column, columnKindToChartRole(inferColumnKind(column, result.rows)));
    }
    return map;
  }, [result, classified]);
  const measures = result?.columns.filter((column) => columnKinds.get(column) === 'measure') ?? [];
  const dimensions = result?.columns.filter((column) => columnKinds.get(column) !== 'measure') ?? [];

  // The title is the one field typed character by character; everything else in
  // this panel is a discrete choice that can save immediately.
  // Seed from what the tile actually displays. `chartConfig.title` can carry a
  // block-level default, so preferring it showed a different name in the editor
  // than in the header — and saving then silently renamed the tile.
  const savedTitle = item.title ?? chartConfig.title ?? '';
  const [titleDraft, setTitleDraft] = useState(savedTitle);
  useEffect(() => { setTitleDraft(savedTitle); }, [savedTitle]);
  const commitTitleDraft = () => {
    const next = titleDraft.trim();
    if (next === savedTitle) return;
    patchConfig({ title: next || undefined });
  };

  const patchConfig = (patch: Partial<CellChartConfig>) => {
    const next = compactChartConfig({ ...chartConfig, ...patch });
    const dashboardViz = chartToDashboardViz(next.chart);
    const currentGenUi = getDqlGenUi(item);
    const options: Record<string, unknown> = { ...next };
    if (currentGenUi) {
      options.dqlGenUi = {
        ...currentGenUi,
        defaultVisualization: dashboardViz,
        ...(next.title ? { insightTitle: next.title } : {}),
      };
    }
    onPatch({
      title: next.title || item.title,
      viz: {
        ...item.viz,
        type: dashboardViz,
        options,
      },
      display: displayWithVisualization(item, dashboardViz, currentGenUi),
    });
  };

  const applyRecommendation = async () => {
    setRecommendBusy(true);
    setRecommendError(null);
    setRecommendNote(null);
    const blockRef = getDashboardItemBlockId(item) ?? item.title;
    const response = await api.recommendVisualization({
      ...(blockRef ? { blockRef } : {}),
      resultSchema: result ? { columns: result.columns } : undefined,
      rowSample: result?.rows.slice(0, 5) as Array<Record<string, unknown>> | undefined,
      prompt: [item.title, genUi?.rationale].filter(Boolean).join(' '),
      allowedVisualizations: genUi?.allowedVisualizations,
    });
    setRecommendBusy(false);
    if (!response.ok) {
      setRecommendError(response.error);
      return;
    }
    const chart = normalizeChartType(response.display.defaultVisualization);
    const dashboardViz = chartToDashboardViz(chart);
    const hints = response.display.fieldHints ?? {};
    const next = compactChartConfig({
      ...chartConfig,
      chart,
      title: chartConfig.title ?? item.title,
      x: hints.x ?? hints.label ?? chartConfig.x,
      y: hints.y ?? hints.value ?? chartConfig.y,
      color: hints.color ?? chartConfig.color,
    });
    onPatch({
      title: next.title || item.title,
      viz: {
        ...item.viz,
        type: dashboardViz,
        options: { ...next } as Record<string, unknown>,
      },
      display: response.display,
    });
    const evidence = response.evidence.map((entry) => entry.source).slice(0, 3).join(', ');
    const warning = response.warnings[0];
    setRecommendNote(warning ? `${response.display.component}: ${warning}` : `${response.display.component}${evidence ? ` from ${evidence}` : ''}`);
  };

  return (
    <aside
      role="dialog"
      aria-label={`Tile settings for ${item.title ?? item.i}`}
      style={tileSettingsPanelStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <header style={tileSettingsHeaderStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 }}>
            <SlidersHorizontal size={14} /> Tile settings
          </div>
          <div style={{ marginTop: 2, color: 'var(--text-tertiary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.title ?? item.i}
          </div>
        </div>
        <button type="button" aria-label="Close tile settings" title="Close" onClick={onClose} style={tileSettingsCloseStyle}>
          <X size={15} />
        </button>
      </header>

      <section style={tileSettingsSectionStyle}>
        <div style={tileSettingsSectionHeadingStyle}>Layout</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TILE_SIZE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              onClick={() => onPatch(tileSizePatch(item, cols, preset.id))}
              style={sizePresetChipStyle(presetMatches(item, cols, preset.id))}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </section>

      <section style={tileSettingsSectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={tileSettingsSectionHeadingStyle}>Visualization</div>
          <button
            type="button"
            onClick={() => void applyRecommendation()}
            disabled={recommendBusy}
            style={recommendButtonStyle(recommendBusy)}
            title="Recommend a visualization from governed result fields"
          >
            <Wand2 size={12} strokeWidth={2.2} />
            {recommendBusy ? 'Thinking…' : 'Recommend'}
          </button>
        </div>
        <div style={tileSettingsGridStyle}>
          <label style={{ ...tileSettingsLabelStyle, gridColumn: '1 / -1' }}>
            Title
            <input
              aria-label="Tile name"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => commitTitleDraft()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') { setTitleDraft(savedTitle); event.currentTarget.blur(); }
              }}
              style={tileSettingsInputStyle}
            />
          </label>
          <label style={{ ...tileSettingsLabelStyle, gridColumn: '1 / -1' }}>
            Chart type
            <select
              value={chart}
              onChange={(event) => patchConfig({ chart: event.target.value as ChartType })}
              style={tileSettingsInputStyle}
            >
              {APP_CHART_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        {recommendNote ? <div style={recommendNoteStyle}>{recommendNote}</div> : null}
        {recommendError ? <div style={recommendErrorStyle}>{recommendError}</div> : null}
      </section>

      <details style={tileSettingsDetailsStyle}>
        <summary style={tileSettingsSummaryStyle}>Data fields and advanced options</summary>
        <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
          <div style={tileSettingsGridStyle}>
            <FieldSelect label="Category / X" value={chartConfig.x} columns={result?.columns ?? []} onChange={(value) => patchConfig({ x: value })} />
            <FieldSelect label="Value / Y" value={chartConfig.y} columns={result?.columns ?? []} onChange={(value) => patchConfig({ y: value })} />
            <FieldSelect label="Color" value={chartConfig.color} columns={result?.columns ?? []} onChange={(value) => patchConfig({ color: value })} />
            <FieldSelect label="Facet" value={chartConfig.facet} columns={result?.columns ?? []} onChange={(value) => patchConfig({ facet: value })} />
          </div>
          {result ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <ColumnPickList title="Measures" columns={measures} onPick={(column) => patchConfig({ y: column })} />
              <ColumnPickList title="Dimensions" columns={dimensions} onPick={(column) => patchConfig({ x: column })} />
            </div>
          ) : (
            <div style={{ fontSize: 11, opacity: 0.64 }}>Run the tile once to map result fields.</div>
          )}
        </div>
      </details>

      <details style={tileSettingsDetailsStyle}>
        <summary style={tileSettingsSummaryStyle}>Why this visualization</summary>
        <div style={tileDisplayContractStyle}>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            {genUi?.rationale ?? item.display?.rationale ?? 'This visualization is constrained by the governed result fields and the saved App display contract.'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {genUi?.component ? <span style={generatedMetaPillStyle}>{componentLabelForGenUi(genUi)}</span> : null}
            {genUi?.defaultVisualization ? <span style={generatedMetaPillStyle}>{formatGenUiLabel(String(genUi.defaultVisualization))}</span> : null}
            {genUi?.reviewStatus ? <span style={generatedMetaPillStyle}>{formatGenUiLabel(String(genUi.reviewStatus))}</span> : null}
          </div>
        </div>
      </details>
    </aside>
  );
}

function FieldSelect({
  label,
  value,
  columns,
  onChange,
}: {
  label: string;
  value?: string;
  columns: string[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label style={tileSettingsLabelStyle}>
      {label}
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)} style={tileSettingsInputStyle}>
        <option value="">Auto</option>
        {columns.map((column) => <option key={column} value={column}>{column}</option>)}
      </select>
    </label>
  );
}

function ColumnPickList({
  title,
  columns,
  onPick,
}: {
  title: string;
  columns: string[];
  onPick: (column: string) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', opacity: 0.58 }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {columns.length === 0 ? <span style={{ fontSize: 11, opacity: 0.55 }}>None</span> : columns.slice(0, 10).map((column) => (
          <button key={column} type="button" onClick={() => onPick(column)} style={fieldChipStyle}>
            {column}
          </button>
        ))}
      </div>
    </div>
  );
}

function AddTileMenu({
  open,
  onToggle,
  onCertifiedBlock,
  onText,
  onHeading,
  onAi,
  buttonLabel,
  buttonStyle,
}: {
  open: boolean;
  onToggle: () => void;
  onCertifiedBlock: () => void;
  onText: () => void;
  onHeading: () => void;
  onAi: () => void;
  buttonLabel?: string;
  buttonStyle?: CSSProperties;
}) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" onClick={onToggle} title="Add tile" style={buttonStyle ?? toolbarButtonStyle(open)}>
        <Plus size={15} strokeWidth={2.2} />
        {buttonLabel ? <span>{buttonLabel}</span> : null}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 30,
            width: 260,
            border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
            borderRadius: 8,
            background: 'var(--color-bg, #fff)',
            boxShadow: '0 14px 38px rgba(0,0,0,0.16)',
            padding: 6,
            display: 'grid',
            gap: 4,
            textAlign: 'left',
          }}
        >
          <AddTileMenuItem title="Certified saved query" description="Chart, table, or KPI from this App domain" onClick={onCertifiedBlock} />
          <AddTileMenuItem title="Text / summary" description="Narrative, notes, caveats, or CXO context" onClick={onText} />
          <AddTileMenuItem title="Section heading" description="Separate an App page into readable groups" onClick={onHeading} />
          <AddTileMenuItem title="Copilot insight" description="Open scoped AI, then pin the reviewed answer to this App" onClick={onAi} />
        </div>
      )}
    </div>
  );
}

function AddTileMenuItem({
  title,
  description,
  onClick,
}: {
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={addMenuItemStyle}>
      <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
      <span style={{ fontSize: 11, opacity: 0.66 }}>{description}</span>
    </button>
  );
}

function GeneratedTextTile({
  title,
  markdown,
  genUi,
  themeMode,
}: {
  title: string;
  markdown: string;
  genUi: DqlGenUiMetadata;
  themeMode: ThemeMode;
}) {
  const theme = themes[themeMode as NotebookThemeMode];
  const summary = extractGeneratedSummary(markdown, title);
  const isTrust = genUi.component === 'TrustCallout';
  const isResearch = genUi.component === 'ResearchActions';
  return (
    <div style={generatedTextTileStyle(isTrust)}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <span style={generatedTextIconStyle(isTrust)}>
          {isTrust ? <AlertTriangle size={15} /> : isResearch ? <Sparkles size={15} /> : <ShieldCheck size={15} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.25 }}>{title ?? genUi.insightTitle}</div>
          <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.45, color: theme.textSecondary }}>
            {summary}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {genUi.trustState ? <TrustPill trust={genUi.trustState} /> : null}
        {genUi.reviewStatus ? <span style={generatedMetaPillStyle}>{formatGenUiLabel(genUi.reviewStatus)}</span> : null}
      </div>
      {genUi.followUpActions?.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {genUi.followUpActions.slice(0, 3).map((action) => (
            <span key={action} style={generatedActionChipStyle}>
              {formatGenUiLabel(action)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GeneratedEvidenceTable({
  result,
  genUi,
  themeMode,
}: {
  result: QueryResult;
  genUi: DqlGenUiMetadata;
  themeMode: ThemeMode;
}) {
  const theme = themes[themeMode as NotebookThemeMode];
  const rows = result.rows ?? [];
  const columns = result.columns ?? [];
  const labelColumn = pickEvidenceLabelColumn(columns, rows, genUi.fieldHints?.label);
  const statusColumn = columns.find((column) => /\b(status|quality|trust|certification|review)\b/i.test(column));
  const metricColumns = columns
    .filter((column) => column !== labelColumn && column !== statusColumn)
    .filter((column) => evidenceMetricRank(column) < 90 || isNumericColumn(column, rows))
    .sort((a, b) => evidenceMetricRank(a) - evidenceMetricRank(b))
    .slice(0, 2);
  const detailColumns = columns
    .filter((column) => column !== labelColumn && column !== statusColumn && !metricColumns.includes(column))
    .slice(0, 2);
  const rowCount = result.rowCount ?? rows.length;
  const valueSamples = resultValueSamples(columns, rows);

  return (
    <div style={generatedEvidenceStyle}>
      <div style={{ fontSize: 12, color: theme.textSecondary }}>
        {rowCount} {rowCount === 1 ? 'row' : 'rows'} across {columns.length} {columns.length === 1 ? 'field' : 'fields'}
      </div>
      <div style={generatedEvidenceRowsStyle}>
        {rows.slice(0, 4).map((row, index) => {
          const label = labelColumn ? formatDashboardValue(labelColumn, row[labelColumn], valueSamples.get(labelColumn) ?? []) : `Row ${index + 1}`;
          const status = statusColumn ? formatDashboardValue(statusColumn, row[statusColumn], valueSamples.get(statusColumn) ?? []) : null;
          return (
            <div key={index} style={generatedEvidenceRowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
                {detailColumns.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
                    {detailColumns.map((column) => (
                      <span key={column} style={generatedEvidenceMiniPillStyle}>
                        {formatGenUiLabel(column)}: {formatDashboardValue(column, row[column], valueSamples.get(column) ?? [])}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-start', minWidth: 0 }}>
                {metricColumns.map((column) => (
                  <span key={column} style={generatedEvidenceMetricStyle}>
                    <span style={{ opacity: 0.62 }}>{formatGenUiLabel(column)}</span>
                    <strong>{formatDashboardValue(column, row[column], valueSamples.get(column) ?? [])}</strong>
                  </span>
                ))}
                {status ? <span style={generatedEvidenceStatusStyle}>{status}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
      {rows.length > 4 ? (
        <div style={{ fontSize: 11, color: theme.textSecondary }}>
          Showing first 4 rows in generated view. Switch tile settings for full table controls.
        </div>
      ) : null}
    </div>
  );
}

function MarkdownTile({ markdown, variant = 'text', themeMode }: { markdown: string; variant?: 'text' | 'heading'; themeMode: ThemeMode }) {
  const theme = themes[themeMode as NotebookThemeMode];
  return (
    <div
      style={{
        width: '100%',
        alignSelf: 'stretch',
        overflow: 'auto',
        whiteSpace: 'normal',
        lineHeight: 1.45,
        fontStyle: 'normal',
        opacity: 1,
        fontSize: variant === 'heading' ? 18 : undefined,
        fontWeight: variant === 'heading' ? 800 : undefined,
        display: variant === 'heading' ? 'flex' : undefined,
        alignItems: variant === 'heading' ? 'center' : undefined,
      }}
    >
      {renderMarkdown(markdown, theme)}
    </div>
  );
}

/** With a host, an AI pin is per person and not shared App content. */
export const AI_PIN_ONLY_YOU = 'Only you see this pin; keep it as a live tile to share it.';

function AiPinSummary({
  pin,
  themeMode,
  dataView,
}: {
  pin: NonNullable<DashboardRunResponse['tiles'][number]['aiPin']>;
  themeMode: ThemeMode;
  dataView?: ReactNode;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const theme = themes[themeMode as NotebookThemeMode] ?? themes.light;
  // With a host an AI pin is its pinner's own, not the App's: others never see its answer or rows.
  const hosted = useHostUi().host;
  const refresh = async () => {
    setMessage('Refreshing...');
    const result = await api.refreshAiPin(pin.appId, pin.id);
    setMessage(result.ok ? 'Refreshed.' : result.error ?? 'Refresh failed.');
    window.dispatchEvent(new CustomEvent('dql-app-dashboard-updated', { detail: { appId: pin.appId, dashboardId: pin.dashboardId } }));
  };
  const promote = async () => {
    setMessage('Creating draft...');
    const result = await api.promoteAiPin(pin.appId, pin.id);
    setMessage(result.ok ? `Draft created: ${result.blockPath}` : result.error ?? 'Promotion failed.');
    window.dispatchEvent(new CustomEvent('dql-app-dashboard-updated', { detail: { appId: pin.appId, dashboardId: pin.dashboardId } }));
  };
  return (
    <div style={{ width: '100%', alignSelf: 'stretch', overflow: 'auto', fontStyle: 'normal', lineHeight: 1.5, display: 'grid', gap: 10 }}>
      {dataView ? dataView : (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: pin.certification === 'certified' ? '#15803d' : '#b45309', background: pin.certification === 'certified' ? 'rgba(22,163,74,0.1)' : 'rgba(245,158,11,0.12)', border: `1px solid ${pin.certification === 'certified' ? 'rgba(22,163,74,0.22)' : 'rgba(245,158,11,0.24)'}`, borderRadius: 999, padding: '3px 7px' }}>
              {pin.certification === 'certified' ? 'Certified' : 'Review required'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted, rgba(0,0,0,0.58))' }}>{hosted ? AI_PIN_ONLY_YOU : 'Pinned report insight'}</span>
          </div>
          <div style={{ minWidth: 0 }}>
            {renderMarkdown(pin.answer, theme)}
          </div>
          {pin.result?.rows?.length ? <AiPinEvidencePreview result={pin.result} /> : null}
        </>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {pin.sql && <button type="button" onClick={() => void refresh()} style={miniButtonStyle}>Refresh</button>}
        {pin.sql && pin.reviewStatus === 'needs_review' && <button type="button" onClick={() => void promote()} style={miniButtonStyle}>Promote</button>}
        {pin.refreshCadence === 'daily' && <span style={{ fontSize: 11, opacity: 0.62 }}>daily</span>}
      </div>
      {message && <div style={{ marginTop: 6, fontSize: 11, opacity: 0.72 }}>{message}</div>}
      {pin.lastRefreshError && <div style={{ marginTop: 8, color: '#f85149' }}>{pin.lastRefreshError}</div>}
    </div>
  );
}

function AiPinEvidencePreview({ result }: { result: QueryResult }) {
  const columns = (result.columns?.length ? result.columns : Object.keys(result.rows?.[0] ?? {})).slice(0, 4);
  const rows = (result.rows ?? []).slice(0, 3);
  const valueSamples = resultValueSamples(columns, result.rows ?? []);
  if (!columns.length || !rows.length) return null;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ color: 'var(--color-text-muted, rgba(0,0,0,0.58))', fontSize: 11, fontWeight: 600 }}>Supporting rows</div>
      <div style={{ overflow: 'auto', border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} style={{ textAlign: 'left', padding: '5px 7px', borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))', color: 'var(--color-text-muted, rgba(0,0,0,0.58))' }}>
                  {formatGenUiLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column} style={{ padding: '5px 7px', borderBottom: index === rows.length - 1 ? 'none' : '1px solid var(--border-color, rgba(0,0,0,0.06))' }}>
                    {formatDashboardValue(column, row[column], valueSamples.get(column) ?? [])}
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

function TextTileDialog({
  kind,
  value,
  onChange,
  onClose,
  onSave,
}: {
  kind: 'text' | 'heading';
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const isHeading = kind === 'heading';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.36)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: 'min(520px, 92vw)', display: 'grid', gap: 12, background: 'var(--color-bg, #fff)', color: 'inherit', borderRadius: 8, boxShadow: '0 18px 60px rgba(0,0,0,0.35)', padding: 16 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{isHeading ? 'Add heading' : 'Add text tile'}</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
            {isHeading ? 'Create a section heading on this dashboard page.' : 'Create a narrative text tile on this dashboard page.'}
          </div>
        </div>
        {isHeading ? (
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSave();
              if (event.key === 'Escape') onClose();
            }}
            placeholder="Executive summary"
            autoFocus
            style={dialogInputStyle}
          />
        ) : (
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave();
            }}
            placeholder="Add context, assumptions, or decisions..."
            rows={6}
            autoFocus
            style={{ ...dialogInputStyle, resize: 'vertical', lineHeight: 1.45 }}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={toolbarButtonStyle(false)}>Cancel</button>
          <button type="button" onClick={onSave} disabled={!value.trim()} style={{ ...primaryBuilderButtonStyle, opacity: value.trim() ? 1 : 0.65 }}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function BlockCatalogDialog({
  blocks,
  search,
  onSearch,
  onClose,
  onAdd,
}: {
  blocks: AppBlockRecommendation[];
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
  onAdd: (block: AppBlockRecommendation) => void;
}) {
  const filtered = blocks.filter((block) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return [block.name, block.description, block.domain, ...(block.tags ?? [])].join(' ').toLowerCase().includes(needle);
  });
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.36)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: 'min(860px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg, #fff)', color: 'inherit', borderRadius: 8, overflow: 'hidden', boxShadow: '0 18px 60px rgba(0,0,0,0.35)' }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.1))', display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>Add certified saved query</div>
          <button type="button" onClick={onClose} style={toolbarButtonStyle(false)}>Close</button>
        </div>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))' }}>
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search domain saved queries..."
            style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--border-color, rgba(0,0,0,0.12))', borderRadius: 6, padding: '8px 10px', background: 'var(--surface, transparent)', color: 'inherit' }}
          />
        </div>
        <div style={{ overflow: 'auto', padding: 12, display: 'grid', gap: 8 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 18, fontSize: 12, opacity: 0.66 }}>No certified saved queries match this App scope.</div>
          ) : filtered.map((block) => (
            <button
              key={block.id}
              type="button"
              onClick={() => onAdd(block)}
              style={{ textAlign: 'left', border: '1px solid var(--border-color, rgba(0,0,0,0.1))', borderRadius: 7, background: 'transparent', color: 'inherit', padding: 10, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{block.name}</span>
                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, background: 'rgba(63,185,80,0.14)', color: '#2ea043' }}>{block.status}</span>
                <span style={{ fontSize: 11, opacity: 0.68 }}>{block.domain}</span>
                <span style={{ fontSize: 11, opacity: 0.68 }}>{block.chartType ?? 'table'}</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.72 }}>{block.description || block.path}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScopedLineagePanel({ lineage }: { lineage: any | null }) {
  const nodes = lineage?.graph?.nodes ?? [];
  const edges = lineage?.graph?.edges ?? [];
  const breadcrumbs = lineage?.breadcrumbs ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', opacity: 0.62, marginBottom: 6 }}>App Lineage</div>
        <div style={{ fontSize: 12, opacity: 0.72 }}>Terms and business views connect the App back to saved queries, dbt models, and source tables.</div>
      </div>
      {breadcrumbs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {breadcrumbs.map((node: any, index: number) => (
            <div key={`${node.id}-${index}`} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 8, fontSize: 12 }}>
              <span style={{ fontFamily: 'monospace', opacity: 0.6 }}>{node.type}</span>
              <span>{node.name}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <LineageStat label="Nodes" value={nodes.length} />
        <LineageStat label="Edges" value={edges.length} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {nodes.slice(0, 18).map((node: any) => (
          <div key={node.id} style={{ border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 6, padding: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                style={{
                  color: '#0d1117',
                  background: NODE_TYPE_COLORS[node.type] ?? '#8b949e',
                  borderRadius: 3,
                  padding: '1px 4px',
                  fontSize: 11,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {TYPE_LABELS[node.type] ?? node.type.slice(0, 4).toUpperCase()}
              </span>
              <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</div>
            </div>
            <div style={{ fontSize: 11, opacity: 0.62, fontFamily: 'monospace', marginTop: 4 }}>
              {TYPE_TITLES[node.type] ?? node.type} · {node.id}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineageStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 6, padding: 8 }}>
      <div style={{ fontSize: 11, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export function getGeneratedVizOptions(
  item: DashboardLayoutItem,
  genUi?: DqlGenUiMetadata | null,
): Array<{ value: ChartType; label: string }> {
  const allowed = new Set<string>([
    'table',
    String(item.viz.type ?? 'table'),
    ...(genUi?.allowedVisualizations ?? []),
  ]);
  const values = Array.from(allowed)
    .map((value) => normalizeChartType(value))
    .filter((value, index, arr) => arr.indexOf(value) === index);
  return values
    .map((value) => APP_CHART_TYPE_OPTIONS.find((option) => option.value === value) ?? { value, label: formatGenUiLabel(value) });
}

function tileSurfaceForGenUi(component?: string): string {
  // Theme surfaces only: fixed white gradients made light text unreadable on dark themes.
  if (component === 'TrustCallout') return 'var(--dql-app-orange-soft, var(--dql-app-surface))';
  if (component === 'RankingPanel' || component === 'TrendPanel' || component === 'PivotTable') return 'var(--dql-app-surface)';
  if (component === 'BusinessBrief') return 'var(--dql-app-surface, rgba(255,255,255,0.90))';
  return 'var(--dql-app-surface, var(--surface, rgba(255,255,255,0.84)))';
}

/**
 * Persistent save state for a dashboard that autosaves.
 *
 * There is no Save button by design — layout and tile edits write immediately.
 * That is only a defensible design if the state is always visible, which it was
 * not: the old notice was an 11px 0.68-opacity string rendered only in edit
 * mode, and a failed save had no surface at all.
 */
function SaveStatus({
  saving,
  error,
  pending,
  notice,
  onDismissError,
}: {
  saving: boolean;
  error: string | null;
  pending: boolean;
  notice: string | null;
  onDismissError: () => void;
}): JSX.Element | null {
  if (error) {
    return (
      <div role="alert" style={saveStatusStyle('var(--status-error, #c45555)')}>
        <AlertTriangle size={13} />
        <span style={{ flex: 1, minWidth: 0 }}>Save failed — {error}</span>
        <button type="button" onClick={onDismissError} style={saveStatusDismissStyle}>Dismiss</button>
      </div>
    );
  }
  if (saving) {
    return <div role="status" style={saveStatusStyle('var(--text-secondary)')}><Loader2 size={13} /> Saving…</div>;
  }
  if (pending) {
    return (
      <div role="status" style={saveStatusStyle('var(--status-warning, #b8860b)')}>
        <AlertTriangle size={13} /> Layout preview not saved — Apply or Cancel to continue.
      </div>
    );
  }
  if (!notice) return null;
  return <div role="status" style={saveStatusStyle('var(--text-tertiary)')}><CheckCircle2 size={13} /> {notice}</div>;
}

const saveStatusStyle = (color: string): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '5px 12px',
  fontSize: 12,
  color,
  borderBottom: '1px solid var(--border-subtle)',
});

const saveStatusDismissStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
  textDecoration: 'underline',
  padding: 0,
};

/**
 * A distinct glyph per chart type.
 *
 * This had four branches for sixteen types, so ten of them — including KPI,
 * gauge, scatter and every stacked/grouped variant — drew the same bar icon.
 * `GeneratedVizSwitcher` renders one button per allowed visualization, so a
 * single tile could show seven identical bar glyphs in a row.
 */
export function iconForChartType(type: ChartType): JSX.Element {
  const props = { size: 13, strokeWidth: 2.2 } as const;
  switch (type) {
    case 'line': return <LineChart {...props} />;
    case 'area': return <ChartArea {...props} />;
    case 'pie': return <PieChart {...props} />;
    case 'donut': return <Donut {...props} />;
    case 'table': return <Table2 {...props} />;
    case 'kpi': return <Hash {...props} />;
    case 'gauge': return <Gauge {...props} />;
    case 'scatter': return <ChartScatter {...props} />;
    case 'heatmap': return <Grid3x3 {...props} />;
    case 'histogram': return <ChartColumnIncreasing {...props} />;
    case 'stacked-bar': return <ChartColumnStacked {...props} />;
    case 'grouped-bar': return <ChartColumnBig {...props} />;
    case 'funnel': return <Filter {...props} />;
    case 'waterfall': return <Activity {...props} />;
    case 'sankey': return <Workflow {...props} />;
    default: return <BarChart3 {...props} />;
  }
}

function componentLabelForGenUi(genUi: DqlGenUiMetadata): string {
  switch (genUi.component) {
    case 'BusinessBrief':
      return 'Business summary';
    case 'KpiMetric':
      return 'KPI';
    case 'TrendPanel':
      return 'Trend';
    case 'RankingPanel':
      return 'Ranking';
    case 'EvidenceTable':
      return 'Evidence';
    case 'PivotTable':
      return 'Pivot';
    case 'TrustCallout':
      return 'Trust';
    case 'ResearchActions':
      return 'Analysis';
    case 'NarrativePanel':
      return 'Narrative';
    default:
      return genUi.role ? formatGenUiLabel(genUi.role) : 'Generated';
  }
}

function extractGeneratedSummary(markdown: string, title: string): string {
  const titlePattern = new RegExp(`^###\\s*${escapeRegExp(title)}\\s*`, 'i');
  const cleaned = markdown
    .replace(titlePattern, '')
    .replace(/\*\*Trust:\*\*.*$/gim, '')
    .replace(/\*\*Review status:\*\*.*$/gim, '')
    .replace(/\*\*Next actions:\*\*[\s\S]*$/im, '')
    .replace(/\*\*Review tasks:\*\*[\s\S]*$/im, '')
    .trim();
  const paragraph = cleaned.split(/\n{2,}/).map((part) => part.trim()).find(Boolean);
  return paragraph || 'Generated app section pending analyst review.';
}

function toolbarButtonStyle(active: boolean): CSSProperties {
  return {
    border: '1px solid var(--dql-app-line, var(--border-color, rgba(0,0,0,0.12)))',
    borderRadius: 8,
    background: active ? 'var(--dql-app-accent-soft, var(--surface-hover, rgba(0,0,0,0.06)))' : 'var(--dql-app-surface, var(--surface, rgba(0,0,0,0.02)))',
    color: 'inherit',
    padding: '7px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
  };
}

function toolbarIconButtonStyle(active: boolean): CSSProperties {
  return { ...toolbarButtonStyle(active), width: 34, height: 34, padding: 0, justifyContent: 'center' };
}

const addTileIconButtonStyle: CSSProperties = {
  width: 34,
  height: 34,
  border: '1px solid var(--dql-app-accent, #4f46e5)',
  borderRadius: 8,
  background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.12))',
  color: 'var(--dql-app-accent, #4f46e5)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const dashboardToolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  marginBottom: 10,
  minWidth: 0,
};

const tileEvidenceButtonStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 7,
  background: 'var(--bg-1)',
  color: 'var(--text-secondary)',
  padding: '4px 8px',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
};

const tileRepairButtonStyle: CSSProperties = {
  ...tileEvidenceButtonStyle,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  color: 'var(--accent)',
  borderColor: 'var(--accent-dim)',
};

const tileEvidenceBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 120,
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  background: 'rgba(0, 0, 0, 0.38)',
};

const tileEvidencePanelStyle: CSSProperties = {
  width: 'min(780px, calc(100vw - 32px))',
  maxHeight: 'min(760px, calc(100vh - 48px))',
  overflow: 'hidden',
  display: 'grid',
  gap: 12,
  padding: 16,
  border: '1px solid var(--border-default)',
  borderRadius: 12,
  background: 'var(--bg-0)',
  color: 'var(--text-primary)',
  boxShadow: '0 24px 80px rgba(0,0,0,0.28)',
};

function tileEvidenceTabStyle(active: boolean): CSSProperties {
  return {
    border: active ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
    borderRadius: 7,
    background: active ? 'var(--accent-dim)' : 'var(--bg-1)',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    padding: '5px 9px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
  };
}

const tileEvidenceCodeStyle: CSSProperties = {
  margin: 0,
  minHeight: 180,
  padding: 14,
  borderRadius: 8,
  background: 'var(--bg-2)',
  color: 'var(--text-primary)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 12,
  lineHeight: 1.55,
};

const dashboardEditHintStyle: CSSProperties = {
  marginBottom: 12,
  color: 'var(--dql-app-muted, var(--color-text-secondary, rgba(0,0,0,0.64)))',
  fontSize: 12,
  lineHeight: 1.45,
};

const dashboardStoryStripStyle: CSSProperties = {
  border: '1px solid var(--dql-app-line-2, var(--border-color, rgba(15,23,42,0.10)))',
  borderRadius: 10,
  background: 'var(--dql-app-surface, var(--surface))',
  boxShadow: '0 8px 24px rgba(15,23,42,0.05)',
  padding: 14,
  marginBottom: 12,
  display: 'grid',
  gap: 9,
};

const dashboardStoryHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  minWidth: 0,
};

const dashboardStoryIconStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.10))',
  color: 'var(--dql-app-accent, #4f46e5)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const dashboardStoryKickerStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0,
  textTransform: 'uppercase',
  color: 'var(--dql-app-muted, rgba(15,23,42,0.58))',
};

const dashboardStoryTitleStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: 16,
  lineHeight: 1.25,
  fontWeight: 600,
  color: 'var(--dql-app-text, inherit)',
};

const dashboardStorySummaryStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.48,
  color: 'var(--dql-app-muted, rgba(15,23,42,0.72))',
};

const dashboardStoryChipRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const dashboardStoryChipStyle: CSSProperties = {
  border: '1px solid var(--dql-app-line, var(--border-color, rgba(15,23,42,0.10)))',
  borderRadius: 999,
  background: 'var(--dql-app-surface, rgba(255,255,255,0.78))',
  color: 'var(--dql-app-muted, rgba(15,23,42,0.68))',
  padding: '3px 8px',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.2,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const dashboardStorySourceChipStyle: CSSProperties = {
  ...dashboardStoryChipStyle,
  color: 'color-mix(in srgb, var(--dql-app-accent, #4f46e5) 80%, var(--text-primary, #1a1a1a))',
  borderColor: 'rgba(79,70,229,0.22)',
  background: 'var(--dql-app-accent-soft, rgba(79,70,229,0.08))',
};

const storyActionButtonStyle: CSSProperties = {
  border: '1px solid var(--dql-app-line-2, var(--border-color, rgba(15,23,42,0.14)))',
  borderRadius: 8,
  background: 'var(--dql-app-surface, var(--surface, #fff))',
  color: 'var(--dql-app-text, var(--text-primary, #0f172a))',
  padding: '6px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

function dashboardChatDrawerStyle(expanded: boolean): CSSProperties {
  return {
    position: 'fixed',
    right: 24,
    top: 76,
    bottom: 24,
    zIndex: 70,
    width: expanded
      ? `min(${AI_SIDE_PANEL_EXPANDED_WIDTH}px, calc(100vw - 96px))`
      : `min(${AI_SIDE_PANEL_WIDTH}px, calc(100vw - 64px))`,
    minWidth: 0,
  };
}

const dialogInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 6,
  background: 'var(--surface, transparent)',
  color: 'inherit',
  fontSize: 12,
  padding: '8px 10px',
};

const primaryBuilderButtonStyle: CSSProperties = {
  border: '1px solid var(--accent, #4f46e5)',
  borderRadius: 6,
  background: 'var(--accent, #4f46e5)',
  color: 'var(--color-text-on-accent, #fff)',
  padding: '7px 11px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
};

const addMenuItemStyle: CSSProperties = {
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  padding: '9px 10px',
  cursor: 'pointer',
  textAlign: 'left',
  display: 'grid',
  gap: 2,
};

const tileSettingsPanelStyle: CSSProperties = {
  position: 'fixed',
  top: 72,
  right: 16,
  bottom: 16,
  zIndex: 120,
  width: 'min(360px, calc(100vw - 32px))',
  boxSizing: 'border-box',
  border: '1px solid var(--border-default)',
  borderRadius: 12,
  padding: 14,
  background: 'var(--bg-0)',
  color: 'var(--text-primary)',
  boxShadow: '0 22px 70px rgba(15,23,42,0.22)',
  display: 'grid',
  alignContent: 'start',
  gap: 12,
  fontStyle: 'normal',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
};

const tileSettingsHeaderStyle: CSSProperties = {
  position: 'sticky',
  top: -14,
  zIndex: 2,
  margin: '-14px -14px 0',
  padding: '13px 14px 11px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  borderBottom: '1px solid var(--border-subtle)',
  background: 'var(--bg-0)',
};

const tileSettingsCloseStyle: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  border: '1px solid var(--border-subtle)',
  borderRadius: 7,
  background: 'var(--bg-1)',
  color: 'var(--text-secondary)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flex: 'none',
};

const tileSettingsSectionStyle: CSSProperties = {
  display: 'grid',
  gap: 9,
  padding: 12,
  border: '1px solid var(--border-subtle)',
  borderRadius: 9,
  background: 'var(--bg-1)',
};

const tileSettingsSectionHeadingStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.055em',
  color: 'var(--text-tertiary)',
};

const tileSettingsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
};

const tileSettingsLabelStyle: CSSProperties = {
  display: 'grid',
  gap: 3,
  fontSize: 11,
  fontWeight: 600,
  opacity: 0.78,
};

const tileSettingsInputStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 5,
  background: 'var(--surface, transparent)',
  color: 'inherit',
  padding: '5px 6px',
  fontSize: 11,
};

const tileDisplayContractStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  paddingTop: 9,
};

const tileSettingsDetailsStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 9,
  background: 'var(--bg-1)',
  padding: '0 12px 11px',
};

const tileSettingsSummaryStyle: CSSProperties = {
  cursor: 'pointer',
  padding: '11px 0 0',
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 600,
};

function recommendButtonStyle(busy: boolean): CSSProperties {
  return {
    border: '1px solid var(--accent, rgba(79,70,229,0.55))',
    background: busy ? 'rgba(79,70,229,0.10)' : 'rgba(79,70,229,0.08)',
    color: 'var(--accent, #4f46e5)',
    borderRadius: 5,
    padding: '5px 7px',
    fontSize: 11,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.72 : 1,
    whiteSpace: 'nowrap',
  };
}

const recommendNoteStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: 'var(--dql-app-muted, rgba(15,23,42,0.68))',
};

const recommendErrorStyle: CSSProperties = {
  ...recommendNoteStyle,
  color: 'var(--error-color, #b91c1c)',
};

const fieldChipStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 4,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  color: 'inherit',
  padding: '2px 5px',
  fontSize: 11,
  cursor: 'pointer',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const generatedMetaRowStyle: CSSProperties = {
  marginTop: 7,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 5,
  alignItems: 'center',
  minWidth: 0,
};

const generatedMetaPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 18,
  borderRadius: 999,
  border: '1px solid var(--border-color, rgba(15,23,42,0.10))',
  background: 'rgba(148,163,184,0.10)',
  color: 'var(--dql-app-muted, rgba(15,23,42,0.70))',
  padding: '2px 7px',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.1,
};

function trustPillStyle(certified: boolean): CSSProperties {
  return {
    ...generatedMetaPillStyle,
    // Certified shares the brand teal (RFC 0008); review is the status amber.
    border: `1px solid color-mix(in srgb, var(${certified ? '--trust-certified' : '--trust-review'}) 32%, transparent)`,
    background: `color-mix(in srgb, var(${certified ? '--trust-certified' : '--trust-review'}) 10%, transparent)`,
    // Words in the trust colour's ink (mixed toward the text) so they read at 4.5:1 on its tint.
    color: `color-mix(in srgb, var(${certified ? '--trust-certified' : '--trust-review'}) ${certified ? 80 : 60}%, var(--text-primary, #1a1a1a))`,
    gap: 4,
  };
}

const generatedVizSwitcherStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  border: '1px solid var(--border-color, rgba(15,23,42,0.12))',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.74)',
  flexShrink: 0,
};

function generatedVizButtonStyle(active: boolean): CSSProperties {
  return {
    width: 24,
    height: 24,
    border: 'none',
    borderRadius: 4,
    background: active ? 'var(--dql-app-accent, var(--accent, #4f46e5))' : 'transparent',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  };
}

function generatedTextTileStyle(isTrust: boolean): CSSProperties {
  return {
    width: '100%',
    alignSelf: 'stretch',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    fontStyle: 'normal',
    opacity: 1,
    lineHeight: 1.45,
    borderRadius: 6,
    padding: isTrust ? 10 : 0,
    background: isTrust ? 'rgba(245,158,11,0.08)' : 'transparent',
  };
}

function generatedTextIconStyle(isTrust: boolean): CSSProperties {
  return {
    width: 30,
    height: 30,
    borderRadius: 7,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: isTrust ? 'rgba(245,158,11,0.14)' : 'rgba(79,70,229,0.10)',
    color: isTrust ? '#b45309' : 'var(--dql-app-accent, var(--accent, #4f46e5))',
  };
}

const generatedActionChipStyle: CSSProperties = {
  ...generatedMetaPillStyle,
  background: 'rgba(79,70,229,0.08)',
  color: 'var(--dql-app-accent, var(--accent, #4f46e5))',
  border: '1px solid rgba(79,70,229,0.16)',
};

const generatedEvidenceStyle: CSSProperties = {
  width: '100%',
  alignSelf: 'stretch',
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 9,
  fontStyle: 'normal',
  opacity: 1,
  lineHeight: 1.35,
};

const generatedEvidenceRowsStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
};

const generatedEvidenceRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: 7,
  alignItems: 'start',
  border: '1px solid var(--border-color, rgba(15,23,42,0.09))',
  borderRadius: 7,
  background: 'rgba(255,255,255,0.56)',
  padding: '7px 8px',
};

const generatedEvidenceMiniPillStyle: CSSProperties = {
  ...generatedMetaPillStyle,
  minHeight: 16,
  borderRadius: 5,
  padding: '1px 5px',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const generatedEvidenceMetricStyle: CSSProperties = {
  display: 'grid',
  gap: 1,
  minWidth: 82,
  textAlign: 'left',
  fontSize: 11,
};

const generatedEvidenceStatusStyle: CSSProperties = {
  ...generatedMetaPillStyle,
  minHeight: 18,
  background: 'rgba(22,163,74,0.09)',
  border: '1px solid rgba(22,163,74,0.18)',
  color: '#15803d',
};

const iconTileButtonStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 5,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, rgba(255,255,255,0.72))',
  color: 'inherit',
  cursor: 'pointer',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const dragHandleButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, rgba(255,255,255,0.72))',
  color: 'inherit',
  cursor: 'grab',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const tileSizeMenuStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 40,
  width: 240,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 8,
  background: 'var(--color-bg, #fff)',
  boxShadow: '0 14px 38px rgba(0,0,0,0.16)',
  padding: 6,
  display: 'grid',
  gap: 4,
};

const tileSizeMenuItemStyle: CSSProperties = {
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  padding: '8px 9px',
  cursor: 'pointer',
  textAlign: 'left',
  display: 'grid',
  gap: 2,
};

function sizePresetChipStyle(active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? 'var(--accent, #4f46e5)' : 'var(--border-color, rgba(0,0,0,0.12))'}`,
    borderRadius: 999,
    background: active ? 'var(--color-bg-active, rgba(79,70,229,0.12))' : 'var(--surface, rgba(0,0,0,0.02))',
    color: active ? 'var(--accent, #4f46e5)' : 'inherit',
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: active ? 750 : 600,
    cursor: 'pointer',
  };
}

const segmentedControlStyle: CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 5,
  overflow: 'hidden',
  background: 'var(--surface, rgba(255,255,255,0.66))',
};

function segmentPillStyle(active: boolean): CSSProperties {
  return {
    width: 24,
    height: 24,
    border: 'none',
    borderRight: '1px solid var(--border-color, rgba(0,0,0,0.08))',
    background: active ? 'var(--accent, #4f46e5)' : 'transparent',
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
    padding: 0,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: active ? 800 : 600,
  };
}

const miniButtonStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 4,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  color: 'inherit',
  padding: '3px 7px',
  cursor: 'pointer',
  fontSize: 11,
};

function nextTilePosition(
  dashboard: DashboardDocumentResponse['dashboard'],
  size: { w: number; h: number } = { w: 6, h: 3 },
): { x: number; y: number; w: number; h: number } {
  const y = dashboard.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return { x: 0, y, w: size.w, h: size.h };
}

function nextTileId(dashboard: DashboardDocumentResponse['dashboard'], raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tile';
  const used = new Set(dashboard.layout.items.map((item) => item.i));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Deterministic compatibility projection for v1 dashboards and v2 documents
 * that have not yet saved an explicit medium/narrow override. */
export function projectDashboardItems(items: DashboardLayoutItem[], cols: number): DashboardLayoutItem[] {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return [...items]
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((item) => {
      const width = cols === 1 ? 1 : Math.min(cols, Math.max(2, Math.ceil(item.w / 2)));
      if (x + width > cols) {
        x = 0;
        y += rowHeight || item.h;
        rowHeight = 0;
      }
      const projected = { ...item, x, y, w: width };
      x += width;
      rowHeight = Math.max(rowHeight, item.h);
      return projected;
    });
}

// Gap-free 2D first-fit packer: places each tile (in order) at the topmost,
// then leftmost, free slot so later tiles backfill whitespace left by wider
// tiles above them. Keeps a clean, dense enterprise grid.
