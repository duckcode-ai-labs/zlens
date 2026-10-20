import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
  Activity, Archive, ArrowLeft, ArrowRight, BarChart3, Blocks, Bot, Check, ChevronDown, Code2, Copy, FileText, Filter,
  Gauge, Heading, LayoutDashboard, LineChart, Monitor, MoreHorizontal, PanelRight,
  Play, Plus, Redo2, ScatterChart, Search, Settings2, ShieldCheck, Smartphone, Sparkles, Table2,
  Trash2, Type, Undo2, Upload, X,
} from 'lucide-react';
import {
  api, DqlApiError,
  type AppBlockRecommendation,
  type AppAutopilotChangeProposal,
  type AppStudioAiProposal,
  type AppStudioBuildDraft,
  type AppStudioDraftOperation,
  type StoryDraftResponseV1,
  type CanvasDraftResponseV1,
  type ContextAuthoringProposalV1,
  type DatasetAuthoringChange,
  type DatasetTileSaveAsBlockResponse,
  type SemanticTileConversionPreviewResponse,
  type DashboardDatasetHierarchyDrill,
  type DashboardRunResponse,
} from '../../api/client';
import type {
  DatasetDescriptor,
  DatasetField,
} from '@zlens/core/datasets/descriptor';
import {
  datasetTileVisualizationCompatibility,
  tileQueryOutputAliases,
  tileQueryValidationRuns,
  validateTileQuery,
  type TileQuery,
} from '@zlens/core/apps/tile-query';
import type { AppSummary } from '../../store/types';
import type { CellChartConfig, QueryResult } from '../../store/types';
import type { ThemeMode } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import { AiSidePanel } from '../agent/AiSidePanel';
import { DatasetSourceAuthoringDialog, DatasetSourceRebindReviewDialog } from './builder/DatasetProposalDialog';
import { DatasetTileBuilder } from './builder/DatasetTileBuilder';
import { DataPanel, type DataPanelTarget } from './builder/DataPanel';
import { DraftTileCard, DraftTileInspector, draftVisualization, type DraftTileState } from './builder/DraftTile';
import { encodedChartConfig, encodedTileResult } from './dashboard-chart-config';
import { ProposedTileCard } from './builder/ProposedTile';
import { ChartStylePanel, compactVizStyle } from './builder/ChartStylePanel';
import { DriverView } from './DriverView';
import { StoryView } from './StoryView';
import { StoryEditor } from './builder/StoryEditor';
import { CanvasEditor } from './builder/CanvasEditor';
import { PageFormatPicker } from './builder/PageFormatPicker';
import { CanvasPageFrame, type CanvasFrameEditing } from './CanvasPageFrame';
import { checkCanvasHtml, insertCanvasNodes, parseCanvasHtml, serializeCanvasNodes, type CanvasNode } from '@zlens/core/apps/canvas-page';
import { buildStoryBindingCatalog, type StoryBindingTileInput } from '@zlens/core/apps/story-bindings';
import { DriverTileSettings } from './builder/DriverTileSettings';
import { driverProbeFor, filtersForNewDriverTile } from './driver-probe';
import {
  CANVAS_COLUMNS,
  CANVAS_GAP_PX,
  canvasRowHeight,
  canvasShortcut,
  cellsFromPixels,
  copyTileId,
  incrementalPreviewPlan,
  loadStudioHistory,
  saveStudioHistory,
  tileBodyHeight,
  type CanvasShortcut,
} from './builder/canvas-interactions';
import { firstFreeGridCell, moveGridItem, nudgeGridItem, placeGridCopy, resizeGridItem, settleGridLayout } from '@zlens/core/apps/grid-layout';
import { projectProposal, type ProposedPage } from './builder/proposal-preview';
import { EMPTY_TILE_QUERY, autoTileView, defaultTileTitle, descriptorTimeField, descriptorTimeGrain, isTimeField, tileVisualization, toggleFieldInQuery, vizTypeForEncoding } from './builder/field-query';
import { addFieldByClick, encodingFromQuery, encodingHas, queryFromEncoding, removeField } from '@zlens/core/apps/viz-encoding';
import type { ShelfChange } from './builder/ShelfEditor';
import type { DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';
import { applyShowMe, showMeFactsFromDescriptor, showMeFirstChoice, showMeInputFromQuery } from '@zlens/core/apps/show-me';
import { pivotLayout, withPivotRollups, withoutRollups, type PivotTotals } from '@zlens/core/apps/pivot';
import { PivotTable } from './PivotTable';
import { TableDatasetDialog } from './builder/TableDatasetDialog';
import { KpiCard, usesKpiCard } from './KpiCard';

/** A pivot shows every group; a row limit would cut its totals off. */
function withoutRowLimit(query: TileQuery): TileQuery {
  const { limit: _limit, ...rest } = query;
  return rest;
}
import { useMarkInteractions } from './useMarkInteractions';
import { numberReceiptInfo } from './NumberReceipt';
import type { MarkPointer } from '../output/echarts/EChartsChart';
import { ShowMePanel, currentShowMeChart, tileShowMe } from './builder/ShowMe';
import { FiltersPanel, mergeStudioDateRanges, linkedComponentCount, type StudioFilterConfiguration } from './builder/GlobalFilterBar';
import { DatasetInteractionInspector, DatasetTileQueryInspector } from './builder/InteractionLayer';
import { humanize, messageOf } from './builder/studio-ui';
import { usePersistedAgentThreadId } from '../agent/usePersistedAgentThreadId';
import { ContextProposalReviewDrawer } from '../modeling/ContextProposalReviewDrawer';
import { ChartOutput } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { APP_STUDIO_V2_STYLES } from './app-studio-v2-styles';
import {
  APP_STUDIO_AI_ACTIVITY_LABELS,
  appStudioProposalRetry,
  appStudioReviewAddRetry,
  appStudioRevisionRetry,
  appStudioSourceActionLabel,
  nextAppStudioAiActivityIndex,
  type AppStudioAiActivityRetry,
  type AppStudioSourceActionStatus,
} from './app-studio-ai-activity';
import {
  appStudioProposalRequestSourceIds,
  appStudioProposalSourceAddMode,
  appStudioProposalRequiredSourceIds,
  appStudioPlannerProvenanceLabel,
  availableAppStudioProposalSources,
  summarizeAppStudioAiPlan,
  operationsForSelectedAppStudioSources,
  type AppStudioAiPlanSummary,
} from './app-studio-ai-plan';
import {
  datasetFilterBindingsForSelection,
  discoverAppFilterCandidates,
  filterTileMappingsForField,
  type StudioRuntimeFilterFields,
} from './app-studio-filter-candidates';
import {
  hydrateAppScopedDashboardFilterValues,
  isAppScopedDashboardFilter,
  pagesForDashboardFilterValue,
} from './app-dashboard-filter-scope';
import { formatDatasetGrainEvidenceKeyCheck } from './dataset-grain-evidence';
import { datasetOptionSource } from './app-dashboard-filters';
import {
  appendDatasetHierarchyDrill,
  datasetMarkActions,
  datasetMarkSelectionForRow,
  carriedNavigationVariables,
  popDatasetHierarchyDrill,
  proposeDatasetCrossFilterLinks,
  type DatasetCrossFilterLinkProposal,
  type RuntimeDatasetHierarchyDrillCandidate,
} from './app-dataset-interactions';
import { retiredTileNotice } from './tile-retirement';
import {
  datasetTileNotices,
  isCurrentDatasetTileEvidence,
  presentDatasetTileEvidence,
  type DatasetEvidenceRow,
  type DatasetTileEvidencePresentation,
} from './dataset-tile-evidence';
import {
  blockingPublicationReviewTasks,
  isDatasetBackedAppSource,
  legacySemanticTilesNeedingApproval,
  localPublicationSteps,
  pagesNeedingSettledPreview,
  planLegacySemanticApproval,
  publicationBlockerCount,
  publicationBlockingSources,
  publicationIssueSummaries,
  unresolvedPublicationRequirements,
} from './app-studio-publish-readiness';
import {
  isDatasetSourceRecoveryTask,
  runDatasetSourceRecoveryAction,
} from './app-dataset-source-recovery';
import {
  runDatasetSourceRebindAction,
} from './app-dataset-source-rebind';
import {
  datasetSourceAuthoringModel,
} from './app-dataset-source-authoring';
import {
  mergeStudioPartialPreview,
  settleStudioPreviewRun,
  withoutPagePreviewReceipt,
} from './app-studio-preview-settlement';
import { PublishedAppAudience } from './AppAudienceEditor';

// Moved to builder/; re-exported for existing callers and tests.
export { DatasetSourceAuthoringDialog, DatasetSourceRebindReviewDialog, DatasetTileBuilder };

const UnifiedAgentRunPanel = lazy(() => import('../agent/UnifiedAgentRunPanel')
  .then((module) => ({ default: module.UnifiedAgentRunPanel })));

type StudioPanel = 'pages' | 'sources' | 'filters' | 'templates';
type StudioBreakpoint = 'wide' | 'medium' | 'narrow';
type StudioPreviewMode = 'auto' | StudioBreakpoint;
type StudioTemplate = AppStudioBuildDraft['template'];

type StudioFilterAvailability = {
  values: string[];
  truncated: boolean;
  valueCount?: number;
  dateRange?: { min: string; max: string };
};

/**
 * App Studio uses the current preview only to decide whether its repair
 * shortcut is useful. The server repeats the same authority check before it
 * ever dispatches a provider, so this never authorizes a repair by itself.
 */
export type AppAutopilotRepairShortcutAvailability = 'failed_tile' | 'healthy' | 'preview_required';

type AppAutopilotPrompt = { label: string; prompt: string };

export function appAutopilotRepairShortcutAvailability(
  selectedTile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] | null,
  previewRun: DashboardRunResponse | null,
): AppAutopilotRepairShortcutAvailability {
  if (!selectedTile?.sourceId || !selectedTile.query || !previewRun || previewRun.stale || previewRun.partial) {
    return 'preview_required';
  }
  const previewTile = previewRun.tiles.find((tile) => tile.tileId === selectedTile.i && tile.tileType === 'dataset');
  if (previewTile?.status === 'error') return 'failed_tile';
  if (previewTile?.status === 'ok') return 'healthy';
  return 'preview_required';
}

export function appAutopilotExamplePrompts(
  repairAvailability: AppAutopilotRepairShortcutAvailability,
): AppAutopilotPrompt[] {
  const prompts: AppAutopilotPrompt[] = [
    { label: 'Group selected tile', prompt: 'Group the selected chart by Region.' },
    { label: 'Explain selected tile', prompt: 'Explain what the selected Dataset tile can show and which approved fields support it.' },
  ];
  if (repairAvailability === 'failed_tile') {
    prompts.push({ label: 'Repair selected tile', prompt: 'What is the smallest governed repair needed before this selected tile can answer its intended question?' });
  }
  return prompts;
}

function appAutopilotRepairShortcutHint(
  repairAvailability: AppAutopilotRepairShortcutAvailability,
): string {
  if (repairAvailability === 'healthy') {
    return 'The current preview is healthy, so there is no failed Dataset tile to repair. You can still change its title, layout, grouping, or visualization.';
  }
  if (repairAvailability === 'failed_tile') {
    return 'This tile failed in the current preview. AI can prepare a governed repair for you to review.';
  }
  return 'Run a preview before asking AI to repair a failed tile.';
}

/** Runtime-only selection from an actual settled Dataset result. The source
 * identity is retained so the server can reject a stale or mismatched tile. */
type StudioDatasetCrossFilter = {
  fromTileId: string;
  fromSourceId: string;
  fromSourceRevision: string;
  field: string;
  values: unknown[];
  exclude?: boolean;
};

type AppStudioAiActivity = {
  status: 'running' | 'error';
  retry: AppStudioAiActivityRetry;
  returnToProposal: boolean;
  error?: string;
};

type AppStudioSourceFeedback = {
  sourceId: string;
  status: Exclude<AppStudioSourceActionStatus, 'idle'>;
  view: 'KPI' | 'Chart' | 'Table';
  pageTitle: string;
  message?: string;
};

export interface AppStudioLaunchConfig {
  mode: 'ai' | 'manual';
  prompt: string;
  name: string;
  template: StudioTemplate;
  sourcePolicy: AppStudioBuildDraft['sourcePolicy'];
}

export interface AppStudioV2Props {
  initialMode: 'ai' | 'manual';
  initialPrompt: string;
  initialName?: string;
  initialDraftId?: string | null;
  initialSourcePolicy?: AppStudioBuildDraft['sourcePolicy'];
  initialTemplate?: StudioTemplate;
  startImmediately?: boolean;
  baseAppId?: string | null;
  domain?: string;
  audience?: string;
  themeMode: ThemeMode;
  onBack: () => void;
  onPublished: (app: AppSummary, dashboardId?: string) => void;
  onDraftDeleted: (recovery: { appName: string; recoveryId: string }) => void;
}

const TEMPLATE_OPTIONS: Array<{ id: StudioTemplate; title: string; description: string }> = [
  { id: 'executive_brief', title: 'Executive Brief', description: 'Editorial summary, KPI band, decision evidence, and appendix.' },
  { id: 'operational_dashboard', title: 'Operational Dashboard', description: 'Filters, KPIs, trends, drivers, and operating detail.' },
  { id: 'investigation', title: 'Investigation', description: 'Question, findings, comparisons, caveats, and evidence.' },
  { id: 'blank', title: 'Blank canvas', description: 'Start with one clean responsive page.' },
];

export function AppStudioLaunchSurface({
  config,
  busy = false,
  error,
  onChange,
  onSubmit,
}: {
  config: AppStudioLaunchConfig;
  busy?: boolean;
  error?: string | null;
  onChange: (patch: Partial<AppStudioLaunchConfig>) => void;
  onSubmit: () => void;
}): JSX.Element {
  const canSubmit = config.mode === 'ai' ? Boolean(config.prompt.trim()) : Boolean(config.name.trim());
  return <section className="dql-app-studio-home" aria-labelledby="app-studio-home-title">
    <style>{APP_STUDIO_V2_STYLES}</style>
    <div className="dql-studio-v2-intro">
      <span className="eyebrow"><Sparkles size={14} /> ZLens App Studio 2.0</span>
      <h1 id="app-studio-home-title">Start with the decision.<br />Shape the experience together.</h1>
      <p>Build with AI or by hand. Everything stays a private draft until you publish it.</p>
    </div>
    <div className="dql-studio-v2-start-card">
      <div className="mode-switch" role="tablist" aria-label="Authoring mode">
        <button type="button" role="tab" aria-selected={config.mode === 'ai'} className={config.mode === 'ai' ? 'on' : ''} onClick={() => onChange({ mode: 'ai', template: config.template === 'blank' ? 'operational_dashboard' : config.template })}><Sparkles size={16} /> Describe with AI</button>
        <button type="button" role="tab" aria-selected={config.mode === 'manual'} className={config.mode === 'manual' ? 'on' : ''} onClick={() => onChange({ mode: 'manual', template: 'blank', name: config.name || 'Untitled Analytics App' })}><LayoutDashboard size={16} /> Start manually</button>
      </div>
      <label className="primary-field">
        <span>{config.mode === 'ai' ? 'What decision should this App support?' : 'What should this App be called?'}</span>
        {config.mode === 'ai'
          ? <textarea value={config.prompt} onChange={(event) => onChange({ prompt: event.target.value })} placeholder="Build a weekly revenue health App for finance leaders with trends, drivers, and customer detail." rows={4} />
          : <input value={config.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="Revenue Operations" />}
      </label>
      {config.mode === 'ai' ? <div className="ai-launch-explainer"><span><Sparkles size={16} /></span><div><strong>AI picks your certified data and drafts a first version</strong><small>You review the data it chose and every tile before anything is applied.</small></div></div> : null}
      <details className="launch-options" open={config.mode === 'manual'}>
        <summary><span>Starting layout</span><strong>{TEMPLATE_OPTIONS.find((option) => option.id === config.template)?.title ?? 'Operational Dashboard'}</strong><ChevronDown size={15} /></summary>
        <div className="template-grid">
          {TEMPLATE_OPTIONS.map((option) => <button key={option.id} type="button" className={config.template === option.id ? 'on' : ''} onClick={() => onChange({ template: option.id })}><span>{templateIcon(option.id)}</span><strong>{option.title}</strong><small>{option.description}</small></button>)}
        </div>
      </details>
      <section className="studio-source-policy-row" aria-label="App source policy">
        <header><span className="policy-mark"><ShieldCheck size={17} /></span><p><strong>Only certified data</strong><small>Every number comes from data someone owns and checked. Recommended.</small></p></header>
        <label className="studio-review-toggle"><input type="checkbox" checked={config.sourcePolicy === 'include_review_required'} onChange={(event) => onChange({ sourcePolicy: event.target.checked ? 'include_review_required' : 'governed_only' })} /><i aria-hidden="true" /><span><strong>Also let me try data that needs review</strong><small>Useful while exploring; a page that uses it cannot publish until that data is certified.</small></span></label>
      </section>
      {error ? <div className="studio-error" role="alert">{error}</div> : null}
      <button type="button" className="launch-action" onClick={onSubmit} disabled={busy || !canSubmit}>{busy ? 'Preparing local draft…' : config.mode === 'ai' ? <><Sparkles size={17} /> Generate editable App</> : <><LayoutDashboard size={17} /> Open blank Studio</>}</button>
      <small className="launch-next-step">Private local draft first · review sources and preview results · publish only when ready</small>
    </div>
  </section>;
}

function AppStudioAiActivitySurface({
  docked = false,
  activity,
  label,
  onBack,
  onReturn,
  onRetry,
}: {
  /** In the Studio's right column instead of full screen. */
  docked?: boolean;
  activity: AppStudioAiActivity;
  label: string;
  onBack: () => void;
  onReturn?: () => void;
  onRetry: () => void;
}): JSX.Element {
  return <section className={`${docked ? 'studio-ai-activity-docked' : 'dql-studio-v2-loading'} studio-ai-activity`} aria-labelledby="studio-ai-activity-title" aria-busy={activity.status === 'running'}>
    {docked ? null : <style>{APP_STUDIO_V2_STYLES}</style>}
    {docked ? null : <button type="button" className="icon" onClick={onBack} aria-label="Back to Apps"><ArrowLeft size={18} /></button>}
    <div>
      <span className="loading-mark"><Sparkles size={20} /></span>
      {activity.status === 'running' ? <>
        <strong id="studio-ai-activity-title">{docked ? 'Drafting a plan' : 'Preparing your editable App proposal'}</strong>
        <small className="studio-ai-activity-label" role="status" aria-live="polite">{label}</small>
        <small>{docked ? 'Proposed tiles appear on the canvas for you to apply or discard. Sources keep their catalog trust.' : 'Data stays Certified or Needs review exactly as cataloged. You review it before the canvas is generated.'}</small>
      </> : <>
        <strong id="studio-ai-activity-title">The source proposal needs another try</strong>
        <small role="alert">{activity.error ?? 'App Studio could not prepare the source proposal.'}</small>
        <span className="studio-ai-activity-actions">{onReturn ? <button type="button" onClick={onReturn}>Back to source review</button> : null}<button type="button" className="primary" onClick={onRetry}>Try AI proposal again</button></span>
      </>}
    </div>
  </section>;
}

export function AppStudioV2({
  initialMode,
  initialPrompt,
  initialName = '',
  initialDraftId,
  initialSourcePolicy = 'governed_only',
  initialTemplate,
  startImmediately = false,
  baseAppId,
  domain,
  audience,
  themeMode,
  onBack,
  onPublished,
  onDraftDeleted,
}: AppStudioV2Props): JSX.Element {
  const [draft, setDraft] = useState<AppStudioBuildDraft | null>(null);
  /** The App's domain, stored on its first page when the draft is created; `general` means every domain. */
  const draftDomain = appDraftDomain(draft);
  const [mode, setMode] = useState<'ai' | 'manual'>(initialMode);
  const [sourcePolicy, setSourcePolicy] = useState<AppStudioBuildDraft['sourcePolicy']>(initialSourcePolicy);
  const [template, setTemplate] = useState<StudioTemplate>(initialTemplate ?? (initialMode === 'manual' ? 'blank' : 'operational_dashboard'));
  const [prompt, setPrompt] = useState(initialPrompt);
  const [name, setName] = useState(initialName);
  const [panel, setPanel] = useState<StudioPanel>('sources');
  const [panelOpen, setPanelOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 820);
  const [previewMode, setPreviewMode] = useState<StudioPreviewMode>('auto');
  const [workspaceWidth, setWorkspaceWidth] = useState(1260);
  const [activePageId, setActivePageId] = useState('overview');
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<AppBlockRecommendation | null>(null);
  const [catalog, setCatalog] = useState<AppBlockRecommendation[]>([]);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogNextCursor, setCatalogNextCursor] = useState<string | undefined>();
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogRefreshNonce, setCatalogRefreshNonce] = useState(0);
  // Start from a table: the dialog, and the new Dataset to open once the catalog lists it.
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [pendingDatasetSourceId, setPendingDatasetSourceId] = useState<string | null>(null);
  // Field-based tiles are on unless the project sets `apps.datasets: false`.
  const [datasetTilesEnabled, setDatasetTilesEnabled] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<AppStudioAiProposal | null>(null);
  /** Proposed tiles the author declined; cleared whenever the proposal changes. */
  const [skippedProposalTileIds, setSkippedProposalTileIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Page AI adds to the open page unless the author asks to rebuild it. */
  const [replacePageWithAi, setReplacePageWithAi] = useState(false);
  useEffect(() => { setSkippedProposalTileIds(new Set()); }, [proposal?.id]);
  const [selectedProposalSourceIds, setSelectedProposalSourceIds] = useState<Set<string>>(new Set());
  const [proposalAddingSourceId, setProposalAddingSourceId] = useState<string | null>(null);
  const [aiActivity, setAiActivity] = useState<AppStudioAiActivity | null>(null);
  const [aiActivityIndex, setAiActivityIndex] = useState(0);
  const [sourceFeedback, setSourceFeedback] = useState<AppStudioSourceFeedback | null>(null);
  const [undoStack, setUndoStack] = useState<AppStudioBuildDraft[]>([]);
  const [redoStack, setRedoStack] = useState<AppStudioBuildDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState('Local draft');
  const [previewRunsByPage, setPreviewRunsByPage] = useState<Record<string, DashboardRunResponse>>({});
  const [previewing, setPreviewing] = useState(false);
  const [savingDatasetTileId, setSavingDatasetTileId] = useState<string | null>(null);
  const [replacingDatasetTileId, setReplacingDatasetTileId] = useState<string | null>(null);
  const [previewingSemanticConversionTileId, setPreviewingSemanticConversionTileId] = useState<string | null>(null);
  const [acceptingSemanticConversionTileId, setAcceptingSemanticConversionTileId] = useState<string | null>(null);
  /** Saved review drafts are local UI affordances, never source authority. */
  const [savedDatasetReviewDrafts, setSavedDatasetReviewDrafts] = useState<Record<string, Extract<DatasetTileSaveAsBlockResponse, { ok: true }>>>({});
  const [semanticTileConversionPreviews, setSemanticTileConversionPreviews] = useState<Record<string, Extract<SemanticTileConversionPreviewResponse, { ok: true }>>>({});
  // App-scoped selections are separate from page values. A page added after a
  // selection should hydrate from this state only when it declares the App
  // control; same-id page-local controls remain local.
  const [previewAppScopedFilterValues, setPreviewAppScopedFilterValues] = useState<Record<string, unknown>>({});
  const [previewVariablesByPage, setPreviewVariablesByPage] = useState<Record<string, Record<string, unknown>>>({});
  const [previewCrossFiltersByPage, setPreviewCrossFiltersByPage] = useState<Record<string, StudioDatasetCrossFilter[]>>({});
  /** Read-only hierarchy exploration state. This is never serialized into the App draft. */
  const [previewHierarchyDrillsByPage, setPreviewHierarchyDrillsByPage] = useState<Record<string, DashboardDatasetHierarchyDrill[]>>({});
  const [filterOptionsByPage, setFilterOptionsByPage] = useState<Record<string, Record<string, StudioFilterAvailability>>>({});
  /** A move or resize in progress on the canvas; its items are drawn until the save lands. */
  const [gesture, setGesture] = useState<CanvasGesture | null>(null);
  /** A story drafted by AI (or from the data), shown until applied or discarded. */
  const [storyProposal, setStoryProposal] = useState<{ pageId: string; result: StoryDraftResponseV1 } | null>(null);
  const [storyDrafting, setStoryDrafting] = useState(false);
  const [canvasProposal, setCanvasProposal] = useState<{ pageId: string; result: CanvasDraftResponseV1 } | null>(null);
  const [canvasDrafting, setCanvasDrafting] = useState(false);
  const lastStoryModel = storyProposal?.result.model ?? null;
  /** The draft whose undo history has been restored from this browser. */
  const [historyDraftId, setHistoryDraftId] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [publishReviewOpen, setPublishReviewOpen] = useState(false);
  const [publishIssues, setPublishIssues] = useState<string[]>([]);
  const [datasetAuthoringSource, setDatasetAuthoringSource] = useState<AppBlockRecommendation | null>(null);
  const [datasetAuthoringProposal, setDatasetAuthoringProposal] = useState<ContextAuthoringProposalV1 | null>(null);
  const [datasetRebindPrompt, setDatasetRebindPrompt] = useState<{ sourceId: string; title: string } | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  /** Edit shows the build chrome; View shows the page exactly as a reader sees it. */
  const [studioView, setStudioView] = useState<'edit' | 'view'>('edit');
  /** The tile whose ⋯ menu is open. */
  const [tileMenuId, setTileMenuId] = useState<string | null>(null);
  /** App-level settings (decision, source policy, review tasks) open in the right column. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** A tile being built from fields; it lives on the canvas until added or cancelled. */
  const [draftTile, setDraftTile] = useState<DraftTileState | null>(null);
  const [draftResult, setDraftResult] = useState<QueryResult | undefined>();
  /** Dataset the author picked in the Data panel (a selected tile's Dataset wins). */
  const [chosenDatasetKey, setChosenDatasetKey] = useState<string | null>(null);
  /** The Data tab shows one Dataset's fields, or the full governed source catalog. */
  const [dataView, setDataView] = useState<'fields' | 'sources'>('fields');
  /** Page shown on the canvas while an AI proposal is open (it may be a proposed new page). */
  const [proposalPageId, setProposalPageId] = useState<string | null>(null);
  /** One AI entry point: compose or revise the page, or change the selected tile. */
  const [aiScope, setAiScope] = useState<'page' | 'tile'>('page');
  /** The tile whose query and compiled SQL are shown inline on the canvas. */
  const [dqlTileId, setDqlTileId] = useState<string | null>(null);
  const [copilotExpanded, setCopilotExpanded] = useState(false);
  const [copilotRunning, setCopilotRunning] = useState(false);
  const [autopilotTileSelectionRequested, setAutopilotTileSelectionRequested] = useState(false);
  /** An immutable universal AgentRun artifact, never an App-side chat draft. */
  const [autopilotReview, setAutopilotReview] = useState<AppAutopilotChangeProposal | null>(null);
  const gestureRef = useRef<CanvasGesture | null>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Set each render once the canvas state is known; the listeners below call through it. */
  const canvasKeyHandlerRef = useRef<((event: KeyboardEvent) => void) | null>(null);
  const commitGestureRef = useRef<((gesture: CanvasGesture) => void) | null>(null);
  const immediateStartRef = useRef(false);
  const previewSequenceRef = useRef(0);
  const previewRunScopeRef = useRef(createAppStudioPreviewRunScope());
  const filterPreviewTimerRef = useRef<number | null>(null);
  const sourceFeedbackTimerRef = useRef<number | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  // The App keeps one durable universal-AI thread. The selected page/tile/run
  // key filters which immutable thread turns are presented as current; it does
  // not create a new thread for every preview or discard audit history.
  const copilotThread = usePersistedAgentThreadId(`app-studio:${draft?.id ?? initialDraftId ?? 'new'}`);

  useEffect(() => {
    const adaptStudioShell = () => {
      const width = window.innerWidth;
      setPanelOpen(width > 820);
    };
    adaptStudioShell();
    window.addEventListener('resize', adaptStudioShell);
    return () => window.removeEventListener('resize', adaptStudioShell);
  }, []);

  useEffect(() => {
    const node = workspaceRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(Math.max(0, Math.floor(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, [draft]);

  useEffect(() => {
    if (aiActivity?.status !== 'running') return;
    setAiActivityIndex(0);
    if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      setAiActivityIndex((current) => nextAppStudioAiActivityIndex(current));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [aiActivity?.status, aiActivity?.retry.requiredSourceIds.join('|')]);

  useEffect(() => {
    let active = true;
    setBusy(Boolean(baseAppId || initialDraftId));
    void api.listAppBuilds().then(async (result) => {
      if (!active) return;
      const localDrafts = result.drafts.filter((item) => item.state !== 'project_published');
      if (initialDraftId) {
        const selected = localDrafts.find((item) => item.id === initialDraftId);
        if (!selected) throw new Error('The local App draft is no longer available.');
        setDraft(selected);
        setName(selected.name);
        setActivePageId(selected.pages[0]?.id ?? 'overview');
        setSavedMessage('Resumed local draft');
        return;
      }
      if (!baseAppId) return;
      const existing = localDrafts.find((item) => item.baseApp?.appId === baseAppId);
      const resolved = existing ?? (await api.createAppBuild({
        baseAppId,
        goal: prompt.trim() || 'Edit this governed App',
        audience,
        domain,
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      })).draft;
      if (!active) return;
      setDraft(resolved);
      setName(resolved.name);
      setActivePageId(resolved.pages[0]?.id ?? 'overview');
      setSavedMessage('Safe local edit draft');
    }).catch((cause) => {
      if (active && (baseAppId || initialDraftId)) setError(messageOf(cause));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [baseAppId, initialDraftId]);

  useEffect(() => {
    if (!draft) return;
    let active = true;
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError(null);
    const timer = window.setTimeout(() => {
      void api.listAppSourceCandidates(draft.id, {
        query: catalogQuery,
        limit: 50,
        ...(draftDomain ? { domains: [draftDomain] } : {}),
      }, controller.signal).then((page) => {
        if (!active) return;
        setCatalog(page.items);
        setCatalogNextCursor(page.nextCursor);
        setCatalogTotal(page.total);
        setDatasetTilesEnabled(page.features?.datasets !== false);
      }).catch((cause) => {
        if (active && !controller.signal.aborted) {
          setCatalog([]);
          setCatalogError(messageOf(cause));
        }
      }).finally(() => { if (active) setCatalogLoading(false); });
    }, catalogQuery ? 180 : 0);
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [catalogRefreshNonce, draft?.id, draft?.sourcePolicy, draftDomain, catalogQuery]);

  useEffect(() => {
    const handleAskResult = (event: Event) => {
      const detail = (event as CustomEvent<{
        draft?: AppStudioBuildDraft;
        pageId?: string;
        tileId?: string;
      }>).detail;
      if (!detail?.draft || detail.draft.id !== draft?.id) return;
      previewSequenceRef.current += 1;
      setPreviewing(false);
      setPreviewRunsByPage({});
      setPreviewHierarchyDrillsByPage({});
      setFilterOptionsByPage({});
      setDraft(detail.draft);
      setName(detail.draft.name);
      setActivePageId(detail.pageId ?? detail.draft.pages[0]?.id ?? 'overview');
      setSelectedTileId(detail.tileId ?? null);
      setProposal(null);
      setAutopilotReview(null);
      setSavedMessage('Ask result added · loading preview…');
    };
    window.addEventListener('dql-app-build-updated', handleAskResult);
    return () => window.removeEventListener('dql-app-build-updated', handleAskResult);
  }, [draft?.id]);

  const activePage = useMemo(
    () => draft?.pages.find((page) => page.id === activePageId) ?? draft?.pages[0] ?? null,
    [activePageId, draft],
  );
  const previewVariablesForPage = (
    page: AppStudioBuildDraft['pages'][number],
    pageValues = previewVariablesByPage[page.id] ?? {},
    appValues = previewAppScopedFilterValues,
  ): Record<string, unknown> => hydrateAppScopedDashboardFilterValues({
    filters: page.filters ?? [],
    pageValues,
    appValues,
  });
  const previewRun = activePage ? previewRunsByPage[activePage.id] ?? null : null;
  const previewVariables = activePage ? previewVariablesForPage(activePage) : {};
  const previewCrossFilters = activePage ? previewCrossFiltersByPage[activePage.id] ?? [] : [];
  const previewHierarchyDrills = activePage ? previewHierarchyDrillsByPage[activePage.id] ?? [] : [];
  const activeFilterOptions = activePage ? filterOptionsByPage[activePage.id] ?? {} : {};
  // A preview run lists option values only for some filters. Dataset-bound
  // choice filters fall back to the field's distinct values, the same lookup
  // the published viewer uses, so a Region filter is never a blank text box.
  const datasetFieldValueCacheRef = useRef<Record<string, string[]>>({});
  useEffect(() => {
    if (!activePage) return;
    let cancelled = false;
    for (const filter of activePage.filters ?? []) {
      if (filter.type !== 'select' && filter.type !== 'multiselect') continue;
      if (filter.options?.length || activeFilterOptions[filter.id]?.values.length) continue;
      const source = datasetOptionSource(filter as never, (activePage as { datasets?: never }).datasets);
      if (!source) continue;
      const key = `${source.sourceId}:${source.field}`;
      const apply = (values: string[]) => {
        if (cancelled || values.length === 0) return;
        setFilterOptionsByPage((current) => {
          const pageOptions = current[activePage.id] ?? {};
          if (pageOptions[filter.id]?.values.length) return current;
          return { ...current, [activePage.id]: { ...pageOptions, [filter.id]: { values, truncated: false, valueCount: values.length } } };
        });
      };
      const cached = datasetFieldValueCacheRef.current[key];
      if (cached) { apply(cached); continue; }
      void api.datasetFieldValues(source.sourceId, source.field).then((result) => {
        if (!result.ok) return;
        datasetFieldValueCacheRef.current[key] = result.values;
        apply(result.values);
      });
    }
    return () => { cancelled = true; };
  }, [activePage, filterOptionsByPage]);
  // While editing, Auto keeps the Desktop grid (the layout the author
  // arranges) until the canvas is phone-sized; opening a side pane must not
  // swap in the derived tablet layout mid-edit.
  const breakpoint: StudioBreakpoint = previewMode === 'auto'
    ? workspaceWidth < 720 ? 'narrow' : studioView === 'edit' || workspaceWidth >= 1120 ? 'wide' : 'medium'
    : previewMode;
  const visibleItems = useMemo(() => {
    if (!activePage) return [];
    const projection = activePage.layout.responsive?.[breakpoint];
    const columns = breakpoint === 'wide' ? 12 : breakpoint === 'medium' ? 6 : 1;
    const items = collapseTemplateIntroductions(projection?.items ?? activePage.layout.items, draft?.template);
    // Desktop shows the author's placement; tablet and phone stay derived.
    return breakpoint === 'wide' ? settleGridLayout(items, CANVAS_COLUMNS) : packStudioItems(items, columns);
  }, [activePage, breakpoint, draft?.template]);
  const canvasItems = gesture && gesture.pageId === activePage?.id ? gesture.items : visibleItems;
  const rowPx = canvasRowHeight(activePage?.layout.rowHeight);
  const selectedTile = activePage?.layout.items.find((item) => item.i === selectedTileId) ?? null;
  const selectedDatasetTile = selectedTile?.sourceId && selectedTile.query ? selectedTile : null;
  const autopilotRepairAvailability = appAutopilotRepairShortcutAvailability(selectedDatasetTile, previewRun);
  const selectAppAutopilotTile = (tileId: string) => {
    setSelectedTileId(tileId);
    setAutopilotTileSelectionRequested(false);
  };
  // Only a selected Dataset tile is a valid App Autopilot target. A heading or
  // narrative component can stay selected for its inspector without making a
  // server response disappear behind a mismatched presentation key.
  const autopilotPresentationScope = appAutopilotPresentationContextKey({
    draftId: draft?.id ?? initialDraftId ?? undefined,
    pageId: activePageId,
    tileId: selectedDatasetTile?.i,
    previewRunId: previewRun?.runId,
  });
  useEffect(() => {
    // A proposal belongs to the exact context in which it was generated. It
    // remains in the immutable AgentRun history, but cannot be applied after a
    // page, tile, or preview switch presents a new current context.
    setAutopilotReview(null);
  }, [autopilotPresentationScope]);
  const filteredCatalog = catalog;
  const runtimeFilterFields = useMemo<StudioRuntimeFilterFields>(() => Object.fromEntries(
    Object.entries(previewRunsByPage).map(([pageId, run]) => [pageId, Object.fromEntries(
      run.tiles.map((tile) => [tile.tileId, tile.filterableColumns ?? []]),
    )]),
  ), [previewRunsByPage]);
  const filterCandidates = useMemo(
    () => discoverAppFilterCandidates(draft?.pages ?? [], catalog, runtimeFilterFields, draft?.sources ?? []),
    [catalog, draft?.pages, draft?.sources, runtimeFilterFields],
  );
  const proposalSummary = useMemo(() => proposal ? summarizeAppStudioAiPlan(proposal) : null, [proposal]);
  useEffect(() => {
    if (!proposal && !autopilotReview) setProposalPageId(null);
  }, [proposal, autopilotReview]);
  // Pages that only need a fresh run are run by Publish itself, so they are not fixes for the author.
  const publishStepCount = useMemo(
    () => draft ? publicationBlockerCount(draft, publishIssues) - pagesNeedingSettledPreview(draft).length : 0,
    [draft, publishIssues],
  );

  useEffect(() => {
    setSelectedProposalSourceIds(new Set(proposal?.defaultSelectedSourceIds ?? proposalSummary?.sources.map((source) => source.id) ?? []));
  }, [proposal, proposalSummary]);

  useEffect(() => {
    if (!proposalSummary || selectedSource || catalog.length === 0) return;
    const sourceRefs = new Set(proposalSummary.sources.map((source) => source.label.toLowerCase()));
    const match = catalog.find((item) => sourceRefs.has(humanize(item.name).toLowerCase()))
      ?? catalog.find((item) => proposalSummary.components.some((component) => component.source === item.id || component.source === item.name));
    if (match) setSelectedSource(match);
  }, [catalog, proposalSummary, selectedSource]);

  const createDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createAppBuild({
        baseAppId: baseAppId ?? undefined,
        name: name.trim() || undefined,
        goal: prompt.trim() || name.trim() || 'A dashboard of live, checked numbers',
        audience,
        domain,
        authoringMode: mode,
        sourcePolicy,
        template,
      });
      setDraft(result.draft);
      setName(result.draft.name);
      setActivePageId(result.draft.pages[0]?.id ?? 'overview');
      setSavedMessage('Saved locally');
      setPreviewRunsByPage({});
      setPreviewVariablesByPage({});
      setFilterOptionsByPage({});
      if (mode === 'ai') {
        setAiActivityIndex(0);
        setAiActivity({ status: 'running', retry: appStudioProposalRetry(prompt, []), returnToProposal: false });
        await requestAiProposal(result.draft, prompt, [], false);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const requestAiProposal = async (
    base = draft,
    nextPrompt = prompt,
    selectedBlockIds?: string[],
    returnToProposal = Boolean(proposal),
  ): Promise<boolean> => {
    if (!base) return false;
    const requiredSourceIds = appStudioProposalRequestSourceIds(selectedBlockIds, selectedSource?.id);
    const retry = appStudioProposalRetry(nextPrompt, requiredSourceIds ?? []);
    setAiActivityIndex(0);
    setAiActivity({ status: 'running', retry, returnToProposal });
    setBusy(true);
    setError(null);
    try {
      const targetPageId = base.pages.some((page) => page.id === activePageId) ? activePageId : base.pages[0]?.id;
      const result = await api.proposeAppBuildChanges(base.id, {
        prompt: nextPrompt.trim() || base.frame.goal,
        expectedRevision: base.revision,
        proposalHash: base.proposalHash,
        selectedBlockIds: requiredSourceIds,
        ...(targetPageId ? { pageId: targetPageId } : {}),
        mode: replacePageWithAi ? 'replace' : 'add',
      });
      setProposal(result.proposal);
      setAiActivity(null);
      setCopilotOpen(false);
      setSavedMessage('AI plan ready for review');
      return true;
    } catch (cause) {
      const message = messageOf(cause);
      setSavedMessage('AI proposal needs attention');
      setAiActivity({ status: 'error', retry, returnToProposal, error: message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reviseAiProposal = async (
    answers?: Record<string, string>,
    requiredSourceIds = Array.from(selectedProposalSourceIds),
    showActivity = true,
  ): Promise<boolean> => {
    if (!draft || !proposal) return false;
    const exactRequiredIds = Array.from(new Set(requiredSourceIds.filter(Boolean)));
    const retry = appStudioRevisionRetry(answers, exactRequiredIds);
    if (showActivity) {
      setAiActivityIndex(0);
      setAiActivity({ status: 'running', retry, returnToProposal: true });
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.reviseAppBuildProposal(draft.id, proposal.id, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        answers,
        selectedSourceIds: exactRequiredIds,
      });
      setProposal(result.proposal);
      if (showActivity) setAiActivity(null);
      setSavedMessage('AI proposal revised on the server');
      return true;
    } catch (cause) {
      const message = messageOf(cause);
      if (showActivity) {
        setAiActivity({ status: 'error', retry, returnToProposal: true, error: message });
      } else {
        setError(message);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const generateAiGap = async (requirementId: string) => {
    if (!draft || !proposal) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.generateAppBuildGap(draft.id, proposal.id, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        requirementId,
      });
      // A missing source is never converted into an app-local SQL tile. The
      // server returns an immutable, compile-checked Dataset draft proposal;
      // the existing App plan remains untouched until an author explicitly
      // reviews and saves that separate source definition.
      setDatasetAuthoringProposal(result.contextProposal);
      setSavedMessage('Review the typed Dataset draft for this uncovered requirement');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const addSourceToAiProposal = async (
    sourceId: string,
    reviewRequired: boolean,
    source?: AppBlockRecommendation,
  ) => {
    if (!draft || !proposal || !proposalSummary) return;
    const requiredSourceIds = appStudioProposalRequiredSourceIds(selectedProposalSourceIds, sourceId);
    const addMode = appStudioProposalSourceAddMode({
      alreadyProposed: proposalSummary.sources.some((candidate) => candidate.id === sourceId),
      reviewRequired,
      sourcePolicy: draft.sourcePolicy,
    });
    if (source) setSelectedSource(source);
    if (addMode === 'select_existing') {
      setSelectedProposalSourceIds((current) => new Set([...current, sourceId]));
      return;
    }
    setProposalAddingSourceId(sourceId);
    try {
      if (addMode === 'enable_review_and_replan') {
        const retry = appStudioReviewAddRetry(prompt, sourceId, requiredSourceIds);
        setAiActivityIndex(0);
        setAiActivity({ status: 'running', retry, returnToProposal: true });
        const next = await mutate([{ type: 'set_source_policy', sourcePolicy: 'include_review_required' }]);
        if (!next) {
          setAiActivity({
            status: 'error',
            retry,
            returnToProposal: true,
            error: 'Data that needs review could not be allowed. Your existing proposal is unchanged.',
          });
          return;
        }
        await requestAiProposal(next, prompt, requiredSourceIds, true);
      } else {
        await reviseAiProposal(undefined, requiredSourceIds, false);
      }
    } finally {
      setProposalAddingSourceId(null);
    }
  };

  const retryAiActivity = (activity: AppStudioAiActivity) => {
    const retry = activity.retry;
    if (retry.kind === 'revise') {
      void reviseAiProposal(retry.answers, retry.requiredSourceIds, true);
      return;
    }
    if (retry.kind === 'enable_review_and_propose') {
      void addSourceToAiProposal(retry.sourceId, true);
      return;
    }
    void requestAiProposal(draft, retry.prompt, retry.requiredSourceIds, activity.returnToProposal);
  };

  useEffect(() => {
    if (!startImmediately || initialDraftId || baseAppId || draft || immediateStartRef.current) return;
    immediateStartRef.current = true;
    void createDraft();
  }, [baseAppId, draft, initialDraftId, startImmediately]);

  /** A page can rerun single tiles only while its current results are whole and unexplored. */
  const canRerunTilesOnly = (pageId: string) => {
    const run = previewRunsByPage[pageId];
    return Boolean(run && !run.incomplete
      && !(previewCrossFiltersByPage[pageId]?.length)
      && !(previewHierarchyDrillsByPage[pageId]?.length));
  };

  // Saves run one at a time against the newest draft. Two quick edits (a
  // blur that saves one field while the next field saves) used to send the
  // same revision twice, and the second failed with a proposal conflict.
  const latestDraftRef = useRef(draft);
  latestDraftRef.current = draft;
  const mutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const mutate = (operations: AppStudioDraftOperation[], recordHistory = true): Promise<AppStudioBuildDraft | null> => {
    if (!draft || operations.length === 0) return Promise.resolve(null);
    const queued = mutationQueueRef.current.then(() => applyMutation(operations, recordHistory));
    mutationQueueRef.current = queued.catch(() => undefined);
    return queued;
  };
  const applyMutation = async (operations: AppStudioDraftOperation[], recordHistory: boolean) => {
    const current = latestDraftRef.current;
    if (!current) return null;
    setBusy(true);
    setSavedMessage('Saving…');
    setError(null);
    try {
      const previous = current;
      const keepVisiblePreview = operations.every(isPresentationOnlyOperation);
      const pageId = activePage?.id;
      const priorRun = pageId ? previewRunsByPage[pageId] : undefined;
      // Editing, adding or removing a tile reruns only that tile; the rest of
      // the page keeps its results. Page-wide edits still rerun everything.
      const plan = !keepVisiblePreview && pageId && canRerunTilesOnly(pageId)
        ? incrementalPreviewPlan(operations, pageId)
        : undefined;
      const result = await api.patchAppBuild(current.id, current.revision, operations, current.proposalHash);
      latestDraftRef.current = result.draft;
      setDraft(result.draft);
      setAutopilotReview(null);
      if (plan && pageId && priorRun) {
        const dropped = new Set(plan.dropTileIds);
        const kept = new Set(priorRun.tiles.map((tile) => tile.tileId).filter((tileId) => !dropped.has(tileId)));
        const page = result.draft.pages.find((candidate) => candidate.id === pageId);
        // Any data tile without a current result reruns, which also recovers a
        // tile whose earlier bounded run was superseded.
        const rerun = (page?.layout.items ?? []).filter((item) => isDataTile(item) && !kept.has(item.i)).map((item) => item.i);
        previewSequenceRef.current += 1;
        setPreviewing(false);
        setPreviewRunsByPage((current) => {
          const run = current[pageId];
          if (!run) return current;
          return { ...current, [pageId]: { ...run, partial: true, facts: [], tiles: run.tiles.filter((tile) => kept.has(tile.tileId)) } };
        });
        setSavedDatasetReviewDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !dropped.has(key.slice(pageId.length + 1)))));
        if (rerun.length) void runPreviewForDraft(result.draft, pageId, undefined, undefined, { affectedTileIds: rerun, edit: true });
      } else if (!keepVisiblePreview) {
        previewSequenceRef.current += 1;
        setPreviewRunsByPage({});
        setPreviewHierarchyDrillsByPage({});
        setFilterOptionsByPage({});
        setSavedDatasetReviewDrafts({});
        setPreviewing(false);
      }
      if (recordHistory) {
        setUndoStack((items) => [...items.slice(-29), previous]);
        setRedoStack([]);
      }
      setSavedMessage('Saved locally');
      return result.draft;
    } catch (cause) {
      setSavedMessage('Save failed');
      setError(messageOf(cause));
      return null;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Saving a reusable block is intentionally not an App mutation. The route
   * receives only the current tile identity and optimistic guards; it reloads
   * current governed execution evidence on the server before creating a
   * separate review draft.
   */
  const saveDatasetTileAsReusableBlock = async (
    page: AppStudioBuildDraft['pages'][number],
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
  ) => {
    if (!draft || !tile.query) return;
    const run = previewRunsByPage[page.id];
    const runTile = run?.tiles.find((candidate) => candidate.tileId === tile.i);
    if (!run || !runTile || runTile.status !== 'ok' || !isCurrentDatasetTileEvidence(tile, runTile)) {
      setError('Run the current Dataset tile before saving it as a reusable review draft.');
      return;
    }
    setSavingDatasetTileId(tile.i);
    setError(null);
    try {
      const result = await api.saveDatasetTileAsBlock(draft.id, page.id, tile.i, {
        runId: run.runId,
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        name: tile.title?.trim() || undefined,
        domain: page.metadata.domain || undefined,
      });
      if (!result.ok) {
        setError(`${result.code}: ${result.error}`);
        setSavedMessage('Reusable block was not saved');
        return;
      }
      setSavedDatasetReviewDrafts((current) => ({ ...current, [`${page.id}:${tile.i}`]: result }));
      setSavedMessage(`Reusable review draft saved at ${result.path}`);
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('Reusable block was not saved');
    } finally {
      setSavingDatasetTileId((current) => current === tile.i ? null : current);
    }
  };

  /**
   * Replacement is deliberately not an ordinary patch: the server reruns the
   * saved block and current Dataset statement inside one read scope, then
   * writes the review-required App mutation atomically.
   */
  const replaceDatasetTileWithSavedBlock = async (
    page: AppStudioBuildDraft['pages'][number],
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
  ) => {
    if (!draft || !tile.query) return;
    const saved = savedDatasetReviewDrafts[`${page.id}:${tile.i}`];
    const run = previewRunsByPage[page.id];
    const runTile = run?.tiles.find((candidate) => candidate.tileId === tile.i);
    if (!saved?.replacementEligible) {
      setError('Save a current representable Dataset tile as a review draft before replacing it.');
      return;
    }
    if (!run || !runTile || runTile.status !== 'ok' || !isCurrentDatasetTileEvidence(tile, runTile)) {
      setError('Run the current Dataset tile before replacing it with a review draft.');
      return;
    }
    setReplacingDatasetTileId(tile.i);
    setError(null);
    try {
      const result = await api.replaceDatasetTileWithBlock(draft.id, page.id, tile.i, {
        runId: run.runId,
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        blockPath: saved.path,
        // The button is explicit about changing the source policy. The server
        // remains the authority for whether this acknowledgement is needed.
        enableReviewRequired: true,
      });
      if (!result.ok) {
        setError(`${result.code}: ${result.error}`);
        setSavedMessage('Dataset tile was not replaced');
        return;
      }
      setUndoStack((items) => [...items.slice(-29), draft]);
      setRedoStack([]);
      setDraft(result.draft);
      previewSequenceRef.current += 1;
      setPreviewRunsByPage({});
      setPreviewHierarchyDrillsByPage({});
      setFilterOptionsByPage({});
      setSavedDatasetReviewDrafts({});
      setSavedMessage(`Replaced with review draft after equivalence proof ${result.equivalenceProofFingerprint.slice(0, 18)}…`);
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('Dataset tile was not replaced');
    } finally {
      setReplacingDatasetTileId((current) => current === tile.i ? null : current);
    }
  };

  /**
   * Legacy semantic conversion is a two-step review flow. The first call is
   * non-mutating; the server returns a short-lived proposal only after it
   * proves the two governed paths in one current read scope.
   */
  const previewLegacySemanticConversion = async (
    page: AppStudioBuildDraft['pages'][number],
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
  ) => {
    if (!draft || !tile.semantic || tile.query) return;
    setPreviewingSemanticConversionTileId(tile.i);
    setError(null);
    try {
      const result = await api.previewSemanticTileConversion(draft.id, page.id, tile.i, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
      });
      if (!result.ok) {
        setError(`${result.code}: ${result.error}`);
        setSavedMessage('Dataset conversion was not previewed');
        return;
      }
      setSemanticTileConversionPreviews((current) => ({ ...current, [`${page.id}:${tile.i}`]: result }));
      setSavedMessage('Dataset conversion is ready for review · the App is unchanged');
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('Dataset conversion was not previewed');
    } finally {
      setPreviewingSemanticConversionTileId((current) => current === tile.i ? null : current);
    }
  };

  /** Acceptance reruns proof under current authority before this local draft changes. */
  const acceptLegacySemanticConversion = async (
    page: AppStudioBuildDraft['pages'][number],
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
  ) => {
    if (!draft || !tile.semantic || tile.query) return;
    const preview = semanticTileConversionPreviews[`${page.id}:${tile.i}`];
    if (!preview) {
      setError('Preview the current legacy semantic tile before applying this Dataset conversion.');
      return;
    }
    setAcceptingSemanticConversionTileId(tile.i);
    setError(null);
    try {
      const result = await api.acceptSemanticTileConversion(draft.id, page.id, tile.i, preview.proposalId, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
      });
      if (!result.ok) {
        setError(`${result.code}: ${result.error}`);
        setSavedMessage('Dataset conversion was not applied');
        return;
      }
      setUndoStack((items) => [...items.slice(-29), draft]);
      setRedoStack([]);
      setDraft(result.draft);
      previewSequenceRef.current += 1;
      setPreviewRunsByPage({});
      setPreviewHierarchyDrillsByPage({});
      setFilterOptionsByPage({});
      setSavedDatasetReviewDrafts({});
      setSemanticTileConversionPreviews({});
      setSavedMessage(`Converted to a Dataset query after equivalence proof ${result.equivalenceProofFingerprint.slice(0, 18)}…`);
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('Dataset conversion was not applied');
    } finally {
      setAcceptingSemanticConversionTileId((current) => current === tile.i ? null : current);
    }
  };

  /** The universal AgentRun artifact is an explicit review boundary. */
  const applyAutopilotChange = async () => {
    if (!draft || !autopilotReview) return;
    setCopilotRunning(true);
    setError(null);
    try {
      const previous = draft;
      const result = await api.applyAppAutopilotChange(autopilotReview.runId, autopilotReview.id, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        proposalHash: autopilotReview.proposalHash,
      });
      // A query change invalidates the complete draft's settled-preview and
      // preflight authority. Do not leave another page's old result looking
      // current after the server has cleared its draft receipts.
      previewSequenceRef.current += 1;
      setPreviewRunsByPage({});
      setPreviewAppScopedFilterValues({});
      setPreviewVariablesByPage({});
      setPreviewHierarchyDrillsByPage({});
      setPreviewCrossFiltersByPage({});
      setFilterOptionsByPage({});
      setPreviewing(false);
      setDraft(result.draft);
      setName(result.draft.name);
      setUndoStack((items) => [...items.slice(-29), previous]);
      setRedoStack([]);
      setSelectedTileId(autopilotReview.tileId);
      setAutopilotReview(null);
      setSavedMessage(`${result.deduped ? 'AI tile change was already applied locally' : 'AI tile change applied locally'} · run a fresh preview before publishing`);
    } catch (cause) {
      setError(messageOf(cause));
      setSavedMessage('AI tile change needs a fresh review or preview');
    } finally {
      setCopilotRunning(false);
    }
  };

  const applyProposal = async () => {
    if (!proposal || !draft) return;
    setBusy(true);
    setError(null);
    setSavedMessage('Composing App…');
    try {
      const previous = draft;
      const result = await api.composeAppBuild(draft.id, {
        mode: 'ai',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        proposalId: proposal.id,
        selectedSourceIds: Array.from(selectedProposalSourceIds),
        ...(skippedProposalTileIds.size > 0 ? { rejectedTileIds: Array.from(skippedProposalTileIds) } : {}),
      });
      const next = result.draft;
      setDraft(next);
      setUndoStack((items) => [...items.slice(-29), previous]);
      setRedoStack([]);
      setPreviewRunsByPage({});
      setFilterOptionsByPage({});
      setProposal(null);
      setName(next.name);
      const generatedPage = next.pages.find((page) => page.id === proposal.targetPageId) ?? next.pages[0];
      setActivePageId(generatedPage?.id ?? activePageId);
      if (generatedPage && pageHasDataTiles(generatedPage)) {
        setSavedMessage('App generated · loading governed data…');
        await runPreviewForDraft(next, generatedPage.id);
      }
    } catch (cause) {
      setSavedMessage('Compose failed');
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!draft || undoStack.length === 0) return;
    const target = undoStack[undoStack.length - 1];
    const current = draft;
    const next = await mutate(restoreOperations(current, target), false);
    if (!next) return;
    setUndoStack((items) => items.slice(0, -1));
    setRedoStack((items) => [...items, current]);
  };

  const redo = async () => {
    if (!draft || redoStack.length === 0) return;
    const target = redoStack[redoStack.length - 1];
    const current = draft;
    const next = await mutate(restoreOperations(current, target), false);
    if (!next) return;
    setRedoStack((items) => items.slice(0, -1));
    setUndoStack((items) => [...items, current]);
  };

  const addPage = async () => {
    if (!draft) return;
    const index = draft.pages.length + 1;
    const id = `page-${index}`;
    const page: AppStudioBuildDraft['pages'][number] = {
      // The public `upsert_page` reducer owns App-filter inheritance. It
      // promotes this new page to v3 only when a Dataset-bound App control
      // must retain its explicit empty mapping; Studio never copies bindings
      // or decides compatibility in the browser.
      version: 2,
      id,
      metadata: {
        title: `Page ${index}`,
        description: 'Responsive analytical page',
        domain: draft.pages[0]?.metadata.domain,
        audience: draft.frame.audience,
        visibility: 'private',
        lifecycle: 'draft',
      },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80, items: [],
        responsive: {
          wide: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
          medium: { kind: 'grid', cols: 6, rowHeight: 80, items: [] },
          narrow: { kind: 'grid', cols: 1, rowHeight: 80, items: [] },
        },
      },
    };
    const next = await mutate([{ type: 'upsert_page', page }]);
    if (next) setActivePageId(id);
  };

  const selectSource = (source: AppBlockRecommendation) => {
    setSelectedSource(source);
    setError(null);
  };

  /**
   * Source authoring is intentionally separate from adding a field tile. The
   * dialog only accepts a current block Dataset catalog row; semantic models
   * remain provider-owned and cannot be relabelled as a DQL source patch.
   */
  const openDatasetAuthoring = (source: AppBlockRecommendation) => {
    if (!datasetSourceAuthoringModel(source)) {
      setError(source.capabilities?.dataset?.kind === 'semantic'
        ? 'These Metrics are owned by their semantic model. Update the semantic model, then refresh App sources.'
        : 'Refresh this source before authoring its Dataset definition.');
      return;
    }
    setDatasetAuthoringProposal(null);
    setDatasetAuthoringSource(source);
    setError(null);
  };

  const previewDatasetAuthoringChange = async (change: DatasetAuthoringChange) => {
    if (!draft || !datasetAuthoringSource) return;
    setBusy(true);
    setError(null);
    setSavedMessage('Preparing reviewed Dataset definition…');
    try {
      const proposal = await api.createContextProposal({
        origin: 'manual',
        operations: [{
          id: `dataset-change-${crypto.randomUUID()}`,
          kind: 'dataset_change',
          change,
          evidence: [
            `App Studio source ${datasetAuthoringSource.sourceId ?? datasetAuthoringSource.id}`,
            `Dataset source revision ${datasetAuthoringSource.sourceRevision ?? datasetAuthoringSource.fingerprint}`,
          ],
        }],
      });
      setDatasetAuthoringSource(null);
      setDatasetAuthoringProposal(proposal);
      setSavedMessage('Review the exact Dataset definition change');
    } catch (cause) {
      setSavedMessage('Dataset definition needs attention');
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const finishDatasetAuthoringProposal = (proposal: ContextAuthoringProposalV1) => {
    setDatasetAuthoringProposal(null);
    // Source acceptance writes only the DQL definition. Existing App bindings
    // remain revision-pinned until the author deliberately refreshes them.
    setSelectedSource(null);
    setCatalogRefreshNonce((current) => current + 1);
    setSavedMessage(proposal.status === 'committed'
      ? 'Dataset definition saved; it needs review. Refresh this App’s Dataset binding explicitly to use it.'
      : 'Dataset proposal closed without changing this App binding.');
    setPanel('sources');
    setPanelOpen(true);
  };

  /**
   * Refresh is a second, deliberate operation after a reviewed source change.
   * It always resolves the current catalog immediately, so the same action is
   * available after a browser or CLI restart rather than depending on a
   * transient "just accepted" proposal state.
   */
  const refreshDatasetBinding = async (sourceId: string, enableReviewPreview = false) => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setSavedMessage('Checking the current Dataset definition…');
    try {
      const result = await runDatasetSourceRebindAction({
        draft,
        sourceId,
        enableReviewPreview,
        resolveCandidates: (draftId, sourceIds, options) => api.resolveAppSourceCandidates(draftId, sourceIds, options),
        patchDraft: (draftId, expectedRevision, operations, expectedProposalHash) => (
          api.patchAppBuild(draftId, expectedRevision, operations, expectedProposalHash)
        ),
        onPreviewInvalidated: () => {
          previewSequenceRef.current += 1;
          setPreviewRunsByPage({});
          setFilterOptionsByPage({});
          setPreviewing(false);
        },
      });
      if (!result.ok) {
        if (result.code === 'REVIEW_POLICY_REQUIRED') {
          const title = catalog.find((item) => (item.sourceId ?? item.id) === sourceId)?.name
            ?? draft.sources.find((source) => source.id === sourceId)?.sourceRef
            ?? sourceId;
          setDatasetRebindPrompt({ sourceId, title });
          setSavedMessage('Review policy choice required');
        } else {
          setSavedMessage('Dataset binding still needs attention');
          setError(result.error);
        }
        return;
      }
      const previous = draft;
      setDraft(result.draft);
      setUndoStack((items) => [...items.slice(-29), previous]);
      setRedoStack([]);
      setPublishIssues([]);
      setDatasetRebindPrompt(null);
      setCatalogRefreshNonce((current) => current + 1);
      setSavedMessage(result.plan.requiresReviewPolicy
        ? 'Dataset binding refreshed for local review preview · Project publication remains blocked'
        : 'Dataset binding refreshed · run a current preview');
    } catch (cause) {
      setSavedMessage('Dataset binding refresh failed');
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const datasetLinkProposal = (page: AppStudioBuildDraft['pages'][number], tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) => (
    busy || previewing ? undefined : proposeDatasetCrossFilterLinks({
      page,
      tile,
      descriptorFor: (binding) => draft?.sources.find((source) => source.id === binding.sourceId && source.sourceRevision === binding.sourceRevision)?.capabilities?.dataset,
    })
  );
  // One click saves the proposed mappings as ordinary page interactions; the
  // author can inspect or remove each one in the tile's Interactions panel.
  const linkDatasetTileField = (tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) => {
    if (!activePage) return;
    const proposal = datasetLinkProposal(activePage, tile);
    if (!proposal) return;
    const existing = activePage.interactions?.crossFilter?.mappings ?? [];
    void mutate([{
      type: 'set_interactions',
      pageId: activePage.id,
      interactions: {
        ...(activePage.interactions ?? {}),
        crossFilter: { ...(activePage.interactions?.crossFilter ?? {}), mappings: [...existing, ...proposal.mappings] },
      },
    }]);
  };

  const loadMoreSources = async () => {
    if (!draft || !catalogNextCursor || catalogLoading) return;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const page = await api.listAppSourceCandidates(draft.id, {
        query: catalogQuery,
        cursor: catalogNextCursor,
        limit: 50,
        ...(draftDomain ? { domains: [draftDomain] } : {}),
      });
      setCatalog((current) => {
        const seen = new Set(current.map((source) => source.id));
        return [...current, ...page.items.filter((source) => !seen.has(source.id))];
      });
      setCatalogNextCursor(page.nextCursor);
      setCatalogTotal(page.total);
      setDatasetTilesEnabled(page.features?.datasets !== false);
    } catch (cause) {
      setCatalogError(messageOf(cause));
    } finally {
      setCatalogLoading(false);
    }
  };

  const addComponent = async (
    kind: 'heading' | 'text' | 'kpi' | 'chart' | 'table',
    sourceOverride?: AppBlockRecommendation | null,
    datasetQuery?: TileQuery,
    datasetTitle?: string,
    /** Visualization the author already saw while building the tile. */
    datasetVisualization?: AppStudioBuildDraft['pages'][number]['layout']['items'][number]['viz']['type'],
    /** The shelves the author built the tile on (RFC 0009). */
    datasetEncoding?: DashboardVizEncoding,
  ): Promise<boolean> => {
    if (!draft || !activePage) return false;
    const source = kind === 'heading' || kind === 'text'
      ? null
      : sourceOverride === undefined ? selectedSource : sourceOverride;
    if (kind !== 'heading' && kind !== 'text' && !source) {
      setPanel('sources');
      setPanelOpen(true);
      setError('Choose a Dataset, Metrics or saved query, then use Add to page.');
      return false;
    }
    if (source) {
      const sourceId = source.sourceId ?? source.id;
      const view = componentKindLabel(kind as 'kpi' | 'chart' | 'table');
      const enableReviewRequired = source.eligibility?.localPreview === false && draft.sourcePolicy === 'governed_only';
      setSelectedSource(source);
      if (sourceFeedbackTimerRef.current !== null) window.clearTimeout(sourceFeedbackTimerRef.current);
      setSourceFeedback({ sourceId, status: 'adding', view, pageTitle: activePage.metadata.title });
      setBusy(true);
      setSavedMessage('Composing source…');
      setError(null);
      try {
        const previous = draft;
        let result = await api.composeAppBuild(draft.id, {
          mode: 'manual',
          expectedRevision: draft.revision,
          expectedProposalHash: draft.proposalHash,
          enableReviewRequired,
          selections: [{
            sourceId,
            pageId: activePage.id,
            view: kind as 'kpi' | 'chart' | 'table',
            ...(datasetQuery ? { query: datasetQuery } : {}),
            ...(datasetTitle?.trim() ? { title: datasetTitle.trim() } : {}),
          }],
        });
        const addedTileId = result.tileIds[0];
        const composedPage = result.draft.pages.find((page) => page.id === activePage.id);
        const addedTile = composedPage?.layout.items.find((item) => item.i === addedTileId);
        const followUp: AppStudioDraftOperation[] = [];
        if (addedTile && ((datasetVisualization && addedTile.viz.type !== datasetVisualization) || datasetEncoding)) {
          // Keep the chart the author built (a date reads as a line), on the
          // shelves they built it on.
          followUp.push({ type: 'update_tile', pageId: activePage.id, tileId: addedTile.i, patch: { viz: {
            ...addedTile.viz,
            ...(datasetVisualization ? { type: datasetVisualization } : {}),
            ...(datasetEncoding && addedTile.query && !addedTile.query.detail ? { encoding: datasetEncoding } : {}),
          } } });
        }
        if (composedPage && addedTile) {
          // The new tile fills the first gap it fits instead of going under the page.
          const others = settleGridLayout(composedPage.layout.items.filter((item) => item.i !== addedTile.i), CANVAS_COLUMNS);
          const spot = firstFreeGridCell(others, addedTile.w, addedTile.h, CANVAS_COLUMNS);
          if (spot.y < addedTile.y || (spot.y === addedTile.y && spot.x !== addedTile.x)) {
            followUp.push({ type: 'update_tile', pageId: activePage.id, tileId: addedTile.i, patch: { x: spot.x, y: spot.y } });
          }
        }
        if (composedPage && addedTile) {
          // A page shown as a report or a custom layout shows the new tile
          // there too, at the end, so the author sees what they added.
          const shownAs = composedPage.narrative?.presentation;
          const tileNode: CanvasNode = { kind: 'element', tag: 'dql-tile', attrs: [['tile', addedTile.i]], children: [] };
          const layout = shownAs === 'canvas' && composedPage.canvas?.html ? checkCanvasHtml(composedPage.canvas.html) : null;
          if (composedPage.canvas && layout && layout.issues.length === 0) {
            followUp.push({ type: 'set_canvas', pageId: activePage.id, canvas: { ...composedPage.canvas, html: serializeCanvasNodes(insertCanvasNodes(parseCanvasHtml(layout.html), [tileNode]).nodes), generatedBy: 'author' } });
          }
          if (shownAs === 'story' && composedPage.narrative && !composedPage.narrative.blocks.some((block) => block.kind === 'tile' && block.tileId === addedTile.i)) {
            const taken = new Set(composedPage.narrative.blocks.map((block) => block.id));
            let n = composedPage.narrative.blocks.length + 1;
            while (taken.has(`b${n}`)) n += 1;
            followUp.push({ type: 'set_narrative', pageId: activePage.id, narrative: { ...composedPage.narrative, blocks: [...composedPage.narrative.blocks, { id: `b${n}`, kind: 'tile', tileId: addedTile.i }] } });
          }
        }
        if (followUp.length) {
          // Same undo step as the add.
          const patched = await api.patchAppBuild(result.draft.id, result.draft.revision, followUp, result.draft.proposalHash);
          result = { ...result, draft: patched.draft };
        }
        setDraft(result.draft);
        setUndoStack((items) => [...items.slice(-29), previous]);
        setRedoStack([]);
        setSelectedTileId(result.tileIds[0] ?? null);
        setSourceFeedback({ sourceId, status: 'added', view, pageTitle: activePage.metadata.title });
        sourceFeedbackTimerRef.current = window.setTimeout(() => {
          setSourceFeedback((current) => current?.sourceId === sourceId ? null : current);
          sourceFeedbackTimerRef.current = null;
        }, 1800);
        setSavedMessage(`${kind === 'chart' ? 'Chart' : humanize(kind)} added · loading data…`);
        if (addedTileId && canRerunTilesOnly(activePage.id)) {
          // The rest of the page keeps its results; only the new tile runs.
          await runPreviewForDraft(result.draft, activePage.id, undefined, undefined, { affectedTileIds: [addedTileId], edit: true });
          return true;
        }
        previewSequenceRef.current += 1;
        setPreviewRunsByPage({});
        setFilterOptionsByPage({});
        await runPreviewForDraft(result.draft, activePage.id);
        return true;
      } catch (cause) {
        const message = messageOf(cause);
        setSavedMessage('Compose failed');
        setSourceFeedback({ sourceId, status: 'error', view, pageTitle: activePage.metadata.title, message });
        setError(message);
        return false;
      } finally {
        setBusy(false);
      }
    }
    if (kind !== 'heading' && kind !== 'text') return false;
    const tileId = `${kind}-${Date.now().toString(36)}`;
    const width = 12;
    const height = kind === 'heading' ? 1 : 2;
    const nextY = activePage.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    const tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] = {
      i: tileId,
      x: 0,
      y: nextY,
      w: width,
      h: height,
      title: kind === 'heading' ? 'Section heading' : 'Narrative',
      text: { markdown: kind === 'heading' ? '## New section' : 'Add context, interpretation, or guidance.' },
      sourceClass: 'narrative',
      viz: { type: kind === 'heading' ? 'heading' : 'text' },
      trustState: 'draft_ready',
      reviewStatus: 'draft_ready',
    };
    const operations: AppStudioDraftOperation[] = [{ type: 'add_tile', pageId: activePage.id, tile }];
    const next = await mutate(operations);
    if (next) {
      setSelectedTileId(tileId);
      setSavedMessage(`${humanize(kind)} added`);
    }
    return Boolean(next);
  };

  const arrangePage = async () => {
    if (!activePage || !draft) return;
    const items = packStudioItems(collapseTemplateIntroductions(activePage.layout.items, draft.template), 12);
    const next = await mutate([{ type: 'set_layout', pageId: activePage.id, layout: { ...activePage.layout, items } }]);
    if (next) setSavedMessage('Page arranged · preview preserved');
  };

  const saveFilter = async (configuration: StudioFilterConfiguration) => {
    if (!draft || !activePage) return;
    const selected = new Set(configuration.selectedMappingKeys);
    const mappings = filterTileMappingsForField(draft.pages, catalog, configuration.fieldId, runtimeFilterFields, draft.sources);
    if (!mappings.some((mapping) => mapping.supported)) {
      setError('This field is not available on a compatible tile.');
      return;
    }
    const operations: AppStudioDraftOperation[] = [];
    for (const page of draft.pages) {
      const pageMappings = mappings.filter((mapping) => mapping.pageId === page.id);
      const linkedMappings = pageMappings.filter((mapping) => mapping.supported && selected.has(mapping.key));
      const datasetMappings = pageMappings.filter((mapping) => (
        mapping.supported && Boolean(mapping.datasetId && mapping.datasetField)
      ));
      // An App-scoped control is one durable logical definition on every
      // page. A page that has no compatible Dataset still retains that
      // control without a made-up field binding, so the runtime can surface a
      // specific unmapped/excluded state instead of silently dropping the App
      // filter when a page or Dataset is added later.
      const shouldAddToPage = configuration.scope === 'app'
        || ((linkedMappings.length > 0 || datasetMappings.length > 0) && page.id === activePage.id);
      const existingFilter = (page.filters ?? []).some((filter) => filter.id === configuration.id);
      if (shouldAddToPage) {
        // A Dataset may back several field-query components. Preserve the
        // author's exact selection instead of collapsing it into a Dataset-
        // wide mapping, including an explicit empty selection.
        const datasetBindings = datasetFilterBindingsForSelection(datasetMappings, selected);
        operations.push({
          type: 'set_filter',
          pageId: page.id,
          filter: {
            id: configuration.id,
            label: configuration.label.trim() || humanize(configuration.fieldId),
            type: configuration.type,
            bindsTo: configuration.fieldId,
            field: { name: configuration.fieldId },
            required: configuration.required,
            multiple: configuration.type === 'multiselect',
            // A date-only control represents a calendar range. Persist the
            // browser's declared IANA zone so timestamp Dataset fields can
            // compile an exact start-inclusive/end-exclusive interval.
            ...(configuration.type === 'daterange' ? {
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            } : {}),
            // A page/app filter must still visit unmapped Dataset tiles so the
            // runtime can expose an explicit "not mapped" badge. Mapping is
            // carried by datasetBindings, never silently narrowed by scope.
            scope: configuration.scope === 'app' ? { app: true } : { page: page.id },
            // Preserve an explicit empty Dataset binding on an App-scoped
            // control. New/unmapped pages must surface an exclusion until an
            // author selects a source-qualified mapping.
            ...(configuration.scope === 'app' || Object.keys(datasetBindings).length ? { datasetBindings } : {}),
            optionSource: { mode: 'distinct_query', field: configuration.fieldId, limit: 100 },
          },
        });
      } else if (existingFilter) {
        operations.push({ type: 'remove_filter', pageId: page.id, filterId: configuration.id });
      }
      for (const tile of page.layout.items.filter((item) => item.block || item.semantic || item.draftAnalysis)) {
        const mapping = pageMappings.find((item) => item.tileId === tile.i);
        const currentBindings = tile.filterBindings ?? [];
        const nextBindings = currentBindings.filter((binding) => binding.filter !== configuration.id);
        if (shouldAddToPage && mapping?.supported && selected.has(mapping.key)) {
          nextBindings.push({
            filter: configuration.id,
            binding: mapping.binding ?? configuration.fieldId,
            mode: mapping.mode ?? 'predicate',
            required: configuration.required,
            capability: 'preflight_required',
          });
        }
        if (JSON.stringify(nextBindings) !== JSON.stringify(currentBindings)) {
          operations.push({ type: 'update_tile', pageId: page.id, tileId: tile.i, patch: { filterBindings: nextBindings } });
        }
      }
    }
    const next = await mutate(operations);
    if (!next) return;
    setPreviewVariablesByPage((current) => Object.fromEntries(Object.entries(current).map(([pageId, variables]) => {
      if (next.pages.find((page) => page.id === pageId)?.filters?.some((filter) => filter.id === configuration.id)) return [pageId, variables];
      const { [configuration.id]: _removed, ...rest } = variables;
      return [pageId, rest];
    })));
    const nextPage = next.pages.find((page) => page.id === activePage.id);
    if (nextPage && pageHasDataTiles(nextPage)) {
      setSavedMessage(`${configuration.label.trim() || humanize(configuration.fieldId)} filter linked · refreshing ${linkedComponentCount(next, configuration.id)} tiles…`);
      await runPreviewForDraft(next, activePage.id, previewVariablesByPage[activePage.id] ?? {});
    } else {
      setSavedMessage(`${configuration.label.trim() || humanize(configuration.fieldId)} filter saved`);
    }
  };

  const removeFilter = async (filterId: string) => {
    if (!draft || !activePage) return;
    const operations: AppStudioDraftOperation[] = [];
    for (const page of draft.pages) {
      if ((page.filters ?? []).some((filter) => filter.id === filterId)) {
        operations.push({ type: 'remove_filter', pageId: page.id, filterId });
      }
      for (const tile of page.layout.items.filter((item) => item.filterBindings?.some((binding) => binding.filter === filterId))) {
        operations.push({
          type: 'update_tile',
          pageId: page.id,
          tileId: tile.i,
          patch: { filterBindings: (tile.filterBindings ?? []).filter((binding) => binding.filter !== filterId) },
        });
      }
    }
    const nextVariablesByPage = Object.fromEntries(Object.entries(previewVariablesByPage).map(([pageId, variables]) => {
      const { [filterId]: _removed, ...rest } = variables;
      return [pageId, rest];
    }));
    setPreviewVariablesByPage(nextVariablesByPage);
    setPreviewAppScopedFilterValues((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, filterId)) return current;
      const { [filterId]: _removed, ...remaining } = current;
      return remaining;
    });
    setPreviewHierarchyDrillsByPage({});
    setFilterOptionsByPage((current) => Object.fromEntries(Object.entries(current).map(([pageId, options]) => {
      const { [filterId]: _removed, ...rest } = options;
      return [pageId, rest];
    })));
    const next = await mutate(operations);
    const nextPage = next?.pages.find((page) => page.id === activePage.id);
    if (next && nextPage && pageHasDataTiles(nextPage)) {
      setSavedMessage(`${humanize(filterId)} filter removed · refreshing linked tiles…`);
      await runPreviewForDraft(next, activePage.id, nextVariablesByPage[activePage.id] ?? {});
    } else if (next) {
      setSavedMessage(`${humanize(filterId)} filter removed`);
    }
  };

  const applyTemplate = async (nextTemplate: StudioTemplate) => {
    if (!draft || !activePage) return;
    const operations: AppStudioDraftOperation[] = [
      { type: 'set_template', template: nextTemplate },
      { type: 'upsert_page', page: studioTemplatePage(activePage, nextTemplate, draft.name) },
    ];
    await mutate(operations);
  };

  /** Save new tile positions from the canvas. The reducer settles them again, so the file matches. */
  const commitCanvasLayout = async (items: AppStudioBuildDraft['pages'][number]['layout']['items'], message: string) => {
    if (!activePage) return null;
    const positions = new Map(items.map((item) => [item.i, item]));
    const changed = activePage.layout.items.some((item) => {
      const next = positions.get(item.i);
      return next && (next.x !== item.x || next.y !== item.y || next.w !== item.w || next.h !== item.h);
    });
    if (!changed) return draft;
    const nextItems = activePage.layout.items.map((item) => {
      const next = positions.get(item.i);
      return next ? { ...item, x: next.x, y: next.y, w: next.w, h: next.h } : item;
    });
    const next = await mutate([{ type: 'set_layout', pageId: activePage.id, layout: { ...activePage.layout, items: nextItems } }]);
    if (next) setSavedMessage(message);
    return next;
  };

  const duplicateTile = async (tileId: string) => {
    if (!activePage) return;
    const source = visibleItems.find((item) => item.i === tileId) ?? activePage.layout.items.find((item) => item.i === tileId);
    if (!source) return;
    const copyId = copyTileId(activePage.layout.items, source.i);
    const copy = { ...source, i: copyId, title: source.title ? `${source.title} (copy)` : source.title };
    const placed = placeGridCopy(breakpoint === 'wide' ? visibleItems : settleGridLayout(activePage.layout.items, CANVAS_COLUMNS), source, copy, CANVAS_COLUMNS);
    const position = placed.find((item) => item.i === copyId) ?? copy;
    const positions = new Map(placed.map((item) => [item.i, item]));
    const next = await mutate([
      { type: 'add_tile', pageId: activePage.id, tile: { ...copy, x: position.x, y: position.y } },
      {
        type: 'set_layout',
        pageId: activePage.id,
        layout: {
          ...activePage.layout,
          items: [...activePage.layout.items, { ...copy, x: position.x, y: position.y }].map((item) => {
            const at = positions.get(item.i);
            return at ? { ...item, x: at.x, y: at.y, w: at.w, h: at.h } : item;
          }),
        },
      },
    ]);
    if (next) {
      setSelectedTileId(copyId);
      setSavedMessage('Tile duplicated');
      // Keyboard focus follows the copy, so the next shortcut acts on it.
      window.requestAnimationFrame(() => {
        const card = [...(gridRef.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])].find((node) => node.dataset.tileId === copyId);
        card?.focus();
      });
    }
  };

  /**
   * "Why did it move?" as a tile (RFC 0008 step 7): explain the latest
   * complete period of a trend tile, broken down by the Dataset's approved
   * dimensions. The new tile takes the first gap wide enough for it.
   */
  const addDriverTile = async (tileId: string) => {
    if (!activePage) return;
    const source = activePage.layout.items.find((item) => item.i === tileId);
    const definition = source ? driverProbeFor(source, previewRun?.tiles.find((item) => item.tileId === tileId)) : null;
    if (!source || !definition) return;
    const taken = new Set(activePage.layout.items.map((item) => item.i));
    let id = `${tileId}-why`;
    for (let n = 2; taken.has(id); n += 1) id = `${tileId}-why-${n}`;
    const settled = settleGridLayout(activePage.layout.items, CANVAS_COLUMNS);
    const spot = firstFreeGridCell(settled, 12, 6, CANVAS_COLUMNS);
    const tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] = {
      i: id,
      x: spot.x,
      y: spot.y,
      w: 12,
      h: 6,
      sourceId: source.sourceId,
      ...(source.sourceRevision ? { sourceRevision: source.sourceRevision } : {}),
      ...(source.filterBindings ? { filterBindings: source.filterBindings } : {}),
      ...(source.trustState ? { trustState: source.trustState } : {}),
      ...(source.reviewStatus ? { reviewStatus: source.reviewStatus } : {}),
      ...(source.sourceClass ? { sourceClass: source.sourceClass } : {}),
      driver: definition,
      viz: { type: 'waterfall' },
      title: `Why ${source.title || 'this'} moved`,
    };
    // The driver joins the filters its source tile is listed in, so it
    // explains the same filtered data the reader is looking at.
    const filterUpdates = filtersForNewDriverTile(activePage.filters, tileId, id)
      .map((filter) => ({ type: 'set_filter' as const, pageId: activePage.id, filter }));
    const next = await mutate([{ type: 'add_tile', pageId: activePage.id, tile }, ...filterUpdates]);
    if (next) {
      setSelectedTileId(id);
      setSavedMessage('Driver tile added');
    }
  };

  const removeTile = async (tileId: string) => {
    if (!activePage) return;
    const next = await mutate([{ type: 'remove_tile', pageId: activePage.id, tileId }]);
    if (next) setSelectedTileId((current) => current === tileId ? null : current);
  };

  const runCanvasShortcut = async (shortcut: CanvasShortcut, targetTileId: string | null) => {
    if (shortcut.kind === 'undo') return undo();
    if (shortcut.kind === 'redo') return redo();
    if (shortcut.kind === 'deselect') {
      setSelectedTileId(null);
      setTileMenuId(null);
      return;
    }
    const tile = targetTileId ? visibleItems.find((item) => item.i === targetTileId) : undefined;
    if (!tile) return;
    setSelectedTileId(tile.i);
    if (shortcut.kind === 'duplicate') return duplicateTile(tile.i);
    if (shortcut.kind === 'remove') return removeTile(tile.i);
    if (breakpoint !== 'wide') {
      setSavedMessage('Switch the preview to Desktop to arrange tiles');
      return;
    }
    const next = shortcut.kind === 'move'
      ? nudgeGridItem(visibleItems, tile.i, shortcut.dx, shortcut.dy, CANVAS_COLUMNS)
      : resizeGridItem(visibleItems, tile.i, tile.w + shortcut.dw, tile.h + shortcut.dh, CANVAS_COLUMNS);
    await commitCanvasLayout(next, shortcut.kind === 'move' ? 'Tile moved · preview preserved' : 'Tile resized · preview preserved');
  };

  const approveSemanticPreview = async () => {
    if (!draft || !activePage || !previewRun) {
      setError('Run this page successfully before approving Metrics results.');
      return;
    }
    const approvalTiles = legacySemanticTilesNeedingApproval(draft);
    if (approvalTiles.length === 0) {
      // Dataset source lifecycle is catalog authority. Never manufacture a
      // legacy semantic approval or invalidate settled Dataset receipts here.
      setSavedMessage('No legacy Metrics tile needs approval. Dataset trust follows its current contract.');
      return;
    }
    const approval = planLegacySemanticApproval(draft, activePage, previewRun);
    if (approval.operations.length === 0) {
      const pagesToPreview = approval.pendingPageIds
        .filter((pageId) => pageId !== activePage.id)
        .map((pageId) => draft.pages.find((page) => page.id === pageId)?.metadata.title ?? pageId);
      setError(pagesToPreview.length > 0
        ? `Open ${pagesToPreview.join(', ')} and run its preview before approving its Metrics result.`
        : `Run ${activePage.metadata.title || activePage.id} successfully before approving its Metrics result.`);
      return;
    }
    const next = await mutate(approval.operations);
    if (next) setSavedMessage('Semantic results approved · run preview once more');
  };

  const removeLocalAnalysisForPublication = async () => {
    if (!draft) return;
    const sources = publicationBlockingSources(draft)
      .filter((source) => source.kind !== 'governed_semantic' && source.kind !== 'semantic_query');
    if (sources.length === 0) return;
    const sourceIds = new Set(sources.map((source) => source.id));
    const sourceRefs = new Set(sources.flatMap((source) => [source.id, source.sourceRef, source.id.replace(/^[^:]+:/, '')]));
    const removedTiles = draft.pages.flatMap((page) => page.layout.items
      .filter((tile) => {
        const blockRef = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
        const refs = [tile.draftAnalysis?.ref, blockRef].filter((value): value is string => Boolean(value));
        return refs.some((ref) => sourceRefs.has(ref) || sourceRefs.has(ref.replace(/^[^:]+:/, '')));
      })
      .map((tile) => ({ pageId: page.id, tileId: tile.i })));
    const removedTileIds = new Set(removedTiles.map((tile) => tile.tileId));
    const operations: AppStudioDraftOperation[] = [
      ...removedTiles.map((tile): AppStudioDraftOperation => ({ type: 'remove_tile', pageId: tile.pageId, tileId: tile.tileId })),
      ...sources.map((source): AppStudioDraftOperation => ({ type: 'remove_source', sourceId: source.id })),
      ...draft.reviewTasks.filter((task) => (task.sourceId && sourceIds.has(task.sourceId)) || (task.tileId && removedTileIds.has(task.tileId)))
        .map((task): AppStudioDraftOperation => ({ type: 'remove_review_task', taskId: task.id })),
      {
        type: 'set_coverage',
        coverage: draft.coverage.map((coverage) => {
          const nextSourceIds = coverage.sourceIds.filter((id) => !sourceIds.has(id));
          const nextComponentIds = coverage.componentIds.filter((id) => !removedTileIds.has(id));
          return {
            ...coverage,
            sourceIds: nextSourceIds,
            componentIds: nextComponentIds,
            ...(coverage.status === 'covered' && (nextSourceIds.length === 0 || nextComponentIds.length === 0)
              ? { status: 'gap' as const, reasons: [...coverage.reasons, 'Local analysis that needs review was removed from the publication draft.'] }
              : {}),
          };
        }),
      },
    ];
    const next = await mutate(operations);
    if (next) {
      setPublishIssues([]);
      setSavedMessage('Local analysis removed · Undo is available');
    }
  };

  const publish = async (publishWhenReady = true, targetDraft = draft) => {
    if (!targetDraft) return;
    setBusy(true);
    setError(null);
    try {
      // The confirmation button commits the exact preflight receipt already
      // shown as ready. Starting another preflight here caused readiness to
      // oscillate when source or preview state changed between two requests.
      if (publishWhenReady && targetDraft.state === 'preflight_ready' && localPublicationSteps(targetDraft).length === 0 && publishIssues.length === 0) {
        const result = await api.publishAppBuild(targetDraft.id, targetDraft.revision, targetDraft.proposalHash);
        setDraft(result.draft);
        setPublishReviewOpen(false);
        onPublished(result.app, result.draft.pages[0]?.id);
        return;
      }
      const preflight = await api.preflightAppBuild(targetDraft.id, targetDraft.revision, targetDraft.proposalHash);
      setDraft(preflight.draft);
      if (!publishWhenReady) {
        setPublishIssues([]);
        setPublishReviewOpen(true);
        return;
      }
      const result = await api.publishAppBuild(preflight.draft.id, preflight.draft.revision, preflight.draft.proposalHash);
      setDraft(result.draft);
      setPublishReviewOpen(false);
      onPublished(result.app, result.draft.pages[0]?.id);
    } catch (cause) {
      const details = cause instanceof DqlApiError && cause.details && typeof cause.details === 'object'
        ? cause.details as { errors?: unknown; draft?: unknown }
        : null;
      const errors = Array.isArray(details?.errors)
        ? details.errors.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (errors.length) {
        if (details?.draft && typeof details.draft === 'object') setDraft(details.draft as AppStudioBuildDraft);
        setPublishIssues(errors);
        setPublishReviewOpen(true);
      } else {
        setError(`Project publication needs attention. ${messageOf(cause)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const removeRequirementFromPublishScope = async (requirementId: string) => {
    if (!draft) return;
    const next = await mutate([{
      type: 'set_requirements',
      requirements: draft.requirements.map((requirement) => (
        requirement.id === requirementId ? { ...requirement, required: false } : requirement
      )),
      coverage: draft.coverage,
    }]);
    if (next) setPublishIssues([]);
  };

  const reviseRequirementWithAi = (question: string) => {
    if (!draft) return;
    const instruction = `Revise this App so it can answer this publish question with governed evidence: ${question}`;
    setPrompt(instruction);
    setPublishReviewOpen(false);
    void requestAiProposal(draft, instruction);
  };

  const answerBuildFrameQuestion = async (questionId: string, answerId: string) => {
    if (!draft) return;
    const clarificationQuestions = (draft.frame.clarificationQuestions ?? []).map((question) => (
      question.id === questionId ? { ...question, answerId } : question
    ));
    const next = await mutate([{ type: 'set_frame', frame: { ...draft.frame, clarificationQuestions } }]);
    if (next) setPublishIssues([]);
  };

  const refreshCertifiedSourceTrust = async () => {
    if (!draft) return;
    const operations: AppStudioDraftOperation[] = [];
    const blockSources = draft.sources.filter((item) => item.kind === 'block' || item.kind === 'certified_block' || item.kind === 'review_block');
    const resolved = await api.resolveAppSourceCandidates(draft.id, blockSources.map((source) => source.id));
    const byId = new Map(resolved.items.map((source) => [source.id, source]));
    const unavailableSources = blockSources.filter((source) => !byId.has(source.id));
    if (unavailableSources.length) {
      setPublishReviewOpen(false);
      setPanel('sources');
      setPanelOpen(true);
      setError(`${unavailableSources.map((source) => humanize(source.sourceRef)).join(', ')} ${unavailableSources.length === 1 ? 'is' : 'are'} no longer certified. Replace or remove ${unavailableSources.length === 1 ? 'this source' : 'these sources'} before publication.`);
      return;
    }
    for (const source of blockSources) {
      const block = byId.get(source.id);
      if (block && block.lifecycle === 'certified' && (source.sourceRevision !== block.sourceRevision || source.trustState !== 'certified' || source.reviewStatus !== 'not_required')) {
        operations.push({
          type: 'upsert_source',
          source: {
            ...source,
            kind: 'block',
            sourceRef: block.path,
            sourcePath: block.path,
            executionRef: block.path,
            qualifiedIdentity: block.qualifiedIdentity,
            snapshotId: block.snapshotId,
            sourceRevision: block.sourceRevision,
            sourceFingerprint: block.sourceRevision,
            lifecycle: 'certified',
            capabilities: block.capabilities,
            trustState: 'certified',
            reviewStatus: 'not_required',
          },
        });
      }
    }
    for (const page of draft.pages) {
      for (const tile of page.layout.items) {
        if (!tile.sourceId) continue;
        const block = byId.get(tile.sourceId);
        if (!block || block.lifecycle !== 'certified') continue;
        if (tile.sourceRevision !== block.sourceRevision || tile.review?.sourceFingerprint !== block.sourceRevision || tile.review?.status !== 'not_required') {
          operations.push({
            type: 'update_tile',
            pageId: page.id,
            tileId: tile.i,
            patch: {
              sourceRevision: block.sourceRevision,
              block: { ref: block.path },
              sourceClass: 'certified_block',
              trustState: 'certified',
              reviewStatus: 'certified',
              review: { ...tile.review, status: 'not_required', sourceFingerprint: block.sourceRevision },
            },
          });
        }
      }
    }
    if (!operations.length) {
      setPublishIssues([]);
      setSavedMessage('Certified sources are already current');
      await publish(false);
      return;
    }
    const next = await mutate(operations);
    if (next) {
      setPublishIssues([]);
      setSavedMessage('Source trust refreshed · run preview again');
    }
  };

  /**
   * A capability-free Dataset placeholder is deliberately non-executable. A
   * Resolve action for its server-created drift task first checks the current
   * catalog, then sends an identity-only upsert that the API canonicalizes.
   * Other review tasks keep their existing explicit local resolution flow.
   */
  const resolveReviewTask = async (task: AppStudioBuildDraft['reviewTasks'][number]) => {
    if (!draft) return;
    if (!isDatasetSourceRecoveryTask(draft, task)) {
      const next = await mutate([{ type: 'set_review_task', task: { ...task, status: 'resolved' } }]);
      if (next) setPublishIssues([]);
      return;
    }
    if (!task.sourceId) return;
    setBusy(true);
    setSavedMessage('Checking current Dataset source…');
    setError(null);
    try {
      const recovery = await runDatasetSourceRecoveryAction({
        draft,
        task,
        resolveCandidates: (draftId, sourceIds) => api.resolveAppSourceCandidates(draftId, sourceIds),
        patchDraft: (draftId, expectedRevision, operations, expectedProposalHash) => (
          api.patchAppBuild(draftId, expectedRevision, operations, expectedProposalHash)
        ),
        onPreviewInvalidated: () => {
          previewSequenceRef.current += 1;
          setPreviewRunsByPage({});
          setFilterOptionsByPage({});
          setPreviewing(false);
        },
      });
      if (!recovery.ok) {
        setSavedMessage('Dataset source still needs repair');
        setError(recovery.error);
        setPanel('sources');
        setPanelOpen(true);
        return;
      }
      // Keep this one request atomic: canonical source authority, derived tile
      // display state, and only the exact drift tasks change together.
      const previous = draft;
      setDraft(recovery.draft);
      setUndoStack((items) => [...items.slice(-29), previous]);
      setRedoStack([]);
      setPublishIssues([]);
      setSavedMessage('Dataset source restored · run a current preview');
    } catch (cause) {
      setSavedMessage('Dataset source restoration failed');
      setError(messageOf(cause));
      setPanel('sources');
      setPanelOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const deleteLocalDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const deleted = await api.deleteAppBuild(draft.id, draft.revision, draft.proposalHash);
      onDraftDeleted({ appName: draft.name, recoveryId: deleted.recoveryId });
    } catch (cause) {
      setDeleteConfirmOpen(false);
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  async function runPreviewForDraft(
    targetDraft: AppStudioBuildDraft,
    pageId: string,
    variablesOverride?: Record<string, unknown>,
    crossFiltersOverride?: StudioDatasetCrossFilter[],
    interaction?: {
      hierarchyDrills?: DashboardDatasetHierarchyDrill[];
      affectedTileIds?: string[];
      /** A rerun of just the tiles an edit changed. */
      edit?: boolean;
      /** Explicit user refresh bypasses the optional local result cache. */
      refresh?: boolean;
    },
  ): Promise<AppStudioBuildDraft | null> {
    const page = targetDraft.pages.find((candidate) => candidate.id === pageId);
    if (!page) return null;
    const hierarchyDrills = interaction?.hierarchyDrills ?? [];
    const affectedTileIds = [...new Set([
      ...(interaction?.affectedTileIds ?? []),
      ...hierarchyDrills.map((drill) => drill.tileId),
    ])];
    const boundedInteraction = affectedTileIds.length > 0;
    const priorPreview = previewRunsByPage[page.id];
    const sequence = previewSequenceRef.current + 1;
    previewSequenceRef.current = sequence;
    setActivePageId(page.id);
    setPreviewing(true);
    setError(null);
    // A changed filter/source scope must not continue to present old rows as
    // the current preview while this full run is in flight. An interaction
    // keeps only unrelated tiles visible; its selected tile is removed until
    // the server validates the drill against the current source/query.
    setPreviewRunsByPage((current) => {
      if (!current[page.id]) return current;
      const next = { ...current };
      if (!boundedInteraction) {
        delete next[page.id];
      } else {
        next[page.id] = {
          ...current[page.id]!,
          partial: true,
          facts: [],
          filterOptions: undefined,
          tiles: current[page.id]!.tiles.filter((tile) => !affectedTileIds.includes(tile.tileId)),
        };
      }
      return next;
    });
    if (!boundedInteraction) {
      setPreviewHierarchyDrillsByPage((current) => {
        if (!current[page.id]) return current;
        const { [page.id]: _cleared, ...remaining } = current;
        return remaining;
      });
    }
    try {
      const variables = previewVariablesForPage(
        page,
        variablesOverride ?? previewVariablesByPage[page.id] ?? {},
      );
      const crossFilters = crossFiltersOverride ?? previewCrossFiltersByPage[page.id] ?? [];
      const result = await api.runAppBuildPreview(targetDraft.id, page.id, variables, crossFilters, {
        runScope: previewRunScopeRef.current,
        ...(interaction?.refresh ? { refresh: true } : {}),
        // A preview receipt is eligible for local publication only after every
        // authored component has run in the current draft scope. Hierarchy
        // exploration is deliberately bounded and stays read-only.
        ...(boundedInteraction ? { affectedTileIds } : { fullRun: true }),
        ...(hierarchyDrills.length ? { datasetDrills: hierarchyDrills } : {}),
      });
      if (sequence !== previewSequenceRef.current) return null;
      // Store the runtime envelope before considering publication evidence.
      // A mixed run has safe current rows and governed component errors; the
      // strict receipt API will reject it, but that must not discard sibling
      // results from the Studio.
      const displayed = result.partial && boundedInteraction && priorPreview
        ? mergeStudioPartialPreview(priorPreview, result, page.layout.items)
        : result;
      setPreviewRunsByPage((current) => ({ ...current, [page.id]: displayed }));
      if (result.filterOptions?.length) {
        setFilterOptionsByPage((current) => {
          const pageOptions = { ...(current[page.id] ?? {}) };
          for (const optionSet of result.filterOptions ?? []) {
            const cached = pageOptions[optionSet.filterId];
            pageOptions[optionSet.filterId] = {
              values: Array.from(new Set([
              ...(cached?.values ?? []),
              ...optionSet.values,
              ])).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })),
              truncated: Boolean(cached?.truncated || optionSet.truncated),
              valueCount: optionSet.valueCount ?? cached?.valueCount,
              dateRange: mergeStudioDateRanges(cached?.dateRange, optionSet.dateRange),
            };
          }
          return { ...current, [page.id]: pageOptions };
        });
      }
      const settlement = settleStudioPreviewRun(result);
      if (settlement.kind !== 'receipt_candidate') {
        if (settlement.kind === 'incomplete' && settlement.clearStoredReceipt) {
          setDraft((current) => current
            && current.id === targetDraft.id
            && current.proposalHash === targetDraft.proposalHash
            ? withoutPagePreviewReceipt(current, page.id)
            : current);
        }
        if (settlement.kind === 'incomplete') setPublishIssues([settlement.message]);
        setSavedMessage(interaction?.edit && result.partial && settlement.kind === 'unavailable'
          ? `Updated ${affectedTileIds.length === 1 ? '1 tile' : `${affectedTileIds.length} tiles`} · Run the whole page before publishing`
          : settlement.message);
        return null;
      }
      const recorded = await api.patchAppBuild(targetDraft.id, targetDraft.revision, [{
        type: 'set_preview_receipt',
        receipt: {
          id: result.runId,
          pageId: page.id,
          revision: targetDraft.revision,
          snapshotId: result.snapshotId,
          filterFingerprint: result.filterFingerprint,
          resultFingerprint: result.resultFingerprint,
          createdAt: new Date().toISOString(),
        },
      }], targetDraft.proposalHash);
      if (sequence !== previewSequenceRef.current) return null;
      setDraft(recorded.draft);
      setPublishIssues([]);
      setSavedMessage(`Preview settled · ${settlement.readyCount}/${settlement.totalCount} ready`);
      return recorded.draft;
    } catch (cause) {
      if (sequence === previewSequenceRef.current) setError(messageOf(cause));
      return null;
    } finally {
      if (sequence === previewSequenceRef.current) setPreviewing(false);
    }
  }

  const runPreview = async (pageId = activePage?.id, refresh = false) => {
    if (!draft || !pageId) return;
    await runPreviewForDraft(draft, pageId, undefined, undefined, refresh ? { refresh: true } : undefined);
  };

  const runPreviewAndReview = async (pageId: string) => {
    if (!draft || !pageId) return;
    const recorded = await runPreviewForDraft(draft, pageId, undefined, undefined, { refresh: true });
    if (!recorded) return;
    setPublishIssues([]);
    await publish(false, recorded);
  };

  const runAllPreviewsAndReview = async () => {
    if (!draft) return;
    let current = draft;
    const pages = current.pages.filter((page) => pageHasDataTiles(page));
    for (const page of pages) {
      const recorded = await runPreviewForDraft(current, page.id, previewVariablesForPage(page), undefined, { refresh: true });
      if (!recorded) return;
      current = recorded;
    }
    setPublishIssues([]);
    await publish(false, current);
  };

  // One Publish button: pages that only need a fresh run are run first, so
  // the review lists only what needs the author.
  const publishFromToolbar = async () => {
    if (!draft) return;
    const stale = pagesNeedingSettledPreview(draft);
    if (!stale.length) {
      await publish(false);
      return;
    }
    let current = draft;
    for (const page of stale) {
      const recorded = await runPreviewForDraft(current, page.id, previewVariablesForPage(page), undefined, { refresh: true });
      if (!recorded) return;
      current = recorded;
    }
    setPublishIssues([]);
    await publish(false, current);
  };

  const applyFilterValue = (filter: NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number], value: unknown) => {
    if (!draft || !activePage) return;
    const pageId = activePage.id;
    const linkedPageIds = new Set(pagesForDashboardFilterValue(draft.pages, pageId, filter));
    const nextVariablesByPage = { ...previewVariablesByPage };
    for (const linkedPageId of linkedPageIds) {
      nextVariablesByPage[linkedPageId] = { ...(nextVariablesByPage[linkedPageId] ?? {}), [filter.id]: value };
    }
    const nextAppScopedValues = isAppScopedDashboardFilter(filter)
      ? { ...previewAppScopedFilterValues, [filter.id]: value }
      : previewAppScopedFilterValues;
    if (isAppScopedDashboardFilter(filter)) setPreviewAppScopedFilterValues(nextAppScopedValues);
    const nextVariables = previewVariablesForPage(
      activePage,
      nextVariablesByPage[pageId] ?? { [filter.id]: value },
      nextAppScopedValues,
    );
    setPreviewVariablesByPage(nextVariablesByPage);
    setPreviewHierarchyDrillsByPage((current) => {
      const next = { ...current };
      for (const linkedPageId of linkedPageIds) delete next[linkedPageId];
      return next;
    });
    setPreviewRunsByPage((current) => {
      const next = { ...current };
      for (const linkedPageId of linkedPageIds) delete next[linkedPageId];
      return next;
    });
    previewSequenceRef.current += 1;
    setPreviewing(false);
    if (filterPreviewTimerRef.current !== null) window.clearTimeout(filterPreviewTimerRef.current);
    const range = filter.type === 'daterange' && value && typeof value === 'object' && !Array.isArray(value)
      ? value as { start?: string; end?: string }
      : null;
    if (range && Boolean(range.start) !== Boolean(range.end)) {
      setSavedMessage(`Choose both ${filter.label ?? humanize(filter.id)} dates`);
      return;
    }
    setSavedMessage(`${filter.label ?? humanize(filter.id)} changed · applying automatically…`);
    filterPreviewTimerRef.current = window.setTimeout(() => {
      filterPreviewTimerRef.current = null;
      void runPreviewForDraft(draft, pageId, nextVariables);
    }, 320);
  };

  const applyDatasetCrossFilter = (tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number], field: string, values: unknown[], exclude = false) => {
    if (!draft || !activePage || !tile.query || !tile.sourceId || !tile.sourceRevision) return;
    const output = tileQueryOutputAliases(tile.query).find((candidate) => candidate.kind === 'dimension' && candidate.alias === field);
    const mappings = activePage.interactions?.crossFilter?.mappings.filter((mapping) => mapping.fromTileId === tile.i && mapping.fromField === field) ?? [];
    const distinctValues = [...new Map(values.filter((value) => value !== undefined && value !== null).map((value) => [JSON.stringify(value), value])).values()];
    // Keep only / Exclude on the tile's own Dataset needs no mapping (RFC 0009 step 6a).
    const own = tile.query.dimensions.some((dimension) => !dimension.timeGrain && (dimension.alias ?? dimension.field) === field)
      && Boolean(activePage.datasets?.some((dataset) => dataset.sourceId === tile.sourceId && dataset.sourceRevision === tile.sourceRevision));
    if (!output || (mappings.length === 0 && !own) || distinctValues.length === 0) {
      setSavedMessage(`No explicit Dataset mapping is configured for ${humanize(field)}. Open this tile’s interaction settings to map it.`);
      return;
    }
    const nextCrossFilter: StudioDatasetCrossFilter = {
      fromTileId: tile.i,
      fromSourceId: tile.sourceId,
      fromSourceRevision: tile.sourceRevision,
      field: output.alias,
      values: distinctValues,
      ...(exclude ? { exclude: true } : {}),
    };
    const nextForPage = [
      ...previewCrossFilters.filter((candidate) => !(candidate.fromTileId === tile.i && candidate.field === output.alias)),
      nextCrossFilter,
    ];
    setPreviewCrossFiltersByPage((current) => ({ ...current, [activePage.id]: nextForPage }));
    setPreviewHierarchyDrillsByPage((current) => {
      const { [activePage.id]: _cleared, ...remaining } = current;
      return remaining;
    });
    setPreviewRunsByPage((current) => {
      const { [activePage.id]: _stale, ...remaining } = current;
      return remaining;
    });
    previewSequenceRef.current += 1;
    setPreviewing(false);
    setSavedMessage(`${exclude ? 'Leaving out' : 'Keeping only'} ${humanize(field)} ${distinctValues.map(String).join(', ')} in this preview.`);
    void runPreviewForDraft(draft, activePage.id, previewVariables, nextForPage);
  };

  const clearDatasetCrossFilters = () => {
    if (!draft || !activePage || previewCrossFilters.length === 0) return;
    setPreviewCrossFiltersByPage((current) => ({ ...current, [activePage.id]: [] }));
    setPreviewHierarchyDrillsByPage((current) => {
      const { [activePage.id]: _cleared, ...remaining } = current;
      return remaining;
    });
    setPreviewRunsByPage((current) => {
      const { [activePage.id]: _stale, ...remaining } = current;
      return remaining;
    });
    previewSequenceRef.current += 1;
    setPreviewing(false);
    setSavedMessage('Selected result marks cleared. Refreshing mapped Dataset tiles…');
    void runPreviewForDraft(draft, activePage.id, previewVariables, []);
  };

  const removeDatasetCrossFilter = (fromTileId: string, field: string) => {
    if (!draft || !activePage) return;
    const nextForPage = previewCrossFilters.filter((filter) => !(filter.fromTileId === fromTileId && filter.field === field));
    setPreviewCrossFiltersByPage((current) => ({ ...current, [activePage.id]: nextForPage }));
    setPreviewHierarchyDrillsByPage((current) => {
      const { [activePage.id]: _cleared, ...remaining } = current;
      return remaining;
    });
    setPreviewRunsByPage((current) => {
      const { [activePage.id]: _stale, ...remaining } = current;
      return remaining;
    });
    previewSequenceRef.current += 1;
    setPreviewing(false);
    setSavedMessage(`${humanize(field)} result mark cleared. Refreshing mapped Dataset tiles…`);
    void runPreviewForDraft(draft, activePage.id, previewVariables, nextForPage);
  };

  const exploreDatasetHierarchy = (
    tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
    candidate: RuntimeDatasetHierarchyDrillCandidate,
    row: Record<string, unknown>,
  ) => {
    if (!draft || !activePage) return;
    const next = appendDatasetHierarchyDrill(previewHierarchyDrills, tile.i, candidate, row);
    if (!next.drills) {
      setSavedMessage(next.error ?? 'This result mark cannot be used for the declared hierarchy.');
      return;
    }
    setPreviewHierarchyDrillsByPage((current) => ({ ...current, [activePage.id]: next.drills! }));
    setSavedMessage(`Exploring ${humanize(candidate.toField)} · unsaved hierarchy view…`);
    void runPreviewForDraft(draft, activePage.id, previewVariables, previewCrossFilters, {
      hierarchyDrills: next.drills,
      affectedTileIds: next.drills.map((drill) => drill.tileId),
    });
  };

  const returnFromDatasetHierarchy = (tileId: string) => {
    if (!draft || !activePage) return;
    const next = popDatasetHierarchyDrill(previewHierarchyDrills, tileId);
    if (next.length === previewHierarchyDrills.length
      && !previewHierarchyDrills.some((drill) => drill.tileId === tileId)) return;
    const affectedTileIds = [...new Set([tileId, ...next.map((drill) => drill.tileId)])];
    setPreviewHierarchyDrillsByPage((current) => ({ ...current, [activePage.id]: next }));
    setSavedMessage('Returned to the previous declared grouping · unsaved hierarchy view…');
    void runPreviewForDraft(draft, activePage.id, previewVariables, previewCrossFilters, {
      hierarchyDrills: next,
      affectedTileIds,
    });
  };

  const navigateFromDatasetTile = (tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) => {
    if (!draft || !activePage) return;
    const navigation = activePage.interactions?.navigate?.find((candidate) => candidate.fromTile === tile.i);
    const targetPage = navigation ? draft.pages.find((page) => page.id === navigation.toPage) : undefined;
    if (!navigation || !targetPage) {
      setSavedMessage('No detail-page navigation is configured for this tile. Open its interaction settings to add one.');
      return;
    }
    const withMarks = carriedNavigationVariables({
      page: activePage,
      tile,
      carryFilterIds: navigation.carryFilters,
      variables: previewVariables,
      crossFilters: previewCrossFilters,
    });
    const carried = Object.fromEntries(navigation.carryFilters
      .filter((filterId) => withMarks[filterId] !== undefined)
      .map((filterId) => [filterId, withMarks[filterId]]));
    const nextVariables = previewVariablesForPage(targetPage, {
      ...(previewVariablesByPage[targetPage.id] ?? {}),
      ...carried,
    });
    setPreviewVariablesByPage((current) => ({ ...current, [targetPage.id]: nextVariables }));
    setActivePageId(targetPage.id);
    setSelectedTileId(null);
    setSavedMessage(`Opened ${targetPage.metadata.title} with ${Object.keys(carried).length ? 'carried' : 'no'} shared filters.`);
    void runPreviewForDraft(draft, targetPage.id, nextVariables, []);
  };

  useEffect(() => {
    if (!draft || !activePage || proposal || previewing || previewRunsByPage[activePage.id] || !pageHasDataTiles(activePage)) return;
    const timer = window.setTimeout(() => {
      void runPreviewForDraft(draft, activePage.id, previewVariablesForPage(activePage));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activePage?.id, draft?.revision, proposal]);

  // Undo survives a reload: the stacks are kept per draft in this browser.
  useEffect(() => {
    if (!draft?.id || historyDraftId === draft.id) return;
    const stored = loadStudioHistory(draft.id);
    setUndoStack(stored.undo);
    setRedoStack(stored.redo);
    setHistoryDraftId(draft.id);
  }, [draft?.id, historyDraftId]);
  useEffect(() => {
    if (!historyDraftId || historyDraftId !== draft?.id) return;
    saveStudioHistory(historyDraftId, { undo: undoStack, redo: redoStack });
  }, [historyDraftId, draft?.id, undoStack, redoStack]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => canvasKeyHandlerRef.current?.(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pointer tracking for a move or resize. The preview settles on every step,
  // so neighbours make room while the pointer is still down.
  const gestureActive = Boolean(gesture && !gesture.committing);
  useEffect(() => {
    if (!gestureActive) return;
    const onMove = (event: PointerEvent) => {
      const current = gestureRef.current;
      if (!current || current.committing || event.pointerId !== current.pointerId) return;
      const dx = cellsFromPixels(event.clientX - current.startX, current.columnPx);
      const dy = cellsFromPixels(event.clientY - current.startY, current.rowStepPx);
      const { origin } = current;
      const items = current.kind === 'move'
        ? moveGridItem(current.base, origin.i, origin.x + dx, origin.y + dy, CANVAS_COLUMNS)
        : resizeGridItem(
          current.base,
          origin.i,
          origin.w + (current.kind === 'resize-s' ? 0 : dx),
          origin.h + (current.kind === 'resize-e' ? 0 : dy),
          CANVAS_COLUMNS,
        );
      const next = { ...current, items, moved: current.moved || dx !== 0 || dy !== 0 };
      gestureRef.current = next;
      setGesture(next);
    };
    const onEnd = (event: PointerEvent) => {
      const current = gestureRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (event.type === 'pointercancel' || !current.moved) {
        gestureRef.current = null;
        setGesture(null);
        return;
      }
      const committing = { ...current, committing: true };
      gestureRef.current = committing;
      setGesture(committing);
      commitGestureRef.current?.(committing);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [gestureActive]);

  useEffect(() => () => {
    if (filterPreviewTimerRef.current !== null) window.clearTimeout(filterPreviewTimerRef.current);
    if (sourceFeedbackTimerRef.current !== null) window.clearTimeout(sourceFeedbackTimerRef.current);
  }, []);

  // ─── The click menu and Explore panel (RFC 0009 step 6a) ────────────────
  const { openMarkMenu, overlays: markOverlays } = useMarkInteractions({
    themeMode,
    runProbe: (options) => {
      if (!draft || !activePage) return Promise.reject(new Error('Open a page first.'));
      return api.runAppBuildPreview(draft.id, activePage.id, previewVariablesForPage(activePage, previewVariablesByPage[activePage.id] ?? {}), previewCrossFilters, options);
    },
    drillsFor: (tileId) => previewHierarchyDrills.find((drill) => drill.tileId === tileId)?.steps,
    keepOrExclude: (item, field, value, exclude) => {
      const tile = activePage?.layout.items.find((candidate) => candidate.i === item.i);
      if (tile) applyDatasetCrossFilter(tile, field, [value], exclude);
    },
    drillDown: (item, candidate, row) => {
      const tile = activePage?.layout.items.find((entry) => entry.i === item.i);
      if (tile) exploreDatasetHierarchy(tile, candidate, row);
    },
    hasDetailsPage: (tileId) => Boolean(activePage?.interactions?.navigate?.some((interaction) => interaction.fromTile === tileId)),
    openDetailsPage: (tileId) => {
      const tile = activePage?.layout.items.find((candidate) => candidate.i === tileId);
      if (tile) navigateFromDatasetTile(tile);
    },
    ...(activePage?.interactions?.detail?.columns?.length ? { authoredColumns: activePage.interactions.detail.columns } : {}),
    label: humanize,
    saveAsTile: (item, query, title) => {
      const source = datasetItemForSource(item.sourceId);
      const descriptor = item.sourceId ? draft?.sources.find((candidate) => candidate.id === item.sourceId)?.capabilities?.dataset : undefined;
      if (!source) { setError('This tile\'s Dataset is not in the Data panel.'); return; }
      // Show Me picks the chart for the saved view, as it does for any new tile.
      const choice = !query.detail && descriptor ? showMeFirstChoice(showMeInputFromQuery(query, showMeFactsFromDescriptor(descriptor as DatasetDescriptor))) : undefined;
      const view = query.detail || choice?.viz === 'table' ? 'table' : choice?.viz === 'single_value' ? 'kpi' : 'chart';
      void addComponent(view, source, query, title, (choice?.viz ?? 'table') as AppStudioBuildDraft['pages'][number]['layout']['items'][number]['viz']['type'], choice?.encoding);
    },
  });

  // Open a Dataset just started from a table once the catalog lists it.
  // chooseDataset is declared after the early return below, so it is reached through a ref.
  const chooseDatasetRef = useRef<((item: AppBlockRecommendation) => void) | null>(null);
  useEffect(() => {
    if (!pendingDatasetSourceId) return;
    const item = catalog.find((candidate) => candidate.capabilities?.dataset && (candidate.sourceId ?? candidate.id) === pendingDatasetSourceId);
    if (!item || !chooseDatasetRef.current) return;
    setPendingDatasetSourceId(null);
    chooseDatasetRef.current(item);
  }, [catalog, pendingDatasetSourceId]);

  if (!draft) {
    return <div className="dql-studio-v2-loading">
      <style>{APP_STUDIO_V2_STYLES}</style>
      <button type="button" className="icon" onClick={onBack} aria-label="Back to Apps"><ArrowLeft size={18} /></button>
      <div><span className="loading-mark"><LayoutDashboard size={20} /></span><strong>{error ? 'Studio could not open' : initialDraftId ? 'Opening your local draft…' : baseAppId ? 'Preparing a safe edit draft…' : 'Opening Studio…'}</strong><small>{error ?? 'Your work stays private until you publish it.'}</small>{error ? <button type="button" onClick={() => { immediateStartRef.current = false; void createDraft(); }}>Try again</button> : null}</div>
    </div>;
  }


  const selectedSourceKind = selectedSource ? recommendedComponentKind(selectedSource) : null;
  const selectedSourceId = selectedSource?.sourceId ?? selectedSource?.id;
  const selectedSourceFeedback = sourceFeedback?.sourceId === selectedSourceId ? sourceFeedback : null;
  const selectedSourceAction = selectedSource && selectedSourceKind ? appStudioSourceActionLabel({
    view: componentKindLabel(selectedSourceKind),
    status: selectedSourceFeedback?.status ?? 'idle',
    reviewRequired: selectedSource.eligibility?.localPreview === false && draft.sourcePolicy === 'governed_only',
    alreadyUsed: draft.sources.some((source) => source.id === selectedSourceId || source.sourceRef === selectedSource.path),
    pageTitle: selectedSourceFeedback?.pageTitle,
  }) : '';

  const editing = studioView === 'edit';
  const rightPane: 'none' | 'inspector' | 'settings' | 'ai' | 'draft' | 'proposal' = proposal || aiActivity
    ? 'proposal'
    : copilotOpen
      ? 'ai'
      : !editing
        ? 'none'
        : draftTile
          ? 'draft'
          : selectedTile
            ? 'inspector'
            : settingsOpen ? 'settings' : 'none';
  const datasetItems = catalog.filter((item) => Boolean(item.capabilities?.dataset));
  // An open AI proposal (page plan or tile change) is drawn on the canvas.
  const proposalOperations = proposal
    ? operationsForSelectedAppStudioSources(proposal, selectedProposalSourceIds)
    : autopilotReview?.operations ?? null;
  const projectedPages = proposalOperations ? projectProposal(draft.pages, proposalOperations) : null;
  const projectedPage: ProposedPage | null = projectedPages
    ? (proposalPageId ? projectedPages.find((page) => page.id === proposalPageId) : undefined)
      ?? projectedPages.find((page) => page.id === activePage?.id && page.changeCount > 0)
      ?? projectedPages.find((page) => page.changeCount > 0)
      ?? projectedPages.find((page) => page.id === activePage?.id)
      ?? projectedPages[0]
      ?? null
    : null;
  /** Tiles can be dragged and resized on the Desktop canvas while editing a saved page. */
  const placedGrid = breakpoint === 'wide' && !projectedPage;
  // Story layout (RFC 0008 step 8).
  const storyMode = Boolean(activePage?.narrative?.presentation === 'story' && !projectedPage);
  // Governed HTML page (RFC 0008 step 9).
  const canvasMode = Boolean(activePage?.narrative?.presentation === 'canvas' && !projectedPage);
  const storyCatalog = previewRun ? buildStoryBindingCatalog(previewRun.tiles as StoryBindingTileInput[], Object.fromEntries((activePage?.layout.items ?? []).map((item) => [item.i, item.title]))) : {};
  const storyPageTiles = (activePage?.layout.items ?? []).filter((item) => !item.text).map((item) => ({ tileId: item.i, title: item.title || humanize(item.i) }));
  const storyDraftBlocked = !previewRun
    ? 'Run the page first: the report is drafted from its latest complete results.'
    : previewRun.partial || previewRun.incomplete
      ? 'Run the whole page first: the last run covered only some tiles.'
      : null;
  const setPresentation = async (presentation: 'dashboard' | 'story' | 'canvas') => {
    if (!activePage) return;
    const current = activePage.narrative;
    if ((current?.presentation ?? 'dashboard') === presentation) return;
    const next = await mutate([{ type: 'set_narrative', pageId: activePage.id, narrative: { ...(current ?? { version: 1, blocks: [] }), version: 1, presentation } }]);
    if (next) setSavedMessage(`Readers now see this page as ${presentation === 'dashboard' ? 'a dashboard' : presentation === 'story' ? 'a report' : 'a custom layout'}`);
  };
  const draftStory = async (instruction: string) => {
    if (!draft || !activePage || !previewRun || storyDraftBlocked) return;
    setStoryDrafting(true);
    setError(null);
    try {
      const result = await api.draftAppBuildStory(draft.id, activePage.id, previewRun.runId, instruction || undefined);
      if (!result.ok) throw new Error(result.error ?? 'The report could not be drafted.');
      setStoryProposal({ pageId: activePage.id, result });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setStoryDrafting(false);
    }
  };
  const proposalForPage = storyProposal && storyProposal.pageId === activePage?.id ? storyProposal.result : null;
  const draftCanvas = async (instruction: string) => {
    if (!draft || !activePage || !previewRun || storyDraftBlocked) return;
    setCanvasDrafting(true);
    setError(null);
    try {
      const result = await api.draftAppBuildCanvas(draft.id, activePage.id, previewRun.runId, instruction || undefined);
      if (!result.ok) throw new Error(result.error ?? 'The page could not be designed.');
      setCanvasProposal({ pageId: activePage.id, result });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setCanvasDrafting(false);
    }
  };
  const canvasProposalForPage = canvasProposal && canvasProposal.pageId === activePage?.id ? canvasProposal.result : null;
  // Numbers in a report or layout preview explain themselves, as readers will see them.
  const numberReceiptFor = (key: string) => numberReceiptInfo(storyCatalog[key], activePage?.layout.items ?? [], previewRun ?? null, undefined, storyCatalog);
  const renderCanvas = (canvas: NonNullable<typeof canvasProposalForPage>['canvas'], canvasEditing?: CanvasFrameEditing) => activePage ? (
    <CanvasPageFrame canvas={canvas} catalog={storyCatalog} items={activePage.layout.items} tiles={previewRun?.tiles ?? []} themeMode={themeMode} loading={previewing} {...(canvasEditing ? { editing: canvasEditing } : { onMark: (item, tile, row, pointer) => openMarkMenu(item, tile, row, pointer, []), receiptFor: numberReceiptFor })} />
  ) : null;
  const canvasArea = activePage ? (
    editing ? <div className="studio-canvas-page">
      {canvasProposalForPage ? <div className={`proposal-banner ${canvasProposalForPage.generatedBy === 'ai' ? '' : 'warn'}`} role="status">
        <Sparkles size={14} />
        <span>
          <strong>{canvasProposalForPage.generatedBy === 'ai' ? `Designed by ${canvasProposalForPage.model ?? 'AI'}` : 'A template from the data'}</strong>
          {' · '}{canvasProposalForPage.generatedBy === 'ai'
            ? `checked: no scripts, no network, every figure bound${canvasProposalForPage.attempts > 1 ? ' (second attempt)' : ''} · ${(canvasProposalForPage.elapsedMs / 1000).toFixed(0)} s.`
            : "the model's designs did not pass the check, so this is a plain layout from the page's values."}
          {' '}Nothing is saved until you apply.
        </span>
        <span className="proposal-banner-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => { void mutate([{ type: 'set_canvas', pageId: activePage.id, canvas: canvasProposalForPage.canvas }]).then((next) => { if (next) { setCanvasProposal(null); setSavedMessage('Layout applied'); } }); }}>Apply</button>
          <button type="button" onClick={() => setCanvasProposal(null)}>Discard</button>
        </span>
      </div> : null}
      {canvasProposalForPage
        ? renderCanvas(canvasProposalForPage.canvas)
        : <CanvasEditor
          canvas={activePage.canvas}
          catalog={storyCatalog}
          pageTiles={storyPageTiles}
          disabled={busy}
          preview={renderCanvas}
          onChange={(canvas) => void mutate([{ type: 'set_canvas', pageId: activePage.id, canvas }])}
          onDraft={(instruction) => void draftCanvas(instruction)}
          drafting={canvasDrafting}
          draftBlockedReason={storyDraftBlocked}
          selectedTileId={selectedTileId}
          onSelectTile={(tileId) => { setSelectedTileId(tileId); setSettingsOpen(false); setTileMenuId(null); }}
        />}
    </div> : activePage.canvas ? renderCanvas(activePage.canvas) : <p className="studio-story-empty">This custom layout is empty.</p>
  ) : null;
  const storyArea = activePage ? (
    editing ? <div className="studio-story">
      {proposalForPage ? <div className={`proposal-banner ${proposalForPage.generatedBy === 'ai' ? '' : 'warn'}`} role="status">
        <Sparkles size={14} />
        <span>
          <strong>{proposalForPage.generatedBy === 'ai' ? `Drafted by ${proposalForPage.model ?? 'AI'}` : 'Drafted from the data'}</strong>
          {' · '}{proposalForPage.generatedBy === 'ai'
            ? `checked: every figure is bound${proposalForPage.attempts > 1 ? ' (second attempt)' : ''}; ${proposalForPage.sawValues ? 'the local model saw current values' : 'the model saw field names only'} · ${(proposalForPage.elapsedMs / 1000).toFixed(0)} s.`
            : `the model's drafts broke the rules, so this one was written from the page's values alone.`}
          {' '}Nothing is saved until you apply.
        </span>
        <span className="proposal-banner-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => { void mutate([{ type: 'set_narrative', pageId: activePage.id, narrative: { ...proposalForPage.narrative, presentation: 'story' } }]).then((next) => { if (next) { setStoryProposal(null); setSavedMessage('Report applied'); } }); }}>Apply</button>
          <button type="button" onClick={() => setStoryProposal(null)}>Discard</button>
        </span>
      </div> : null}
      {proposalForPage
        ? <StoryView narrative={proposalForPage.narrative} catalog={storyCatalog} renderTile={(tileId) => renderStoryTile(tileId)} />
        : <StoryEditor
          narrative={activePage.narrative ?? { version: 1, presentation: 'story', blocks: [] }}
          catalog={storyCatalog}
          pageTiles={storyPageTiles}
          disabled={busy}
          renderTile={(tileId) => renderStoryTile(tileId)}
          onChange={(narrative) => void mutate([{ type: 'set_narrative', pageId: activePage.id, narrative }])}
          onDraft={(instruction) => void draftStory(instruction)}
          drafting={storyDrafting}
          draftBlockedReason={storyDraftBlocked}
          providerLabel={lastStoryModel}
        />}
    </div> : <StoryView narrative={activePage.narrative ?? { version: 1, presentation: 'story', blocks: [] }} catalog={storyCatalog} receiptFor={numberReceiptFor} renderTile={(tileId) => renderStoryTile(tileId)} />
  ) : null;
  const canArrange = editing && placedGrid;
  canvasKeyHandlerRef.current = (event) => {
    if (!editing || projectedPage || publishReviewOpen || deleteConfirmOpen) return;
    // The tile with keyboard focus wins over the selected one. Keys pressed
    // on a control inside a tile (a chart mark, a table row) stay with it.
    const element = event.target instanceof Element ? event.target : null;
    const card = element?.closest('[data-tile-id]') ?? null;
    const targetTileId = card?.getAttribute('data-tile-id') ?? selectedTileId;
    const shortcut = canvasShortcut(event, Boolean(targetTileId));
    if (!shortcut) return;
    const history = shortcut.kind === 'undo' || shortcut.kind === 'redo';
    if (!history && card && card !== element) return;
    const onCanvas = !element || element === document.body || Boolean(canvasRef.current?.contains(element));
    if (!history && !onCanvas) return;
    event.preventDefault();
    if (busy || gesture) return;
    void runCanvasShortcut(shortcut, targetTileId);
  };
  commitGestureRef.current = (finished) => {
    const message = finished.kind === 'move' ? 'Tile moved · preview preserved' : 'Tile resized · preview preserved';
    void commitCanvasLayout(finished.items, message).finally(() => {
      if (gestureRef.current === finished) gestureRef.current = null;
      setGesture((current) => current === finished || current?.committing ? null : current);
    });
  };
  const startGesture = (event: ReactPointerEvent<HTMLElement>, tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number], kind: CanvasGesture['kind']) => {
    if (!canArrange || busy || gesture || event.button !== 0 || !activePage) return;
    if (kind === 'move' && (event.target as HTMLElement).closest('button, a, input, select, textarea, [role="menu"]')) return;
    const grid = gridRef.current;
    if (!grid) return;
    const origin = visibleItems.find((item) => item.i === tile.i);
    if (!origin) return;
    // A resize handle owns the press; a header press still moves focus, so an
    // open field elsewhere blurs and saves (the header does not select text).
    if (kind !== 'move') event.preventDefault();
    const width = grid.getBoundingClientRect().width;
    const next: CanvasGesture = {
      pageId: activePage.id,
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      columnPx: (width + CANVAS_GAP_PX) / CANVAS_COLUMNS,
      rowStepPx: rowPx + CANVAS_GAP_PX,
      origin,
      base: visibleItems,
      items: visibleItems,
      moved: false,
      committing: false,
    };
    gestureRef.current = next;
    setGesture(next);
    setSelectedTileId(tile.i);
    setTileMenuId(null);
  };
  // Declined tiles are not changes the author will apply.
  const proposalChangeCount = Math.max(0, (projectedPages?.reduce((total, page) => total + page.changeCount, 0) ?? 0)
    - (projectedPages?.reduce((total, page) => total + page.items.filter((item) => item.change === 'added' && skippedProposalTileIds.has(item.tile.i)).length, 0) ?? 0));
  const gridColumns = breakpoint === 'medium' ? 6 : breakpoint === 'narrow' ? 1 : 12;
  const datasetItemForSource = (sourceId?: string) => sourceId
    ? datasetItems.find((item) => (item.sourceId ?? item.id) === sourceId) ?? null
    : null;
  const activeDatasetItem = (draftTile ? datasetItems.find((item) => item.id === draftTile.sourceKey) ?? null : null)
    ?? datasetItemForSource(selectedDatasetTile?.sourceId)
    ?? (chosenDatasetKey ? datasetItems.find((item) => item.id === chosenDatasetKey) ?? null : null)
    ?? draft.sources.map((source) => datasetItemForSource(source.id)).find(Boolean)
    ?? datasetItems[0]
    ?? null;
  const activeDescriptor = activeDatasetItem?.capabilities?.dataset as DatasetDescriptor | undefined;
  const fieldsAvailable = datasetTilesEnabled && datasetItems.length > 0;
  // The Data pane opens even with no Dataset yet: its empty state starts one from a table.
  const dataPaneOpen = datasetTilesEnabled;
  const tileTarget = !draftTile && selectedDatasetTile && activeDatasetItem
    && (activeDatasetItem.sourceId ?? activeDatasetItem.id) === selectedDatasetTile.sourceId
    ? selectedDatasetTile
    : null;
  const dataPanelTarget: DataPanelTarget = draftTile
    ? { kind: 'draft', query: draftTile.query }
    : tileTarget
      ? { kind: 'tile', title: tileTarget.title || humanize(tileTarget.i), query: tileTarget.query! }
      : { kind: 'none' };
  const emptyDraft = (item: AppBlockRecommendation): DraftTileState => ({ sourceKey: item.id, query: EMPTY_TILE_QUERY, encoding: { version: 1, columns: [], rows: [] }, view: 'kpi', viewChosen: false, title: '' });
  const openAddTile = () => {
    setStudioView('edit');
    setSelectedTileId(null);
    setCopilotOpen(false);
    setSettingsOpen(false);
    setPanel('sources');
    setPanelOpen(true);
    if (fieldsAvailable && activeDatasetItem) {
      setDataView('fields');
      setDraftTile((current) => current ?? emptyDraft(activeDatasetItem));
    } else {
      setDataView('sources');
    }
    window.setTimeout(() => document.getElementById('studio-field-search')?.focus(), 0);
  };
  /** A field click builds the new tile, or edits the selected Dataset tile. */
  const pickField = (field: DatasetField) => {
    if (!activeDatasetItem || !activeDescriptor || !activePage) return;
    if (tileTarget?.query && !tileTarget.query.detail) {
      // A click puts the field on the shelf a Tableau author expects, or
      // takes it off every shelf when it is already there (RFC 0009).
      const ref = field.kind === 'measure' ? { measure: field.name } : { dimension: field.name };
      const current = tileTarget.viz.encoding ?? encodingFromQuery(tileTarget.query, tileTarget.viz.type);
      const encoding = encodingHas(current, ref) ? removeField(current, ref) : addFieldByClick(current, ref, isTimeField(field));
      const query = queryFromEncoding(encoding, tileTarget.query, descriptorTimeGrain(activeDescriptor));
      if (!query.measures.length) {
        setSavedMessage('A tile needs at least one measure');
        return;
      }
      const validation = validateTileQuery(activeDescriptor, query);
      if (!tileQueryValidationRuns(validation)) {
        setError(validation.diagnostics[0]?.message ?? 'The Dataset does not cover that field combination.');
        return;
      }
      const type = vizTypeForEncoding(encoding, descriptorTimeField(activeDescriptor), tileTarget.viz.type);
      const viz = datasetTileVisualizationCompatibility(query, type).compatible ? type : 'table';
      // A title DQL generated from the fields follows the fields; a title the
      // author wrote is never touched.
      const generatedTitle = (tileTarget.title ?? '').trim().toLowerCase() === defaultTileTitle(tileTarget.query, humanize).toLowerCase();
      void mutate([{ type: 'update_tile', pageId: activePage.id, tileId: tileTarget.i, patch: {
        query,
        viz: { ...tileTarget.viz, type: viz as typeof tileTarget.viz.type, encoding },
        ...(generatedTitle ? { title: defaultTileTitle(query, humanize) } : {}),
      } }]);
      return;
    }
    if (tileTarget?.query) {
      const query = toggleFieldInQuery(tileTarget.query, field);
      if (!query.measures.length && !query.detail) {
        setSavedMessage('A tile needs at least one measure');
        return;
      }
      const validation = validateTileQuery(activeDescriptor, query);
      if (!tileQueryValidationRuns(validation)) {
        setError(validation.diagnostics[0]?.message ?? 'The Dataset does not cover that field combination.');
        return;
      }
      void mutate([{ type: 'update_tile', pageId: activePage.id, tileId: tileTarget.i, patch: { query } }]);
      return;
    }
    const base = draftTile && draftTile.sourceKey === activeDatasetItem.id ? draftTile : emptyDraft(activeDatasetItem);
    const ref = field.kind === 'measure' ? { measure: field.name } : { dimension: field.name };
    const encoding = encodingHas(base.encoding, ref) ? removeField(base.encoding, ref) : addFieldByClick(base.encoding, ref, isTimeField(field));
    const query = queryFromEncoding(encoding, base.query, descriptorTimeGrain(activeDescriptor));
    const next = { ...base, encoding, query };
    const keepView = base.viewChosen && datasetTileVisualizationCompatibility(query, draftVisualization(activeDescriptor, next)).compatible;
    setDraftTile({ ...next, view: keepView ? base.view : autoTileView(query, encoding, descriptorTimeField(activeDescriptor)), viewChosen: keepView });
    setSelectedTileId(null);
    setCopilotOpen(false);
    setSettingsOpen(false);
  };
  const chooseDataset = (item: AppBlockRecommendation) => {
    setChosenDatasetKey(item.id);
    setSelectedTileId(null);
    setDraftTile((current) => current ? emptyDraft(item) : null);
  };
  chooseDatasetRef.current = chooseDataset;
  const commitDraftTile = async () => {
    if (!draftTile || !activeDatasetItem) return;
    const title = draftTile.title.trim() || defaultTileTitle(draftTile.query, humanize);
    const visualization = activeDescriptor ? draftVisualization(activeDescriptor, draftTile) : undefined;
    // A new pivot asks for its totals from the start.
    const query = visualization === 'pivot' ? withPivotRollups(withoutRowLimit(draftTile.query), draftTile.encoding, undefined) : draftTile.query;
    const added = activeDescriptor
      ? await addComponent(draftTile.view, activeDatasetItem, query, title, visualization as AppStudioBuildDraft['pages'][number]['layout']['items'][number]['viz']['type'], draftTile.encoding)
      : await addComponent(draftTile.view, activeDatasetItem, draftTile.query, title, tileVisualization(draftTile.query, draftTile.view));
    if (added) setDraftTile(null);
  };
  const askAiAboutTile = (tileId: string) => {
    selectAppAutopilotTile(tileId);
    setAiScope('tile');
    setCopilotOpen(true);
    setTileMenuId(null);
  };
  const deviceOptions: Array<[StudioPreviewMode, string, typeof Monitor]> = [
    ['auto', 'Fit to window', LayoutDashboard],
    ['wide', 'Desktop', Monitor],
    ['medium', 'Tablet', PanelRight],
    ['narrow', 'Phone', Smartphone],
  ];
  /** A tile embedded in the story, drawn with the canvas card at full width. */
  const renderStoryTile = (tileId: string) => {
    const tile = activePage?.layout.items.find((item) => item.i === tileId);
    return tile ? <div className="studio-page-grid story-embed">{renderTile({ ...tile, w: 12 }, 'story-embed')}</div> : null;
  };
  const renderTile = (tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number], extraClass = '', badge: ReactNode = null, placed = false) => {
    return (
                <article
                  key={tile.i}
                  role="group"
                  aria-label={`App tile: ${tile.title || humanize(tile.i)}`}
                  data-tile-id={tile.i}
                  tabIndex={editing && !projectedPage ? 0 : undefined}
                  className={`studio-component-card ${extraClass} ${editing && selectedTileId === tile.i ? 'selected' : ''} ${gesture?.origin.i === tile.i ? 'gesturing' : ''} ${tile.text ? 'text-tile' : ''}`}
                  style={placed
                    ? { gridColumn: `${tile.x + 1} / span ${tile.w}`, gridRow: `${tile.y + 1} / span ${tile.h}` }
                    : { '--studio-tile-width': Math.min(tile.w, breakpoint === 'medium' ? 6 : breakpoint === 'narrow' ? 1 : 12), minHeight: tile.text ? undefined : breakpoint === 'narrow' ? Math.max(180, tile.h * 58) : Math.max(150, tile.h * 68) } as CSSProperties}
                  onClick={() => { if (!editing || projectedPage) return; setSelectedTileId(tile.i); setDraftTile(null); setSettingsOpen(false); setCopilotOpen(false); }}
                >
                  <header onPointerDown={placed ? (event) => startGesture(event, tile, 'move') : undefined}>
                    {editing ? <span className="drag-handle" aria-hidden="true" title={canArrange ? 'Drag to move. Arrow keys move the selected tile.' : undefined}>⠿</span> : null}
                    {badge}
                    <strong>{tile.title || humanize(tile.i)}</strong>
                    <span className={`trust-dot ${tile.trustState ?? 'draft_ready'}`} title={tile.trustState === 'certified' ? 'Certified source' : tile.trustState === 'review_required' ? 'Needs review before publishing' : 'Draft'} />
                    <div className="tile-tools" onClick={(event) => event.stopPropagation()}>
                      {editing && tile.sourceId && tile.query ? <button type="button" className={`studio-autopilot-target ${selectedDatasetTile?.i === tile.i ? 'on' : ''}`} aria-pressed={selectedDatasetTile?.i === tile.i} aria-label="Edit with AI" title="Edit with AI" onClick={() => askAiAboutTile(tile.i)}><Sparkles size={13} /></button> : null}
                      {tile.query ? <button type="button" className={`studio-tile-dql-toggle ${dqlTileId === tile.i ? 'on' : ''}`} aria-pressed={dqlTileId === tile.i} aria-label="View DQL" title="View DQL" onClick={() => setDqlTileId((current) => current === tile.i ? null : tile.i)}><Code2 size={13} /></button> : null}
                      <button type="button" className="tile-more" aria-label="Tile actions" aria-haspopup="menu" aria-expanded={tileMenuId === tile.i} title="More" onClick={() => setTileMenuId((current) => current === tile.i ? null : tile.i)}><MoreHorizontal size={14} /></button>
                      {tileMenuId === tile.i ? <div className="tile-menu" role="menu">
                        {tile.query ? <button type="button" role="menuitem" onClick={() => { setDqlTileId(tile.i); setTileMenuId(null); }}><Code2 size={14} /> View DQL and SQL</button> : null}
                        {tile.sourceId && tile.query ? <button type="button" role="menuitem" onClick={() => askAiAboutTile(tile.i)}><Sparkles size={14} /> {editing ? 'Change with AI' : 'Ask about this tile'}</button> : null}
                        {editing ? <button type="button" role="menuitem" onClick={() => { setSelectedTileId(tile.i); setTileMenuId(null); setCopilotOpen(false); }}><Settings2 size={14} /> Tile settings</button> : null}
                        {editing && driverProbeFor(tile, previewRun?.tiles.find((item) => item.tileId === tile.i)) ? <button type="button" role="menuitem" onClick={() => { setTileMenuId(null); void addDriverTile(tile.i); }}><Activity size={14} /> Explain the latest change</button> : null}
                        {editing ? <button type="button" role="menuitem" onClick={() => { setTileMenuId(null); void duplicateTile(tile.i); }}><Copy size={14} /> Duplicate <kbd>{modifierKeyLabel()}D</kbd></button> : null}
                        {editing ? <><hr /><button type="button" role="menuitem" className="danger" onClick={() => { setTileMenuId(null); void removeTile(tile.i); }}><Trash2 size={14} /> Remove tile <kbd>Del</kbd></button></> : null}
                      </div> : null}
                    </div>
                  </header>
                  {unsupportedTileFilters(tile).map((binding) => <div key={binding.filter} className="tile-filter-notice"><Filter size={11} /><span>{binding.unsupportedReason ?? `${humanize(binding.filter)} does not affect this tile.`}</span></div>)}
                  {(() => { const retired = retiredTileNotice(previewRun?.tiles.find((item) => item.tileId === tile.i)); return retired ? <div className="tile-filter-notice retired" role="note" title={retired.detail}><Archive size={11} /><span><strong>{retired.label}</strong></span></div> : null; })()}
                  {datasetTileNotices(previewRun?.tiles.find((item) => item.tileId === tile.i)).map((notice) => <div key={notice.key} className={`tile-filter-notice ${notice.kind}`} title={notice.detail}><Filter size={11} /><span><strong>{notice.label}</strong> · {notice.detail}</span></div>)}
                  {dqlTileId === tile.i ? <div className="studio-tile-dql" onClick={(event) => event.stopPropagation()}>{(() => { const runTile = previewRun?.tiles.find((item) => item.tileId === tile.i); const evidence = runTile && tile.query && isCurrentDatasetTileEvidence(tile, runTile) ? presentDatasetTileEvidence(runTile) : undefined; return evidence ? <DatasetTileExecutionEvidence presentation={evidence} /> : <p>Run a preview to see the Dataset query and the SQL it compiled to.</p>; })()}</div> : null}
                  {tile.text ? <div className={tile.viz.type === 'heading' ? 'tile-heading' : 'tile-text'}>{tile.text.markdown.replace(/^#+\s*/, '')}</div> : <div className="studio-tile-preview-interactions" onClick={(event) => event.stopPropagation()}><StudioTilePreview tile={tile} run={previewRun?.tiles.find((item) => item.tileId === tile.i)} loading={previewing} themeMode={themeMode} chartHeight={placed ? tileBodyHeight(tile.h, rowPx) : undefined} crossFilterFields={datasetCrossFilterFields(activePage!, tile)} activeCrossFilters={previewCrossFilters} onSelectDatasetMark={(field, values) => applyDatasetCrossFilter(tile, field, values)} onDrillDatasetMark={(candidate, row) => exploreDatasetHierarchy(tile, candidate, row)} onDrillBack={() => returnFromDatasetHierarchy(tile.i)} onNavigate={() => navigateFromDatasetTile(tile)} hasNavigation={Boolean(activePage!.interactions?.navigate?.some((interaction) => interaction.fromTile === tile.i))} linkProposal={datasetLinkProposal(activePage!, tile)} onLinkField={() => linkDatasetTileField(tile)} onMark={(row, at, candidates) => openMarkMenu(tile, previewRun?.tiles.find((item) => item.tileId === tile.i), row, at, candidates)} /></div>}
                  {placed && canArrange ? <>
                    <span className="tile-resize-handle e" aria-hidden="true" onPointerDown={(event) => { event.stopPropagation(); startGesture(event, tile, 'resize-e'); }} />
                    <span className="tile-resize-handle s" aria-hidden="true" onPointerDown={(event) => { event.stopPropagation(); startGesture(event, tile, 'resize-s'); }} />
                    <span className="tile-resize-handle se" aria-hidden="true" title="Drag to resize. Shift + arrow keys resize the selected tile." onPointerDown={(event) => { event.stopPropagation(); startGesture(event, tile, 'resize'); }} />
                  </> : null}
                </article>
  );
  };


  return (
    <div className={`dql-studio-v2 ${projectedPages ? 'has-proposal' : ''} studio-${studioView} right-${rightPane}`}>
      <style>{APP_STUDIO_V2_STYLES}</style>
      <header className="studio-topbar">
        <div className="studio-brand"><button type="button" className="ghost-icon" onClick={onBack} aria-label="Back to Apps" title="Back to Apps"><ArrowLeft size={16} /></button><span className="mark"><LayoutDashboard size={15} /></span><div><input aria-label="App name" value={name || draft.name} onChange={(event) => setName(event.target.value)} onBlur={() => { if (name.trim() && name.trim() !== draft.name) void mutate([{ type: 'set_name', name: name.trim() }]); }} /><small>{savedMessage}</small></div></div>
        <nav className="page-nav" aria-label="App pages">
          {projectedPages ? projectedPages.map((page) => <button key={page.id} type="button" className={`${projectedPage?.id === page.id ? 'on' : ''} ${page.isNew ? 'proposed-page' : ''}`} aria-current={projectedPage?.id === page.id ? 'page' : undefined} onClick={() => { setProposalPageId(page.id); if (!page.isNew) setActivePageId(page.id); }}>{page.title}{page.changeCount ? <span className="change-dot" aria-label={`${page.changeCount} proposed ${page.changeCount === 1 ? 'change' : 'changes'}`} /> : null}</button>) : draft.pages.map((page) => <button key={page.id} type="button" className={activePage?.id === page.id ? 'on' : ''} aria-current={activePage?.id === page.id ? 'page' : undefined} onClick={() => { setActivePageId(page.id); setSelectedTileId(null); setTileMenuId(null); setDraftTile(null); }}>{page.metadata.title}</button>)}
          {editing && !projectedPages ? <button type="button" className="ghost-icon" onClick={() => void addPage()} aria-label="Add page" title="Add page"><Plus size={15} /></button> : null}
        </nav>
        <div className="studio-actions">
          {editing ? <div className="history">
            <button type="button" className="ghost-icon" disabled={!undoStack.length || busy} onClick={() => void undo()} aria-label="Undo" title="Undo"><Undo2 size={15} /></button>
            <button type="button" className="ghost-icon" disabled={!redoStack.length || busy} onClick={() => void redo()} aria-label="Redo" title="Redo"><Redo2 size={15} /></button>
          </div> : null}
          <div className="mode-toggle" role="group" aria-label="Studio mode">
            <button type="button" className={editing ? 'on' : ''} aria-pressed={editing} onClick={() => setStudioView('edit')}>Edit</button>
            <button type="button" className={!editing ? 'on' : ''} aria-pressed={!editing} onClick={() => { setStudioView('view'); setSelectedTileId(null); setSettingsOpen(false); setTileMenuId(null); }} title="See the page exactly as readers will">Preview</button>
          </div>
          <button type="button" className="preview" onClick={() => void runPreview()} disabled={previewing || busy} aria-label={previewing ? 'Running preview' : 'Run preview'} title="Run every tile on this page again"><Play size={13} /><span>{previewing ? 'Running…' : 'Run'}</span></button>
          <button type="button" className={`copilot ${copilotOpen ? 'on' : ''}`} onClick={() => { if (!copilotOpen) setAiScope(selectedDatasetTile ? 'tile' : 'page'); setCopilotOpen((open) => !open); }} aria-pressed={copilotOpen} aria-label="Ask AI"><Sparkles size={14} /><span>Ask AI</span></button>
          <button type="button" className="publish" onClick={() => void publishFromToolbar()} disabled={busy} aria-label={`Review and publish to Project${publishStepCount ? `, ${publishStepCount} ${publishStepCount === 1 ? 'fix' : 'fixes'} needed` : ''}`}><span>Publish</span>{publishStepCount ? <small>{publishStepCount} {publishStepCount === 1 ? 'fix' : 'fixes'}</small> : null}</button>
          <button type="button" className="ghost-icon overflow-button" aria-label="More draft actions" aria-expanded={actionsOpen} onClick={() => setActionsOpen((open) => !open)}><MoreHorizontal size={17} /></button>
          {actionsOpen ? <div className="studio-overflow-menu" role="menu">
            <small>Preview size</small>
            {deviceOptions.map(([id, label, Icon]) => <button key={id} type="button" role="menuitemradio" aria-checked={previewMode === id} className={previewMode === id ? 'on' : ''} onClick={() => { setPreviewMode(id); setActionsOpen(false); }}><Icon size={14} /> {label}{previewMode === id ? <Check size={13} className="menu-check" /> : null}</button>)}
            <hr />
            <button type="button" role="menuitem" disabled={!activePage?.layout.items.length || busy} onClick={() => { setActionsOpen(false); void arrangePage(); }}><LayoutDashboard size={14} /> Tidy page layout</button>
            <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setStudioView('edit'); setSelectedTileId(null); setCopilotOpen(false); setSettingsOpen(true); }}><Settings2 size={14} /> App settings</button>
            <hr />
            <button type="button" role="menuitem" className="danger" onClick={() => { setActionsOpen(false); setDeleteConfirmOpen(true); }}><Trash2 size={14} /> Delete local draft</button>
          </div> : null}
        </div>
      </header>

      {editing ? <aside className="studio-left">
        <nav role="tablist" aria-label="Build panel">
          {([
            ['sources', 'Data'], ['pages', 'Pages'], ['filters', 'Filters'],
          ] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={panel === id} className={panel === id && panelOpen ? 'on' : ''} onClick={() => { if (window.innerWidth <= 820 && panel === id) setPanelOpen((open) => !open); else { setPanel(id); setPanelOpen(true); } }}>{label}</button>)}
        </nav>
        <section className={`left-content ${panelOpen ? 'open' : ''}`}>
          <button type="button" className="mobile-drawer-close" onClick={() => setPanelOpen(false)} aria-label="Close Studio drawer"><X size={16} /></button>
          {panel === 'pages' ? <PagesPanel draft={draft} activePageId={activePage?.id} onOpen={setActivePageId} onAdd={() => void addPage()} template={draft.template} onApplyTemplate={(nextTemplate) => void applyTemplate(nextTemplate)} /> : null}
          {panel === 'sources' && dataPaneOpen && dataView === 'fields' ? <DataPanel datasets={datasetItems} active={activeDatasetItem} target={dataPanelTarget} disabled={busy || previewing} loading={catalogLoading} onChooseDataset={chooseDataset} onPickField={pickField} onBrowseSources={() => setDataView('sources')} onStartFromTable={() => setTableDialogOpen(true)} onAddContent={(kind) => void addComponent(kind, null)} /> : null}
          {panel === 'sources' && (!dataPaneOpen || dataView === 'sources') ? <>{dataPaneOpen ? <button type="button" className="panel-back" onClick={() => setDataView('fields')}><ArrowLeft size={13} /> Dataset fields</button> : null}<SourcesPanel usedSources={draft.sources} items={filteredCatalog} selected={selectedSource} query={catalogQuery} loading={catalogLoading} error={catalogError} disabled={busy || previewing} datasetTilesEnabled={datasetTilesEnabled} sourceFeedback={sourceFeedback} onQuery={setCatalogQuery} onSelect={selectSource} onAdd={(item, kind) => void addComponent(kind, item)} onAddDataset={(item, kind, query, title) => void addComponent(kind, item, query, title)} onAuthorDataset={openDatasetAuthoring} onRefreshDatasetBinding={(sourceId) => void refreshDatasetBinding(sourceId)} onAddContent={(kind) => void addComponent(kind, null)} policy={draft.sourcePolicy} total={catalogTotal} hasMore={Boolean(catalogNextCursor)} onLoadMore={() => void loadMoreSources()} onEnableReview={() => void mutate([{ type: 'set_source_policy', sourcePolicy: 'include_review_required' }])} /></> : null}
          {panel === 'filters' ? <FiltersPanel draft={draft} activePageId={activePage?.id} catalog={catalog} candidates={filterCandidates} runtimeFilterFields={runtimeFilterFields} previewRunsByPage={previewRunsByPage} previewing={previewing} disabled={busy || previewing} onRunPreview={() => void runPreview()} onSave={(configuration) => void saveFilter(configuration)} onRemove={(id) => void removeFilter(id)} /> : null}
        </section>
      </aside> : null}

      <main ref={workspaceRef} className="studio-workspace">
        {error ? <div className="studio-error floating" role="alert">{error}<button type="button" onClick={() => setError(null)}>×</button></div> : null}
        <div className={`studio-canvas-frame ${breakpoint} preview-mode-${previewMode}`}>
          <section ref={canvasRef} className="studio-canvas" aria-label="App canvas" onClick={(event) => { if (event.target === event.currentTarget) { setSelectedTileId(null); setTileMenuId(null); } }}>
            <header className="studio-page-heading">
              <div><h1>{projectedPage?.title ?? activePage?.metadata.title ?? 'Overview'}</h1>{!projectedPage?.isNew && activePage?.metadata.description ? <p>{activePage.metadata.description}</p> : null}</div>
              {editing && !projectedPages && activePage ? <PageFormatPicker value={canvasMode ? 'canvas' : storyMode ? 'story' : 'dashboard'} disabled={busy} onChange={(format) => void setPresentation(format)} /> : null}
              {editing && !projectedPages && !storyMode && !canvasMode ? <button type="button" className="add-tile" onClick={openAddTile}><Plus size={14} /> Add tile</button> : null}
            </header>
            {editing && (!fieldsAvailable || dataView === 'sources') && selectedSource && selectedSourceKind ? <div className="studio-source-ready"><div><span className="certified"><ShieldCheck size={14} /></span><p><small>Selected data</small><strong>{humanize(selectedSource.name)}</strong></p></div><span className="studio-source-actions"><button type="button" disabled={busy || previewing} onClick={() => selectedSource.capabilities?.dataset ? (setPanel('sources'), setPanelOpen(true)) : void addComponent(selectedSourceKind, selectedSource)}>{selectedSource.capabilities?.dataset ? <><Settings2 size={14} /> Choose fields</> : <><Plus size={14} /> {selectedSourceAction}</>}</button><button type="button" className="source-clear" onClick={() => setSelectedSource(null)} aria-label="Clear selected data"><X size={14} /></button></span></div> : null}
            {(activePage?.filters ?? []).length ? <div className="studio-page-filterbar">{activePage!.filters!.map((filter) => <StudioFilterControl key={filter.id} filter={filter} availability={activeFilterOptions[filter.id]} value={previewVariables[filter.id] ?? filter.default} applying={previewing} onChange={(value) => applyFilterValue(filter, value)} />)}</div> : null}
            {previewCrossFilters.length ? <div className="studio-mark-filterbar" role="status" aria-label="Selected Dataset result marks"><span>Selected marks</span>{previewCrossFilters.map((filter) => <button key={`${filter.fromTileId}:${filter.field}`} type="button" onClick={() => removeDatasetCrossFilter(filter.fromTileId, filter.field)}>{humanize(filter.field)}: {filter.values.map(String).join(', ')} <X size={11} /></button>)}<button type="button" className="clear" onClick={clearDatasetCrossFilters}>Reset marks</button></div> : null}
            {previewRun?.incomplete ? <div className="studio-preview-incomplete" role="status" aria-label="Incomplete preview">
              <strong>Preview incomplete · {previewRun.tiles.filter((tile) => tile.status === 'ok').length}/{previewRun.tiles.length} tiles ready</strong>
              <span>{previewRun.incomplete.message}</span>
            </div> : null}
            {autopilotTileSelectionRequested && !selectedDatasetTile ? <div className="studio-autopilot-selection-hint" role="status">
              <strong>Choose a tile to change with AI</strong>
              <span>Use “Edit with AI” on a Dataset tile. Clicking a chart keeps its own behavior and does not select the tile.</span>
            </div> : null}
            {projectedPage ? <div className={`proposal-banner ${proposalSummaryText(projectedPage).removed ? 'warn' : ''}`} role="status"><Sparkles size={14} /><span><strong>AI proposal</strong> · {proposalSummaryText(projectedPage).text}. Nothing is saved until you apply.</span></div> : null}
            {/* A report or custom layout shows the tile being built above it; Add to page puts it at the end. */}
            {(canvasMode || storyMode) && editing && draftTile && activeDescriptor ? <div className="studio-draft-slot"><DraftTileCard sourceId={activeDatasetItem?.sourceId ?? activeDatasetItem?.id} descriptor={activeDescriptor} draft={draftTile} themeMode={themeMode} onResult={setDraftResult} /></div> : null}
            {canvasMode ? canvasArea : storyMode ? storyArea : <>
            {/* On the placed grid the tile being built sits above the page, where
                it is seen first, instead of taking an automatic cell below it. */}
            {placedGrid && editing && draftTile && activeDescriptor ? <div className="studio-draft-slot"><DraftTileCard sourceId={activeDatasetItem?.sourceId ?? activeDatasetItem?.id} descriptor={activeDescriptor} draft={draftTile} themeMode={themeMode} onResult={setDraftResult} /></div> : null}
            <div
              ref={gridRef}
              className={`studio-page-grid ${placedGrid ? 'placed' : ''} ${gesture ? 'arranging' : ''}`}
              style={placedGrid ? { gridAutoRows: `${rowPx}px` } : undefined}
              aria-describedby={canArrange && visibleItems.length ? 'studio-canvas-keys' : undefined}
            >
              {!placedGrid && editing && draftTile && activeDescriptor ? <DraftTileCard sourceId={activeDatasetItem?.sourceId ?? activeDatasetItem?.id} descriptor={activeDescriptor} draft={draftTile} themeMode={themeMode} onResult={setDraftResult} /> : null}
              {projectedPage ? projectedPage.items.map((item) => item.change === 'added' || item.change === 'updated'
                ? <ProposedTileCard
                  key={item.tile.i}
                  tile={item.tile}
                  change={item.change}
                  before={item.before}
                  descriptor={datasetItemForSource(item.tile.sourceId)?.capabilities?.dataset as DatasetDescriptor | undefined}
                  columns={gridColumns}
                  themeMode={themeMode}
                  kept={!skippedProposalTileIds.has(item.tile.i)}
                  onToggleKept={proposal?.proposedTileIds?.includes(item.tile.i)
                    ? () => setSkippedProposalTileIds((current) => {
                      const next = new Set(current);
                      if (next.has(item.tile.i)) next.delete(item.tile.i);
                      else next.add(item.tile.i);
                      return next;
                    })
                    : undefined}
                />
                : renderTile(
                  item.tile,
                  item.change === 'removed' ? 'proposal-removed' : projectedPage.linkedTileIds.has(item.tile.i) ? 'proposal-linked' : '',
                  item.change === 'removed' ? <span className="proposal-badge removed">WILL BE REMOVED</span> : projectedPage.linkedTileIds.has(item.tile.i) ? <span className="proposal-badge link">PROPOSED LINK</span> : null,
                ))
                : canvasItems.map((tile) => renderTile(tile, '', null, breakpoint === 'wide'))}
              {!visibleItems.length && !draftTile && !projectedPage ? <div className="empty-canvas"><span><Plus size={22} /></span><strong>This page is empty</strong><p>{editing ? 'Choose your data in the Data panel, then click the numbers and fields you want to see. You can also ask AI to draft the page.' : 'Switch to Edit to add tiles to this page.'}</p>{editing ? <div className="empty-actions"><button type="button" className="primary" onClick={openAddTile}><Plus size={14} /> Add tile</button><button type="button" onClick={() => { setAiScope('page'); setCopilotOpen(true); }}><Sparkles size={14} /> Draft with AI</button></div> : null}</div> : null}
            </div>
            {canArrange && visibleItems.length ? <p id="studio-canvas-keys" className="studio-canvas-keys">Drag a tile by its header or resize it from its edges. With a tile selected: arrow keys move it, Shift + arrows resize, {modifierKeyLabel()}D duplicates, Delete removes, {modifierKeyLabel()}Z undoes.</p> : null}
            </>}
          </section>
        </div>
      </main>

      {rightPane === 'proposal' ? <aside className="studio-right studio-plan-pane" aria-label="AI proposal">
        {aiActivity ? <AppStudioAiActivitySurface
          docked
          activity={aiActivity}
          label={APP_STUDIO_AI_ACTIVITY_LABELS[aiActivityIndex] ?? APP_STUDIO_AI_ACTIVITY_LABELS[0]}
          onBack={onBack}
          onReturn={aiActivity.returnToProposal && proposal ? () => setAiActivity(null) : undefined}
          onRetry={() => retryAiActivity(aiActivity)}
        /> : proposal && proposalSummary ? <AiPlanReview
            proposal={proposal}
          summary={proposalSummary}
          catalog={catalog}
          catalogQuery={catalogQuery}
          sourcePolicy={draft.sourcePolicy}
          selectedSourceIds={selectedProposalSourceIds}
          addingSourceId={proposalAddingSourceId}
          busy={busy}
          onRevise={() => void requestAiProposal(draft, prompt, appStudioProposalRequiredSourceIds(selectedProposalSourceIds), true)}
          changeCount={proposalChangeCount}
          onApply={() => void applyProposal()}
          onDismiss={() => { if (projectedPage && !projectedPage.isNew) setActivePageId(projectedPage.id); setProposal(null); setProposalPageId(null); }}
          onCatalogQuery={setCatalogQuery}
          onAddSource={(source) => void addSourceToAiProposal(source.sourceId ?? source.id, source.eligibility?.localPreview === false, source)}
          onAddProposalSource={(sourceId, reviewRequired) => void addSourceToAiProposal(sourceId, reviewRequired)}
          onAnswerClarification={(questionId, answerId) => void reviseAiProposal({ [questionId]: answerId })}
          onGenerateGap={(requirementId) => void generateAiGap(requirementId)}
          onToggleSource={(sourceId) => setSelectedProposalSourceIds((current) => {
            const next = new Set(current);
            if (next.has(sourceId)) next.delete(sourceId); else next.add(sourceId);
            return next;
          })}
        /> : null}
      </aside> : null}
      {rightPane === 'draft' && draftTile && activeDescriptor && activeDatasetItem ? <aside className="studio-right" aria-label="New tile">
        <header><div><small>NEW TILE</small><strong>Built from {humanize(activeDatasetItem.name)}</strong></div><button type="button" className="ghost-icon" onClick={() => setDraftTile(null)} aria-label="Cancel new tile"><X size={16} /></button></header>
        <DraftTileInspector descriptor={activeDescriptor} datasetLabel={humanize(activeDatasetItem.name)} draft={draftTile} disabled={busy} onChange={setDraftTile} onCancel={() => setDraftTile(null)} onAdd={() => void commitDraftTile()} result={draftResult} />
      </aside> : null}
      {rightPane === 'inspector' || rightPane === 'settings' ? <aside className={`studio-right ${selectedTile ? 'has-selection' : ''}`} aria-label={selectedTile ? 'Tile settings' : 'App settings'}>
        <header><div><small>{selectedTile ? tileKindLabel(selectedTile) : 'APP'}</small><strong>{selectedTile ? 'Tile settings' : 'App settings'}</strong></div><button type="button" className="ghost-icon" onClick={() => { setSelectedTileId(null); setSettingsOpen(false); }} aria-label={selectedTile ? 'Close tile settings' : 'Close App settings'}><X size={16} /></button></header>
        {selectedTile && activePage ? (
          <ComponentInspector
            key={selectedTile.i}
            tile={selectedTile}
            run={previewRun?.tiles.find((item) => item.tileId === selectedTile.i)}
            pageId={activePage.id}
            page={activePage}
            pages={draft.pages}
            sources={draft.sources}
            dataset={selectedTile.sourceId ? draft.sources.find((source) => source.id === selectedTile.sourceId)?.capabilities?.dataset : undefined}
            disabled={busy || previewing}
            onOpenSources={() => { setPanel('sources'); setPanelOpen(true); }}
            onSaveDatasetTileAsBlock={() => void saveDatasetTileAsReusableBlock(activePage, selectedTile)}
            savingDatasetTileAsBlock={savingDatasetTileId === selectedTile.i}
            savedDatasetReviewDraft={savedDatasetReviewDrafts[`${activePage.id}:${selectedTile.i}`]}
            onReplaceDatasetTileWithBlock={() => void replaceDatasetTileWithSavedBlock(activePage, selectedTile)}
            replacingDatasetTileWithBlock={replacingDatasetTileId === selectedTile.i}
            onPreviewLegacySemanticConversion={() => void previewLegacySemanticConversion(activePage, selectedTile)}
            previewingLegacySemanticConversion={previewingSemanticConversionTileId === selectedTile.i}
            semanticTileConversionPreview={semanticTileConversionPreviews[`${activePage.id}:${selectedTile.i}`]}
            onAcceptLegacySemanticConversion={() => void acceptLegacySemanticConversion(activePage, selectedTile)}
            acceptingLegacySemanticConversion={acceptingSemanticConversionTileId === selectedTile.i}
            onRefreshDatasetTile={() => void runPreview(activePage.id, true)}
            onUpdate={(patch) => void mutate([{ type: 'update_tile', pageId: activePage.id, tileId: selectedTile.i, patch }])}
            onUpdateInteractions={(interactions) => void mutate([{ type: 'set_interactions', pageId: activePage.id, interactions }])}
            onDelete={() => void mutate([{ type: 'remove_tile', pageId: activePage.id, tileId: selectedTile.i }]).then(() => setSelectedTileId(null))}
          />
        ) : (
          <>
            <BuildFrameInspector draft={draft} prompt={prompt} previewRun={previewRun} onPrompt={setPrompt} onAskAi={() => { setAiScope('page'); setCopilotOpen(true); }} onSourcePolicy={(nextPolicy) => void mutate([{ type: 'set_source_policy', sourcePolicy: nextPolicy }])} onResolveTask={(task) => void resolveReviewTask(task)} onApproveSemantic={() => void approveSemanticPreview()} />
            {/* Who the published App is for (RFC 0010 HH-16). */}
            {draft.appId ? <div className="inspector-body"><PublishedAppAudience key={draft.appId} appId={draft.appId} /></div> : null}
          </>
        )}
      </aside> : null}

      {rightPane === 'ai' ? <AiSidePanel
        t={themes[themeMode]}
        title="AI"
        subtitle={draft.name}
        dock="column"
        expanded={copilotExpanded}
        onToggleExpanded={() => setCopilotExpanded((expanded) => !expanded)}
        onNewChat={() => {
          copilotThread.resetThreadId();
          setAutopilotReview(null);
        }}
        onClose={() => setCopilotOpen(false)}
        running={copilotRunning}
        resizable
        minResizeWidth={360}
        maxResizeWidth={900}
        ariaLabel="Ask AI"
        className="studio-copilot-panel"
      >
        <div className="studio-ai-scope" role="tablist" aria-label="What should AI work on?">
          <button type="button" role="tab" aria-selected={aiScope === 'page'} className={aiScope === 'page' ? 'on' : ''} onClick={() => setAiScope('page')}><FileText size={13} /> Page: {activePage?.metadata.title ?? 'Overview'}</button>
          <button type="button" role="tab" aria-selected={aiScope === 'tile'} className={aiScope === 'tile' ? 'on' : ''} onClick={() => setAiScope('tile')}><LayoutDashboard size={13} /> {selectedDatasetTile ? `Tile: ${selectedDatasetTile.title || humanize(selectedDatasetTile.i)}` : 'A tile'}</button>
        </div>
        {aiScope === 'page' ? <section className="studio-ai-page-scope">
          <label htmlFor="studio-ai-page-prompt">Describe the page or the change you want</label>
          <textarea id="studio-ai-page-prompt" value={prompt} rows={5} onChange={(event) => setPrompt(event.target.value)} placeholder="Revenue and order trends by region for the weekly business review" />
          <small>{draft.sourcePolicy === 'governed_only' ? 'AI plans tiles from certified Datasets, Metrics and saved queries only.' : 'AI plans tiles from Datasets, Metrics and saved queries, including data that needs review.'} New tiles are added below what is already here, and you keep or skip each one before anything changes.</small>
          <label htmlFor="studio-ai-replace-page" className="studio-ai-replace">
            <input id="studio-ai-replace-page" type="checkbox" checked={replacePageWithAi} onChange={(event) => setReplacePageWithAi(event.target.checked)} />
            Rebuild this page instead (replaces its current tiles)
          </label>
          <button type="button" className="primary" disabled={busy || previewing} onClick={() => void requestAiProposal()}><Sparkles size={13} /> {replacePageWithAi ? 'Propose a new page' : 'Propose additions'}</button>
        </section> : null}
        {aiScope === 'tile' && autopilotReview ? <AppAutopilotReviewCard
          proposal={autopilotReview}
          running={copilotRunning}
          onDiscard={() => {
            setAutopilotReview(null);
            setSavedMessage('AI tile change discarded · the draft is unchanged');
          }}
          onApply={() => void applyAutopilotChange()}
        /> : null}
        {aiScope === 'tile' ? <Suspense fallback={<div className="studio-copilot-loading">Loading…</div>}>
          <UnifiedAgentRunPanel
            themeMode={themeMode}
            title="Edit tile with AI"
            scopeHint={selectedDatasetTile
              ? `Draft · ${activePage?.metadata.title ?? 'Overview'} · ${selectedDatasetTile.title || humanize(selectedDatasetTile.i)}${autopilotRepairAvailability === 'healthy' ? ' · preview healthy' : autopilotRepairAvailability === 'failed_tile' ? ' · failed tile' : ''}`
              : `Draft · ${activePage?.metadata.title ?? 'Overview'} · select a Dataset tile`}
            composerPlaceholder="Explain, repair, or change the selected tile…"
            emptyHint={selectedDatasetTile
              ? `AI reads the saved draft and ${selectedDatasetTile.title || humanize(selectedDatasetTile.i)} before it answers, and proposes a change for you to review. ${appAutopilotRepairShortcutHint(autopilotRepairAvailability)}`
              : 'Choose “Edit with AI” on a Dataset tile first.'}
            audience="analyst"
            initialMode="app"
            selectedObject={{ kind: 'app', id: draft.appId, title: draft.name }}
            workspaceContext={appAutopilotContext(draft, activePage, selectedDatasetTile, previewRun)}
            presentationContextKey={autopilotPresentationScope}
            threadId={copilotThread.threadId}
            onThreadIdChange={copilotThread.onThreadIdChange}
            onRunningChange={setCopilotRunning}
            onSelectAppAutopilotTile={() => {
              setAutopilotTileSelectionRequested(true);
              setSavedMessage('Choose “Edit with AI” on a Dataset tile to continue');
              workspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
            onReviewAppAutopilotChange={(artifact, run) => {
              const proposal = appAutopilotProposalFromArtifact(artifact.payload);
              if (!proposal || proposal.id !== artifact.ref || proposal.artifactId !== artifact.id || proposal.runId !== run.id) {
                setError('AI returned a change that could not be reviewed. Ask it to prepare the change again.');
                return;
              }
              setAutopilotReview(proposal);
              setSavedMessage('AI tile change ready for review · the draft is unchanged');
            }}
            answerFirstCards
            examplePrompts={appAutopilotExamplePrompts(autopilotRepairAvailability)}
          />
        </Suspense> : null}
      </AiSidePanel> : null}
      {publishReviewOpen ? <PublishReadinessDialog
        draft={draft}
        serverIssues={publishIssues}
        busy={busy || previewing}
        previewRun={previewRun}
        onClose={() => setPublishReviewOpen(false)}
        onRetry={() => void publish(true)}
        onRunPreview={(pageId) => void runPreviewAndReview(pageId)}
        onRunAllPreviews={() => void runAllPreviewsAndReview()}
        onRemoveRequirement={(requirementId) => void removeRequirementFromPublishScope(requirementId)}
        onReviseRequirement={reviseRequirementWithAi}
        onAnswerQuestion={(questionId, answerId) => void answerBuildFrameQuestion(questionId, answerId)}
        onResolveTask={(task) => void resolveReviewTask(task)}
        onOpenSources={() => { setPublishReviewOpen(false); setPanel('sources'); setPanelOpen(true); }}
        onOpenFilters={() => { setPublishReviewOpen(false); setPanel('filters'); setPanelOpen(true); }}
        onRefreshSources={() => void refreshCertifiedSourceTrust()}
        onApproveSemantic={() => void approveSemanticPreview()}
        onRemoveLocalAnalysis={() => void removeLocalAnalysisForPublication()}
      /> : null}
      {datasetAuthoringSource ? <DatasetSourceAuthoringDialog
        source={datasetAuthoringSource}
        disabled={busy || previewing}
        onClose={() => setDatasetAuthoringSource(null)}
        onPreview={(change) => void previewDatasetAuthoringChange(change)}
      /> : null}
      {datasetAuthoringProposal ? <ContextProposalReviewDrawer
        proposal={datasetAuthoringProposal}
        theme={themes[themeMode]}
        onClose={() => setDatasetAuthoringProposal(null)}
        onCommitted={finishDatasetAuthoringProposal}
      /> : null}
      {datasetRebindPrompt ? <DatasetSourceRebindReviewDialog
        title={datasetRebindPrompt.title}
        disabled={busy || previewing}
        onCancel={() => setDatasetRebindPrompt(null)}
        onConfirm={() => void refreshDatasetBinding(datasetRebindPrompt.sourceId, true)}
      /> : null}
      {markOverlays}
      {tableDialogOpen ? <TableDatasetDialog
        {...(draftDomain ? { domain: draftDomain } : {})}
        onClose={() => setTableDialogOpen(false)}
        onCreated={(sourceId) => {
          setTableDialogOpen(false);
          setPanel('sources');
          setDataView('fields');
          if (sourceId) setPendingDatasetSourceId(sourceId);
          setCatalogRefreshNonce((current) => current + 1);
        }}
      /> : null}
      {deleteConfirmOpen ? <div className="proposal-scrim" role="dialog" aria-modal="true" aria-label="Delete local App draft"><section className="studio-delete-card"><span className="delete-mark"><Trash2 size={18} /></span><h2>Delete this local draft?</h2><p><strong>{draft.name}</strong> will leave the App list. Its pages, tiles, and local history move to a recovery bundle so you can Undo.</p><footer><button type="button" onClick={() => setDeleteConfirmOpen(false)} disabled={busy}>Cancel</button><button type="button" className="danger" onClick={() => void deleteLocalDraft()} disabled={busy}>{busy ? 'Deleting…' : 'Delete draft'}</button></footer></section></div> : null}
    </div>
  );
}

function PublishReadinessDialog({
  draft,
  serverIssues,
  busy,
  previewRun,
  onClose,
  onRetry,
  onRunPreview,
  onRunAllPreviews,
  onRemoveRequirement,
  onReviseRequirement,
  onAnswerQuestion,
  onResolveTask,
  onOpenSources,
  onOpenFilters,
  onRefreshSources,
  onApproveSemantic,
  onRemoveLocalAnalysis,
}: {
  draft: AppStudioBuildDraft;
  serverIssues: string[];
  busy: boolean;
  previewRun: DashboardRunResponse | null;
  onClose: () => void;
  onRetry: () => void;
  onRunPreview: (pageId: string) => void;
  onRunAllPreviews: () => void;
  onRemoveRequirement: (requirementId: string) => void;
  onReviseRequirement: (question: string) => void;
  onAnswerQuestion: (questionId: string, answerId: string) => void;
  onResolveTask: (task: AppStudioBuildDraft['reviewTasks'][number]) => void;
  onOpenSources: () => void;
  onOpenFilters: () => void;
  onRefreshSources: () => void;
  onApproveSemantic: () => void;
  onRemoveLocalAnalysis: () => void;
}): JSX.Element {
  const requirements = unresolvedPublicationRequirements(draft);
  const clarifications = (draft.frame.clarificationQuestions ?? []).filter((question) => question.required && !question.answerId);
  const tasks = blockingPublicationReviewTasks(draft);
  const previewPages = pagesNeedingSettledPreview(draft);
  const sources = publicationBlockingSources(draft);
  const semanticTiles = legacySemanticTilesNeedingApproval(draft);
  const datasetSources = sources.filter(isDatasetBackedAppSource);
  const localOnlySources = sources.filter((source) => !isDatasetBackedAppSource(source)
    && source.kind !== 'governed_semantic'
    && source.kind !== 'semantic_query');
  const remainingIssues = publicationIssueSummaries(serverIssues);
  const ready = requirements.length === 0
    && clarifications.length === 0
    && tasks.length === 0
    && previewPages.length === 0
    && sources.length === 0
    && semanticTiles.length === 0
    && remainingIssues.length === 0;
  const blockerCount = publicationBlockerCount(draft, serverIssues);

  return <div className="proposal-scrim" role="dialog" aria-modal="true" aria-labelledby="publish-readiness-title">
    <section className="studio-readiness-card">
      <header>
        <span className={ready ? 'ready' : ''}>{ready ? <Check size={19} /> : <ShieldCheck size={19} />}</span>
        <div><h2 id="publish-readiness-title">{ready ? 'Ready to publish' : `${blockerCount} ${blockerCount === 1 ? 'fix' : 'fixes'} before publishing`}</h2><p>{ready ? 'Every check passed.' : 'Finish the items below; this review updates as you go.'}</p></div>
        <button type="button" className="icon" onClick={onClose} aria-label="Close publish checklist"><X size={16} /></button>
      </header>
      <div className="readiness-body">
        {clarifications.map((question) => <section className="readiness-item" key={question.id}>
          <span className="step-mark"><Bot size={15} /></span>
          <div><strong>Choose what you mean</strong><p>{question.question}</p><div className="readiness-choices">{question.choices.map((choice) => <button key={choice.id} type="button" onClick={() => onAnswerQuestion(question.id, choice.id)} disabled={busy}>{choice.label}</button>)}</div></div>
        </section>)}
        {requirements.map((requirement) => <section className="readiness-item" key={requirement.id}>
          <span className="step-mark"><Sparkles size={15} /></span>
          <div><strong>Unanswered App question</strong><p>{requirement.question}</p><small>ZLens will not pretend that an unrelated tile covers this question.</small><div className="readiness-actions"><button type="button" className="primary" onClick={() => onReviseRequirement(requirement.question)} disabled={busy}><Bot size={13} /> Revise with AI</button><button type="button" onClick={() => onRemoveRequirement(requirement.id)} disabled={busy}>Remove from publish scope</button></div></div>
        </section>)}
        {tasks.map((task) => <section className="readiness-item" key={task.id}>
          <span className="step-mark"><FileText size={15} /></span>
          <div><strong>Scoped review</strong><p>{task.message}</p><div className="readiness-actions"><button type="button" className="primary" onClick={() => onResolveTask(task)} disabled={busy}><Check size={13} /> Mark resolved</button></div></div>
        </section>)}
        {previewPages.map((page) => <section className="readiness-item" key={page.id}>
          <span className="step-mark"><Play size={15} /></span>
          <div><strong>Run {page.metadata.title || page.id}</strong><p>Settle the current data, filters, and tile results before publishing this page.</p><div className="readiness-actions"><button type="button" className="primary" onClick={() => onRunPreview(page.id)} disabled={busy}><Play size={13} /> {busy ? 'Running…' : 'Run preview'}</button></div></div>
        </section>)}
        {semanticTiles.length ? <section className="readiness-item">
          <span className="step-mark"><ShieldCheck size={15} /></span>
          <div><strong>Approve Metrics results</strong><p>{semanticTiles.map(({ page, tile, source }) => `${page.metadata.title || page.id}/${tile.title || source?.sourceRef || tile.i}`).join(', ')}</p><small>Approval binds each tile to the settled snapshot and receipt you reviewed.</small><div className="readiness-actions">{previewRun ? <button type="button" className="primary" onClick={onApproveSemantic} disabled={busy}><ShieldCheck size={13} /> Approve settled result</button> : <button type="button" onClick={() => onRunPreview(draft.pages[0]?.id ?? '')} disabled={busy}><Play size={13} /> Run preview first</button>}<button type="button" onClick={onOpenSources}>Open Sources</button></div></div>
        </section> : null}
        {datasetSources.length ? <section className="readiness-item warning">
          <span className="step-mark"><ShieldCheck size={15} /></span>
          <div><strong>Dataset needs review</strong><p>{datasetSources.map((source) => humanize(source.sourceRef)).join(', ')}</p><small>Dataset publication follows the current source lifecycle and contract. Running a preview does not certify it.</small><div className="readiness-actions"><button type="button" className="primary" onClick={onOpenSources}><Blocks size={13} /> Review Dataset source</button></div></div>
        </section> : null}
        {localOnlySources.length ? <section className="readiness-item warning">
          <span className="step-mark"><FileText size={15} /></span>
          <div><strong>Local analysis cannot publish</strong><p>{localOnlySources.map((source) => humanize(source.sourceRef)).join(', ')}</p><small>Replace it with certified data, or remove it from this draft. Removal is saved locally and can be undone from the Studio toolbar.</small><div className="readiness-actions"><button type="button" className="primary" onClick={onOpenSources}><Blocks size={13} /> Replace with certified data</button><button type="button" onClick={onRemoveLocalAnalysis} disabled={busy}><Trash2 size={13} /> Remove local analysis</button></div></div>
        </section> : null}
        {remainingIssues.map((issue) => <section className="readiness-item" key={issue.id}>
          <span className="step-mark"><Settings2 size={15} /></span>
          <div><strong>{issue.title}</strong><p>{issue.detail}</p><div className="readiness-actions">{issue.action === 'filters' ? <button type="button" className="primary" onClick={onOpenFilters}><Filter size={13} /> Open Filters</button> : issue.action === 'refresh_sources' ? <button type="button" className="primary" onClick={onRefreshSources} disabled={busy}><ShieldCheck size={13} /> Accept current certified source</button> : issue.action === 'preview' ? <button type="button" className="primary" onClick={onRunAllPreviews} disabled={busy}><Play size={13} /> {busy ? 'Refreshing previews…' : 'Refresh all page previews'}</button> : <button type="button" className="primary" onClick={onOpenSources}><Blocks size={13} /> Replace or remove source</button>}</div></div>
        </section>)}
        {ready ? <div className="readiness-ready"><Check size={18} /><div><strong>All checks passed</strong><span>Publishing saves the App as files in your project, ready to review in git. Nothing is committed for you.</span></div></div> : null}
      </div>
      <footer><button type="button" onClick={onClose} disabled={busy}>Back to editing</button>{ready ? <button type="button" className="primary" onClick={onRetry} disabled={busy}>{busy ? 'Publishing…' : 'Publish to Project'}</button> : <span className="readiness-footer-hint">Choose a fix above. This review updates as you work.</span>}</footer>
    </section>
  </div>;
}

export function AiPlanReview({
  proposal,
  summary,
  catalog,
  catalogQuery,
  sourcePolicy,
  selectedSourceIds,
  addingSourceId,
  busy,
  onRevise,
  changeCount = 0,
  onApply,
  onDismiss,
  onCatalogQuery,
  onAddSource,
  onAddProposalSource,
  onAnswerClarification,
  onGenerateGap,
  onToggleSource,
}: {
  proposal: AppStudioAiProposal;
  summary: AppStudioAiPlanSummary;
  catalog: AppBlockRecommendation[];
  catalogQuery: string;
  sourcePolicy: AppStudioBuildDraft['sourcePolicy'];
  selectedSourceIds: ReadonlySet<string>;
  addingSourceId: string | null;
  busy: boolean;
  onRevise: () => void;
  /** Tile, page, and link changes the canvas shows for the selected sources. */
  changeCount?: number;
  onApply: () => void;
  onDismiss: () => void;
  onCatalogQuery: (query: string) => void;
  onAddSource: (source: AppBlockRecommendation) => void;
  onAddProposalSource: (sourceId: string, reviewRequired: boolean) => void;
  onAnswerClarification: (questionId: string, answerId: string) => void;
  onGenerateGap: (requirementId: string) => void;
  onToggleSource: (sourceId: string) => void;
}): JSX.Element {
  const unresolved = proposal.clarifications.filter((item) => item.required && !item.answerId);
  const requirementOperation = proposal.operations.find((operation) => operation.type === 'set_requirements');
  const uncoveredRequirements = requirementOperation?.type === 'set_requirements'
    ? requirementOperation.requirements.filter((requirement) => requirementOperation.coverage?.some((coverage) => coverage.requirementId === requirement.id && coverage.status === 'gap'))
    : [];
  const selectedComponents = summary.components.filter((component) => !component.sourceId || selectedSourceIds.has(component.sourceId));
  const selectedSources = summary.sources.filter((source) => selectedSourceIds.has(source.id));
  const suggestedSources = summary.sources.filter((source) => !selectedSourceIds.has(source.id));
  const plannerProvenanceLabel = appStudioPlannerProvenanceLabel(proposal);
  const availableSources = availableAppStudioProposalSources(summary, catalog, catalogQuery).slice(0, 10);
  const sourceNeedle = catalogQuery.trim().toLowerCase();
  const matchesSourceQuery = (source: AppStudioAiPlanSummary['sources'][number]) => !sourceNeedle || [
    source.label, source.sourceRef, sourceKindLabel(source.kind, source.capabilities), source.rationale ?? '',
    ...summary.components.filter((component) => component.sourceId === source.id).flatMap((component) => [component.title, component.visualization]),
  ].join(' ').toLowerCase().includes(sourceNeedle);
  const visibleSelectedSources = selectedSources.filter(matchesSourceQuery);
  const visibleSuggestedSources = suggestedSources.filter(matchesSourceQuery);
  const viewDescription = (source: AppStudioAiPlanSummary['sources'][number]) => {
    const views = summary.components.filter((component) => component.sourceId === source.id);
    if (!views.length) return 'AI will use this data as context.';
    return `Creates ${views.length} ${views.length === 1 ? 'tile' : 'tiles'}: ${views.map((view) => view.title).join(', ')}`;
  };
  const sourceRow = (source: AppStudioAiPlanSummary['sources'][number], selected: boolean) => {
    const blockedByPolicy = source.trustState !== 'certified' && sourcePolicy === 'governed_only';
    const adding = addingSourceId === source.id;
    return <article key={source.id} className={`proposal-source-row ${selected ? 'selected' : ''}`}>
    <span className={`proposal-source-trust ${source.trustState}`}>{source.trustState === 'certified' ? <ShieldCheck size={15} /> : <FileText size={15} />}</span>
    <div><strong>{source.label}</strong><small>{sourceKindLabel(source.kind, source.capabilities)} · {trustLabel(source.trustState)}</small><p>{viewDescription(source)}</p>{source.rationale ? <p className="proposal-source-why">Why: {source.rationale}</p> : null}</div>
    <button type="button" className={selected ? 'remove' : 'add'} disabled={busy} title={blockedByPolicy ? 'Allow data that needs review for this App and rebuild the proposal with this source.' : undefined} onClick={() => selected ? onToggleSource(source.id) : onAddProposalSource(source.id, blockedByPolicy)} aria-label={`${selected ? 'Remove' : blockedByPolicy ? 'Allow data that needs review and add' : 'Add'} ${source.label}${summary.sources.filter((item) => item.label === source.label).length > 1 ? ` for ${summary.components.filter((component) => component.sourceId === source.id).map((component) => component.title).join(', ') || source.id}` : ''}`}>
      {selected ? <><X size={13} /> Remove</> : adding ? 'Adding…' : blockedByPolicy ? 'Allow data that needs review & add' : <><Plus size={13} /> Add</>}
    </button>
  </article>;
  };

  return <section className="studio-ai-plan proposal-source-picker" aria-labelledby="proposal-source-title">
    <header>
      <span><Sparkles size={18} /></span>
      <div>
        <small>AI PROPOSAL</small>
        <h1 id="proposal-source-title">Review the plan</h1>
        <p>AI understood: <strong>{summary.frame?.goal ?? 'Build a governed analytics App'}</strong>. Proposed tiles are on the canvas. Remove any source you do not trust; nothing is saved until you apply.</p>
        {plannerProvenanceLabel ? <small className="proposal-planner-provenance">{plannerProvenanceLabel}</small> : null}
        {proposal.warnings?.length ? <ul className="proposal-warnings" aria-label="AI planner notes">{proposal.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul> : null}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Discard AI proposal"><X size={16} /></button>
    </header>

    <div className="proposal-source-summary" aria-label="AI proposal summary">
      <span><strong>{selectedSources.length}</strong> selected sources</span>
      <span><strong>{selectedComponents.length}</strong> planned tiles</span>
      <span><strong>{sourcePolicy === 'governed_only' ? 'Only certified data' : 'Also allows data that needs review'}</strong> data rule</span>
    </div>

    <div className="proposal-source-body">
      <label className="proposal-source-search"><Search size={15} /><input value={catalogQuery} onChange={(event) => onCatalogQuery(event.target.value)} placeholder="Search proposed and available sources" aria-label="Search proposed and available sources" /></label>

      <section className="proposal-source-group" aria-labelledby="selected-proposal-sources">
        <div className="proposal-source-heading"><div><h2 id="selected-proposal-sources">Selected for this App</h2><p>Remove anything you do not want AI to use.</p></div><strong>{selectedSources.length}</strong></div>
        <div className="proposal-source-list">
          {visibleSelectedSources.map((source) => sourceRow(source, true))}
          {!selectedSources.length ? <div className="proposal-source-empty"><Blocks size={18} /><div><strong>Select at least one source</strong><p>Add an AI suggestion or more certified data below.</p></div></div> : null}
          {selectedSources.length > 0 && !visibleSelectedSources.length ? <p className="studio-ai-plan-empty">No selected source matches this search.</p> : null}
        </div>
      </section>

      {visibleSuggestedSources.length ? <section className="proposal-source-group" aria-labelledby="ai-source-suggestions">
        <div className="proposal-source-heading"><div><h2 id="ai-source-suggestions">AI suggestions</h2><p>Sources removed from the selection remain available here.</p></div><strong>{suggestedSources.length}</strong></div>
        <div className="proposal-source-list">{visibleSuggestedSources.map((source) => sourceRow(source, false))}</div>
      </section> : null}

      <section className="proposal-source-group" aria-labelledby="available-proposal-sources">
        <div className="proposal-source-heading"><div><h2 id="available-proposal-sources">More App sources</h2><p>Add certified data, or explicitly allow data that needs review.</p></div><strong>{availableSources.length}</strong></div>
        <div className="proposal-catalog-list">
          {availableSources.map((source) => <article key={source.id}>
            <span className={source.status === 'certified' ? 'certified' : 'review_required'}>{source.status === 'certified' ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
            <div><strong>{humanize(source.name)}</strong><small>{source.domain || 'General'} · {sourceCatalogKindLabel(source)} · {trustLabel(source.status)}</small><p>{source.description || source.reasons[0] || 'Available data source'}</p></div>
            <button type="button" onClick={() => onAddSource(source)} disabled={busy} title={source.eligibility?.localPreview === false ? 'Allow data that needs review for this App and rebuild the proposal with this source.' : undefined}>{addingSourceId === (source.sourceId ?? source.id) ? 'Adding…' : source.eligibility?.localPreview === false ? 'Allow data that needs review & add' : <><Plus size={13} /> Add</>}</button>
          </article>)}
          {!availableSources.length ? <p className="studio-ai-plan-empty">{catalogQuery.trim() ? 'No additional source matches this search.' : 'All available data is already proposed.'}</p> : null}
        </div>
      </section>

      {sourcePolicy === 'include_review_required' ? <div className="studio-ai-review-lane"><FileText size={14} /><p><strong>Data that needs review is allowed</strong><small>It stays labeled Needs review and cannot be published to the Project until it is replaced, certified, or removed.</small></p></div> : <div className="studio-ai-review-lane"><FileText size={14} /><p><strong>Only certified data is used</strong><small>Use “Allow data that needs review &amp; add” on the data you want. Its trust does not change.</small></p></div>}
      {uncoveredRequirements.length ? <section className="studio-ai-questions"><header><strong>Uncovered requirements</strong><small>{uncoveredRequirements.length} gaps</small></header>{uncoveredRequirements.map((requirement) => <div key={requirement.id}><p>{requirement.question}</p><button type="button" onClick={() => onGenerateGap(requirement.id)} disabled={busy || sourcePolicy !== 'include_review_required'}>{sourcePolicy === 'include_review_required' ? 'Generate draft DQL that needs review' : 'Allow data that needs review to generate'}</button></div>)}</section> : null}
      {unresolved.length ? <section className="studio-ai-questions"><header><strong>AI needs one more decision</strong><small>{unresolved.length} required</small></header>{unresolved.map((item) => <fieldset key={item.id}><legend>{item.question}</legend>{item.choices.map((choice) => <button key={choice.id} type="button" onClick={() => onAnswerClarification(item.id, choice.id)} disabled={busy}><strong>{choice.label}</strong>{choice.description ? <small>{choice.description}</small> : null}</button>)}</fieldset>)}<button type="button" onClick={onRevise} disabled={busy}>{busy ? 'Updating…' : 'Re-run proposal'}</button></section> : null}
    </div>

    <footer><span>{selectedSources.length} {selectedSources.length === 1 ? 'source' : 'sources'} · {selectedComponents.length} {selectedComponents.length === 1 ? 'tile' : 'tiles'}</span><button type="button" onClick={onDismiss}>Discard</button><button type="button" className="primary" onClick={onApply} disabled={busy || unresolved.length > 0 || selectedSources.length === 0}><Sparkles size={14} /> {busy ? 'Applying…' : changeCount > 0 ? `Apply ${changeCount} ${changeCount === 1 ? 'change' : 'changes'}` : `Apply with ${selectedSources.length} ${selectedSources.length === 1 ? 'source' : 'sources'}`}</button></footer>
  </section>;
}

/**
 * The browser sends opaque App identity only. App Autopilot reconstructs the
 * current persisted draft, page, tile, Dataset contract, and any eligible
 * preview reference on the server before a provider sees the request.
 */
export function appAutopilotPresentationContextKey(input: {
  draftId?: string;
  pageId?: string;
  tileId?: string;
  previewRunId?: string;
}): string {
  return `${input.draftId ?? 'new'}:${input.pageId || 'no-page'}:${input.tileId ?? 'no-tile'}:${input.previewRunId ?? 'no-preview'}`;
}

export function appAutopilotContext(
  draft: AppStudioBuildDraft,
  page: AppStudioBuildDraft['pages'][number] | null,
  selectedTile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] | null,
  previewRun: DashboardRunResponse | null,
): Record<string, unknown> {
  return {
    surface: 'app_autopilot',
    appBuildId: draft.id,
    appId: draft.appId,
    ...(page ? { pageId: page.id } : {}),
    ...(selectedTile ? { tileId: selectedTile.i } : {}),
    ...(previewRun ? { previewRunId: previewRun.runId } : {}),
  };
}

function appAutopilotProposalFromArtifact(value: unknown): AppAutopilotChangeProposal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proposal = value as Partial<AppAutopilotChangeProposal>;
  if (proposal.version !== 1
    || typeof proposal.id !== 'string'
    || typeof proposal.runId !== 'string'
    || typeof proposal.artifactId !== 'string'
    || typeof proposal.draftId !== 'string'
    || typeof proposal.pageId !== 'string'
    || typeof proposal.tileId !== 'string'
    || !proposal.intent
    || typeof proposal.intent.action !== 'string'
    || typeof proposal.intent.request !== 'string'
    || typeof proposal.proposalHash !== 'string'
    || proposal.planningMode !== 'universal_agent'
    || !Array.isArray(proposal.operations)
    || !Array.isArray(proposal.diagnostics)) return null;
  return proposal as AppAutopilotChangeProposal;
}

/** Review card for a universal AgentRun artifact, not a second App chat lane. */
export function AppAutopilotReviewCard({
  proposal,
  running,
  onDiscard,
  onApply,
}: {
  proposal: AppAutopilotChangeProposal;
  running: boolean;
  onDiscard: () => void;
  onApply: () => void;
}): JSX.Element {
  const update = proposal.operations[0];
  const query = update?.type === 'update_tile' ? update.patch.query : undefined;
  const grouping = query?.dimensions.map((dimension) => humanize(dimension.alias ?? dimension.field)).join(', ');
  const action = humanize(proposal.intent.action);
  return <section className="studio-copilot-change" aria-label="Typed App change">
    <header><div><small>AI TILE CHANGE</small><strong>Review before it changes the draft</strong></div><span>Draft only</span></header>
    <div className="studio-copilot-change-summary">
      <strong>{humanize(proposal.tileId)}</strong>
      <span>{grouping ? `Proposed grouping: ${grouping}` : `${action}: ${proposal.operations.length} typed App operation${proposal.operations.length === 1 ? '' : 's'} prepared`}</span>
      <small>Prepared through the shared Agent Run and current governed App and Dataset contracts. This has not changed the draft or its source.</small>
    </div>
    {proposal.diagnostics.map((diagnostic) => <p className={`studio-copilot-diagnostic ${diagnostic.severity}`} key={diagnostic.code}>{diagnostic.message}</p>)}
    <footer><button type="button" onClick={onDiscard} disabled={running}>Discard</button><button type="button" className="primary" onClick={onApply} disabled={running}>{running ? 'Applying…' : 'Apply change'}</button></footer>
  </section>;
}

function PagesPanel({ draft, activePageId, onOpen, onAdd, template, onApplyTemplate }: { draft: AppStudioBuildDraft; activePageId?: string; onOpen: (id: string) => void; onAdd: () => void; template: StudioTemplate; onApplyTemplate: (id: StudioTemplate) => void }): JSX.Element {
  return <>
    <div className="studio-list">{draft.pages.map((page) => <button key={page.id} type="button" className={page.id === activePageId ? 'on' : ''} aria-current={page.id === activePageId ? 'page' : undefined} onClick={() => onOpen(page.id)}><div><strong>{page.metadata.title}</strong><small>{page.layout.items.length} {page.layout.items.length === 1 ? 'tile' : 'tiles'}{(page.filters?.length ?? 0) > 0 ? ` · ${page.filters!.length} ${page.filters!.length === 1 ? 'filter' : 'filters'}` : ''}</small></div></button>)}</div>
    <button type="button" className="panel-add" onClick={onAdd}><Plus size={14} /> New page</button>
    <div className="panel-section-label"><span>Page layout</span><small>Applies to this page</small></div>
    <div className="template-list">{TEMPLATE_OPTIONS.map((item) => <button key={item.id} type="button" className={template === item.id ? 'on' : ''} onClick={() => onApplyTemplate(item.id)}><span>{templateIcon(item.id)}</span><div><strong>{item.title}</strong><small>{item.description}</small></div></button>)}</div>
  </>;
}

/** Shown only when a project sets `apps.datasets: false`; field-based tiles are on by default. */
const FIELD_TILES_OFF_MESSAGE = 'Field-based tiles are turned off for this project (apps.datasets is false in dql.config.json).';

export function SourcesPanel({
  usedSources,
  items,
  selected,
  query,
  loading,
  error,
  disabled,
  datasetTilesEnabled,
  sourceFeedback,
  onQuery,
  onSelect,
  onAdd,
  onAddDataset,
  onAuthorDataset,
  onRefreshDatasetBinding,
  onAddContent,
  policy,
  total,
  hasMore,
  onLoadMore,
  onEnableReview,
}: {
  usedSources: AppStudioBuildDraft['sources'];
  items: AppBlockRecommendation[];
  selected: AppBlockRecommendation | null;
  query: string;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  datasetTilesEnabled: boolean;
  sourceFeedback: AppStudioSourceFeedback | null;
  onQuery: (value: string) => void;
  onSelect: (item: AppBlockRecommendation) => void;
  onAdd: (item: AppBlockRecommendation, kind: 'kpi' | 'chart' | 'table') => void;
  onAddDataset: (item: AppBlockRecommendation, kind: 'kpi' | 'chart' | 'table', query: TileQuery, title?: string) => void;
  onAuthorDataset: (item: AppBlockRecommendation) => void;
  onRefreshDatasetBinding: (sourceId: string) => void;
  onAddContent: (kind: 'heading' | 'text') => void;
  policy: AppStudioBuildDraft['sourcePolicy'];
  total: number;
  hasMore: boolean;
  onLoadMore: () => void;
  onEnableReview: () => void;
}): JSX.Element {
  const [viewFilter, setViewFilter] = useState<'all' | 'kpi' | 'chart' | 'table'>('all');
  const usedDataSources = usedSources.filter((source) => source.kind !== 'text');
  const usedIdentifiers = new Set(usedDataSources.flatMap((source) => [source.id, source.sourceRef]));
  const visibleItems = items.filter((item) => viewFilter === 'all' || recommendedComponentKind(item) === viewFilter);
  return <>
    {!datasetTilesEnabled ? <div className="source-catalog-empty" role="status"><small>{FIELD_TILES_OFF_MESSAGE}</small></div> : null}
    <label className="source-search-primary">
      <Search size={15} />
      <input id="studio-field-search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search Datasets, Metrics and saved queries" aria-label="Search Datasets, Metrics and saved queries" />
      {query ? <button type="button" onClick={() => onQuery('')} aria-label="Clear source search" title="Clear search"><X size={13} /></button> : null}
    </label>
    <details className="used-sources-disclosure">
      <summary>
        <div><strong>In this App</strong><small>{usedDataSources.length ? `${usedDataSources.length} data ${usedDataSources.length === 1 ? 'source' : 'sources'}` : 'No source added yet'}</small></div>
        <span>{usedDataSources.length}</span><ChevronDown size={14} />
      </summary>
      {usedDataSources.length ? <div className="used-source-list">{usedDataSources.map((source) => <div key={source.id}>
        <span className={source.trustState}>{source.trustState === 'certified' ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
        <p><strong title={source.sourceRef}>{humanize(source.sourceRef)}</strong><small>{sourceKindLabel(source.kind, source.capabilities)} · {trustLabel(source.trustState)}</small></p>
      </div>)}</div> : <div className="source-panel-state compact"><Blocks size={15} /><div><strong>No data source added yet</strong><small>Choose data below and add a tile.</small></div></div>}
    </details>
    {policy === 'include_review_required' ? <div className="source-review-lane"><FileText size={14} /><p><strong>Data that needs review is allowed</strong><small>Draft DQL or SQL appears here labeled Needs review. It stays local and cannot publish until resolved.</small></p></div> : null}
    <div className="source-catalog-toolbar">
      <div className="source-view-tabs" role="tablist" aria-label="Filter data by recommended tile">
        {([['all', 'All'], ['kpi', 'KPI'], ['chart', 'Charts'], ['table', 'Tables']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={viewFilter === value} className={viewFilter === value ? 'on' : ''} onClick={() => setViewFilter(value)}>{label}</button>)}
      </div>
      <small aria-live="polite">{loading ? 'Finding…' : `${visibleItems.length} of ${total} ${total === 1 ? 'result' : 'results'}`}</small>
    </div>
    {loading ? <div className="source-panel-state"><Sparkles size={16} /><div><strong>Finding data</strong><small>Matching certified Datasets, Metrics and saved queries to this App decision.</small></div></div> : null}
    {!loading && error ? <div className="source-panel-state error"><X size={16} /><div><strong>Sources could not load</strong><small>{error}</small></div></div> : null}
    {!loading && !error && visibleItems.length === 0 ? <div className="source-panel-state"><Search size={16} /><div><strong>{query.trim() || viewFilter !== 'all' ? 'No source matches these filters' : 'No certified data yet'}</strong><small>{query.trim() || viewFilter !== 'all' ? 'Clear the search or choose All to see all data.' : 'Start from a table in the Data tab, or allow data that needs review while you explore.'}</small></div></div> : null}
    <div className="source-catalog-list">{visibleItems.map((item) => {
      const kind = recommendedComponentKind(item);
      const isSelected = selected?.id === item.id;
      const sourceId = item.sourceId ?? item.id;
      const isUsed = usedIdentifiers.has(sourceId) || usedIdentifiers.has(item.id) || usedIdentifiers.has(item.name);
      const blockedByPolicy = item.eligibility?.localPreview === false && policy === 'governed_only';
      const datasetDisabled = Boolean(item.capabilities?.dataset) && !datasetTilesEnabled;
      const rowFeedback = sourceFeedback?.sourceId === sourceId ? sourceFeedback : null;
      const actionStatus: AppStudioSourceActionStatus = rowFeedback?.status ?? 'idle';
      const actionLabel = appStudioSourceActionLabel({
        view: componentKindLabel(kind),
        status: actionStatus,
        reviewRequired: blockedByPolicy,
        alreadyUsed: isUsed,
        pageTitle: rowFeedback?.pageTitle,
      });
      return <article key={item.id} className={`source-catalog-row ${isSelected ? 'on' : ''}`}>
        <button type="button" className="source-catalog-summary" onClick={() => onSelect(item)} aria-label={`View ${item.name} source details`} aria-expanded={isSelected}>
          <span className={item.status === 'certified' ? 'certified' : 'review'}>{item.status === 'certified' ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
          <div><strong title={item.name}>{humanize(item.name)}</strong><small>{humanize(item.domain)} · {sourceCatalogKindLabel(item)} · {trustLabel(item.status)}{isUsed ? ' · In App' : ''}</small></div>
        </button>
        <button type="button" className="source-add-view" disabled={disabled || datasetDisabled} title={datasetDisabled ? FIELD_TILES_OFF_MESSAGE : blockedByPolicy ? 'Allow data that needs review and add this saved query in one saved change.' : undefined} onClick={() => item.capabilities?.dataset ? onSelect(item) : onAdd(item, kind)} aria-label={item.capabilities?.dataset ? `Configure fields for ${item.name}` : `${actionLabel}: ${item.name}`}>{item.capabilities?.dataset ? <><Settings2 size={13} /> Configure fields</> : <><Plus size={13} /> {actionLabel}</>}</button>
        {rowFeedback ? <small className={`source-action-feedback ${rowFeedback.status}`} role={rowFeedback.status === 'error' ? 'alert' : 'status'}>{rowFeedback.status === 'error' ? rowFeedback.message : actionLabel}</small> : null}
        {isSelected ? <div className="source-catalog-detail">
          <p>{item.description || `${humanize(item.name)} from the ${humanize(item.domain)} domain.`}</p>
          {blockedByPolicy ? <button type="button" className="review-action" onClick={onEnableReview}><FileText size={12} /> Allow data that needs review</button> : null}
          {(item.filterIds?.length ?? 0) > 0 ? <span><Filter size={12} /> {item.filterIds!.length} supported {item.filterIds!.length === 1 ? 'filter' : 'filters'}</span> : null}
          {item.capabilities?.dataset && datasetTilesEnabled
            ? <><DatasetTileBuilder key={`${item.sourceId ?? item.id}:${item.sourceRevision ?? item.fingerprint}`} source={item} disabled={disabled || blockedByPolicy} onAdd={onAddDataset} />
              {datasetSourceAuthoringModel(item) ? <button type="button" className="dataset-author-source" disabled={disabled} onClick={() => onAuthorDataset(item)}><FileText size={12} /> Author Dataset definition</button> : item.capabilities.dataset.kind === 'semantic' ? <small className="field-help">These Metrics’ fields and measures are owned by their semantic model.</small> : null}
              {isUsed ? <button type="button" className="dataset-author-source" disabled={disabled || !item.sourceId} onClick={() => item.sourceId && onRefreshDatasetBinding(item.sourceId)}><ShieldCheck size={12} /> Refresh this App binding</button> : null}
            </>
            : item.capabilities?.dataset
              ? <div className="source-view-options"><small>{FIELD_TILES_OFF_MESSAGE}</small></div>
            : <div className="source-view-options" aria-label={`Add ${item.name} as another tile`}>
              <button type="button" disabled={disabled} aria-label={blockedByPolicy ? `Allow data that needs review and add ${item.name} as KPI` : undefined} onClick={() => onAdd(item, 'kpi')}><Gauge size={13} /> KPI</button>
              <button type="button" disabled={disabled} aria-label={blockedByPolicy ? `Allow data that needs review and add ${item.name} as Chart` : undefined} onClick={() => onAdd(item, 'chart')}><BarChart3 size={13} /> Chart</button>
              <button type="button" disabled={disabled} aria-label={blockedByPolicy ? `Allow data that needs review and add ${item.name} as Table` : undefined} onClick={() => onAdd(item, 'table')}><Table2 size={13} /> Table</button>
            </div>}
        </div> : null}
      </article>;
    })}</div>
    {hasMore ? <button type="button" className="source-load-more" onClick={onLoadMore} disabled={loading || disabled}>{loading ? 'Loading…' : 'Load 50 more sources'}</button> : null}
    <div className="panel-section-label"><span>Page elements</span><small>No data required</small></div>
    <div className="content-quick-add"><button type="button" disabled={disabled} onClick={() => onAddContent('heading')}><Heading size={15} /><span><strong>Heading</strong><small>Organize the page</small></span><Plus size={13} /></button><button type="button" disabled={disabled} onClick={() => onAddContent('text')}><Type size={15} /><span><strong>Text</strong><small>Add context or guidance</small></span><Plus size={13} /></button></div>
  </>;
}

function BuildFrameInspector({ draft, prompt, previewRun, onPrompt, onAskAi, onSourcePolicy, onResolveTask, onApproveSemantic }: { draft: AppStudioBuildDraft; prompt: string; previewRun: DashboardRunResponse | null; onPrompt: (value: string) => void; onAskAi: () => void; onSourcePolicy: (value: AppStudioBuildDraft['sourcePolicy']) => void; onResolveTask: (task: AppStudioBuildDraft['reviewTasks'][number]) => void; onApproveSemantic: () => void }): JSX.Element {
  const openTasks = blockingPublicationReviewTasks(draft);
  const semanticNeedsApproval = legacySemanticTilesNeedingApproval(draft).length > 0;
  return <div className="inspector-body"><section><label>Business decision</label><textarea value={prompt} onChange={(event) => onPrompt(event.target.value)} rows={5} /></section><section><label>Data rule</label><select value={draft.sourcePolicy} onChange={(event) => onSourcePolicy(event.target.value as AppStudioBuildDraft['sourcePolicy'])}><option value="governed_only">Only certified data</option><option value="include_review_required">Also allow data that needs review</option></select><small className="field-help">Data that needs review stays local and blocks Project publication until it is replaced or certified.</small></section><section className="frame-facts"><label>Build Frame</label><div><span>Audience</span><strong>{draft.frame.audience || 'Stakeholders'}</strong></div><div><span>Metrics</span><strong>{draft.frame.metrics.join(', ') || 'Needs clarification'}</strong></div><div><span>Dimensions</span><strong>{draft.frame.dimensions.join(', ') || 'Automatic'}</strong></div><div><span>Data rule</span><strong>{draft.sourcePolicy === 'governed_only' ? 'Only certified data' : 'Also allows data that needs review'}</strong></div></section>{semanticNeedsApproval ? <section><label>Semantic review</label><button type="button" className="review-action" onClick={onApproveSemantic} disabled={!previewRun}><ShieldCheck size={14} /> {previewRun ? 'Approve this settled result' : 'Run preview to approve'}</button></section> : null}{openTasks.length ? <section className="review-task-list"><label>Review tasks</label>{openTasks.map((task) => <div key={task.id}><span>{task.message}</span><button type="button" onClick={() => onResolveTask(task)}><Check size={12} /> Resolve</button></div>)}</section> : null}<button type="button" className="ask-ai" onClick={onAskAi}><Bot size={16} /> Ask AI to build or revise this page</button><section className="trust-summary"><ShieldCheck size={17} /><div><strong>Nothing publishes silently</strong><p>AI changes are typed diffs. Project publication revalidates live source trust and filter bindings.</p></div></section></div>;
}

export function ComponentInspector({ initialTab = 'data', tile, run, pageId, page, pages, sources, dataset, disabled, onOpenSources, onSaveDatasetTileAsBlock, savingDatasetTileAsBlock, savedDatasetReviewDraft, onReplaceDatasetTileWithBlock = () => undefined, replacingDatasetTileWithBlock = false, onPreviewLegacySemanticConversion = () => undefined, previewingLegacySemanticConversion = false, semanticTileConversionPreview, onAcceptLegacySemanticConversion = () => undefined, acceptingLegacySemanticConversion = false, onRefreshDatasetTile, onUpdate, onUpdateInteractions, onDelete }: { initialTab?: 'data' | 'visual' | 'interactions'; tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]; run?: DashboardRunResponse['tiles'][number]; pageId: string; page: AppStudioBuildDraft['pages'][number]; pages: AppStudioBuildDraft['pages']; sources: AppStudioBuildDraft['sources']; dataset?: DatasetDescriptor; disabled: boolean; onOpenSources: () => void; onSaveDatasetTileAsBlock: () => void; savingDatasetTileAsBlock: boolean; savedDatasetReviewDraft?: Extract<DatasetTileSaveAsBlockResponse, { ok: true }>; onReplaceDatasetTileWithBlock?: () => void; replacingDatasetTileWithBlock?: boolean; onPreviewLegacySemanticConversion?: () => void; previewingLegacySemanticConversion?: boolean; semanticTileConversionPreview?: Extract<SemanticTileConversionPreviewResponse, { ok: true }>; onAcceptLegacySemanticConversion?: () => void; acceptingLegacySemanticConversion?: boolean; onRefreshDatasetTile: () => void; onUpdate: (patch: Partial<typeof tile>) => void; onUpdateInteractions: (interactions: AppStudioBuildDraft['pages'][number]['interactions']) => void; onDelete: () => void }): JSX.Element {
  const [title, setTitle] = useState(tile.title ?? '');
  const [markdown, setMarkdown] = useState(tile.text?.markdown ?? '');
  const [description, setDescription] = useState(tile.description ?? '');
  const [owner, setOwner] = useState(tile.owner ?? '');
  const [visualizationFeedback, setVisualizationFeedback] = useState<string | null>(null);
  const [tab, setTab] = useState<'data' | 'visual' | 'interactions'>(initialTab);
  useEffect(() => setTitle(tile.title ?? ''), [tile.i, tile.title]);
  useEffect(() => setMarkdown(tile.text?.markdown ?? ''), [tile.i, tile.text?.markdown]);
  useEffect(() => setDescription(tile.description ?? ''), [tile.i, tile.description]);
  useEffect(() => setOwner(tile.owner ?? ''), [tile.i, tile.owner]);
  useEffect(() => setVisualizationFeedback(null), [tile.i]);
  const options = tile.viz.options ?? {};
  const columns = run?.result?.columns ?? [];
  const grainKeyCheck = formatDatasetGrainEvidenceKeyCheck(run?.dataset?.grainRuntimeEvidence);
  // A calculation over certified measures reads as Governed, as it does for readers.
  const calculatedTrust = tile.trustState === 'certified' && Boolean(tile.query?.calculations?.length);
  const currentDatasetEvidence = run && tile.query && isCurrentDatasetTileEvidence(tile, run)
    ? presentDatasetTileEvidence(run)
    : undefined;
  const setOption = (key: string, value: unknown) => onUpdate({ viz: { ...tile.viz, options: { ...options, [key]: value || undefined } } });
  const updateDatasetQuery = (query: TileQuery, recovery?: { visualization: 'table'; message: string }) => {
    if (recovery) {
      setVisualizationFeedback(`${recovery.message} The tile was changed to Table; selected fields were kept.`);
      onUpdate({ query, viz: { ...tile.viz, type: recovery.visualization } });
      return;
    }
    setVisualizationFeedback(null);
    onUpdate({ query });
  };
  // Shelves (RFC 0009): the query follows them, the contract checks it, and
  // the chart type follows what the shelves draw.
  const tileEncoding = tile.query ? (tile.viz.encoding ?? encodingFromQuery(tile.query, tile.viz.type)) : undefined;
  // Numbers a table or pivot can format: the result's number columns, by the names readers see.
  const numberColumns = (run?.status === 'ok' ? run.result?.columnsMeta ?? [] : [])
    .filter((meta) => ['currency', 'percent', 'number', 'count'].includes(meta.kind))
    .map((meta) => ({ name: meta.name, label: tileEncoding?.fields?.[`measure:${meta.name}`]?.label ?? meta.label ?? humanize(meta.name) }));
  const updateShelves = ({ encoding, query: shelfQuery, visualization }: ShelfChange, style = tile.viz.style): string | void => {
    if (!dataset) return 'This tile has no Dataset.';
    if (!shelfQuery.measures.length && !shelfQuery.calculations?.some((calculation) => calculation.expr)) return 'A tile needs at least one measure. Add another before removing this one.';
    // A Show Me pick names its chart; a moved field keeps the chart when the shelves still read that way.
    const type = visualization ?? vizTypeForEncoding(encoding, descriptorTimeField(dataset), tile.viz.type);
    // A pivot asks the warehouse for its totals and shows every group.
    const pivot = type === 'pivot';
    const query = pivot ? withPivotRollups(withoutRowLimit(shelfQuery), encoding, style?.totals) : withoutRollups(shelfQuery);
    const validation = validateTileQuery(dataset, query);
    if (!tileQueryValidationRuns(validation)) return validation.diagnostics[0]?.message ?? 'The Dataset does not cover that field combination.';
    const compatibility = datasetTileVisualizationCompatibility(query, type);
    setVisualizationFeedback(compatibility.compatible ? null : `${compatibility.message} Shown as a Table.`);
    const { style: _style, ...viz } = tile.viz;
    onUpdate({ query, viz: { ...viz, ...(style ? { style } : {}), type: (compatibility.compatible ? type : 'table') as typeof tile.viz.type, encoding } });
  };
  const updateVisualization = (type: typeof tile.viz.type) => {
    if (tile.query && dataset) {
      const visualization = datasetTileVisualizationCompatibility(tile.query, type);
      if (!visualization.compatible) {
        setVisualizationFeedback(`${visualization.message} Choose Table or change the Dataset field selection first.`);
        return;
      }
    }
    setVisualizationFeedback(null);
    onUpdate({ viz: { ...tile.viz, type } });
  };
  const savedDatasetVisualization = tile.query && dataset
    ? datasetTileVisualizationCompatibility(tile.query, tile.viz.type)
    : undefined;
  const driverTile = Boolean(tile.driver);
  const dataTile = !tile.text && !driverTile;
  const rowCount = run?.status === 'ok' ? run.result?.rowCount ?? run.result?.rows.length ?? 0 : undefined;
  return <div className="inspector-body">
    <section className="inspector-title"><label htmlFor={`tile-title-${tile.i}`}>Title</label><input id={`tile-title-${tile.i}`} value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => { if (title.trim() !== (tile.title ?? '')) onUpdate({ title: title.trim() }); }} /></section>
    {dataTile || driverTile ? <section className="inspector-docs">
      <label htmlFor={`tile-description-${tile.i}`}>Description</label>
      {/* An empty string clears the field: a missing key would leave the old text in the draft. */}
      <textarea id={`tile-description-${tile.i}`} rows={2} maxLength={2000} placeholder="What this shows and how to read it" value={description} onChange={(event) => setDescription(event.target.value)} onBlur={() => { if (description.trim() !== (tile.description ?? '')) onUpdate({ description: description.trim() }); }} />
      <label htmlFor={`tile-owner-${tile.i}`}>Owner</label>
      <input id={`tile-owner-${tile.i}`} maxLength={120} placeholder="Who answers for these numbers" value={owner} onChange={(event) => setOwner(event.target.value)} onBlur={() => { if (owner.trim() !== (tile.owner ?? '')) onUpdate({ owner: owner.trim() }); }} />
      <small className="field-help">Readers see the description under the title and the owner in the tile’s receipt.</small>
    </section> : null}
    {dataTile ? <div className="inspector-tabs" role="tablist" aria-label="Tile settings">{([['data', 'Data'], ['visual', 'Visual'], ['interactions', 'Interactions']] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</div> : null}
    {driverTile && tile.driver ? <DriverTileSettings driver={tile.driver} disabled={disabled} onChange={(driver) => onUpdate({ driver })} /> : null}
    {!dataTile && !driverTile ? <>
    {tile.text ? <section><label>Content</label><textarea rows={7} value={markdown} onChange={(event) => setMarkdown(event.target.value)} onBlur={() => { if (markdown !== tile.text?.markdown) onUpdate({ text: { markdown } }); }} /><small className="field-help">Safe Markdown only. Executable HTML and JavaScript are not supported.</small></section> : null}
    <section><label>Responsive size</label><div className="size-buttons">{[['Compact', 3, 2], ['Standard', 6, 4], ['Wide', 12, 4], ['Tall', 6, 7]].map(([label, w, h]) => <button key={label} type="button" onClick={() => onUpdate({ w: Number(w), h: Number(h) })}>{label}</button>)}</div></section>
    </> : null}
    {dataTile && tab === 'data' ? <>
    {tile.query && dataset && tileEncoding ? <DatasetTileQueryInspector descriptor={dataset} query={tile.query} visualization={tile.viz.type} encoding={tileEncoding} disabled={disabled} onChange={updateDatasetQuery} onShelves={updateShelves} onOpenSources={onOpenSources} result={run?.status === 'ok' ? run.result : undefined} /> : null}
    <section className="data-trust"><label>Data & trust</label><div><span className={`trust-dot ${calculatedTrust ? 'governed' : tile.trustState ?? 'draft_ready'}`} /><strong>{calculatedTrust ? 'Governed' : trustLabel(tile.trustState)}</strong></div>{calculatedTrust ? <small>Calculations over certified measures read as Governed: the arithmetic is checked, but nobody reviewed the formula.</small> : null}<p>{tile.query && dataset ? `${dataset.kind === 'semantic' ? 'Metrics' : 'Dataset'}: ${dataset.label}` : tile.block ? `Saved query · ${trustLabel(tile.trustState)}: ${'blockId' in tile.block ? tile.block.blockId : tile.block.ref}` : tile.semantic ? `Metrics: ${tile.semantic.id}` : tile.draftAnalysis ? `Draft DQL · Needs review: ${tile.draftAnalysis.ref}` : 'Page content'}</p>{tile.sourceEvidence?.slice(0, 2).map((evidence, index) => <small key={`${evidence.source}-${index}`}>{evidence.reason}</small>)}{run ? <small>{run.status === 'ok' ? `Settled on ${run.result?.rowCount ?? run.result?.rows.length ?? 0} rows` : run.error}</small> : null}{grainKeyCheck ? <small>Full-source key check: {grainKeyCheck}</small> : null}{run?.dataset?.cacheDelivery ? <div className="dataset-cache-delivery"><small>Cached {new Date(run.dataset.cacheDelivery.cachedAt).toLocaleString()} · this is not fresh publication or reusable-block evidence.</small><button type="button" disabled={disabled} onClick={onRefreshDatasetTile}>Refresh live data</button></div> : null}{tile.query ? <details className="dataset-dql-receipt"><summary>View execution evidence</summary>{currentDatasetEvidence ? <DatasetTileExecutionEvidence presentation={currentDatasetEvidence} /> : <p>{run ? 'This execution evidence no longer matches the selected Dataset source or query. Run a governed preview to inspect the current Dataset query, executed SQL, binding evidence, and provenance.' : 'Run a governed preview to inspect the current Dataset query, executed SQL, binding evidence, and provenance.'}</p>}</details> : null}{tile.query ? <div className="dataset-reusable-block"><strong>Reusable block</strong><p>Save this settled result as a separate review draft. This App tile stays unchanged and the new block is not certified.</p><button type="button" disabled={disabled || savingDatasetTileAsBlock || replacingDatasetTileWithBlock || !currentDatasetEvidence || Boolean(run?.dataset?.cacheDelivery)} onClick={onSaveDatasetTileAsBlock}>{savingDatasetTileAsBlock ? 'Saving review draft…' : 'Save as reusable review draft'}</button>{savedDatasetReviewDraft ? <div className="dataset-review-replacement"><small>Saved review draft: {savedDatasetReviewDraft.path}</small>{savedDatasetReviewDraft.replacementEligible ? <button type="button" disabled={disabled || savingDatasetTileAsBlock || replacingDatasetTileWithBlock || !currentDatasetEvidence || Boolean(run?.dataset?.cacheDelivery)} onClick={onReplaceDatasetTileWithBlock}>{replacingDatasetTileWithBlock ? 'Proving equivalence…' : 'Replace with this review draft'}</button> : <small>{savedDatasetReviewDraft.replacementMessage ?? 'This saved draft is fixed-value only and cannot replace the interactive Dataset tile.'}</small>}</div> : null}{!currentDatasetEvidence ? <small>Run the current Dataset tile before saving it.</small> : null}{run?.dataset?.cacheDelivery ? <small>Refresh live data before saving or replacing this tile.</small> : null}</div> : null}</section>
    {tile.semantic && !tile.query ? <section className="dataset-reusable-block"><strong>Convert to Dataset query</strong><p>Preview an exact field-query mapping for this legacy semantic tile. ZLens runs both paths in one fresh read scope before it can apply the change. The original semantic payload is retained as provenance; this does not certify the source.</p><button type="button" disabled={disabled || previewingLegacySemanticConversion || acceptingLegacySemanticConversion} onClick={onPreviewLegacySemanticConversion}>{previewingLegacySemanticConversion ? 'Proving conversion…' : 'Preview Dataset conversion'}</button>{semanticTileConversionPreview ? <div className="dataset-review-replacement"><small>Mapped source: {semanticTileConversionPreview.candidate.sourceId}</small><small>Mapped query: {semanticTileConversionPreview.candidate.query.measures.map((measure) => measure.measure).join(', ')}{semanticTileConversionPreview.candidate.query.dimensions.length ? ` by ${semanticTileConversionPreview.candidate.query.dimensions.map((dimension) => dimension.field).join(', ')}` : ''}</small><button type="button" disabled={disabled || previewingLegacySemanticConversion || acceptingLegacySemanticConversion} onClick={onAcceptLegacySemanticConversion}>{acceptingLegacySemanticConversion ? 'Rechecking and applying…' : 'Apply Dataset conversion'}</button></div> : <small>Preview first. Unsupported bindings, source drift, or an incomplete comparison stay with the original semantic tile.</small>}</section> : null}
    </> : null}
    {dataTile && tab === 'visual' ? <>
    {tile.query && dataset && tileEncoding ? <section><ShowMePanel suggestions={tileShowMe(dataset, tileEncoding, tile.query, run?.status === 'ok' ? run.result : undefined)} current={currentShowMeChart(tile.viz.type, tileEncoding, descriptorTimeField(dataset))} disabled={disabled} onPick={(suggestion) => { const encoding = applyShowMe(tileEncoding, suggestion); const message = updateShelves({ encoding, query: queryFromEncoding(encoding, tile.query!, descriptorTimeGrain(dataset)), visualization: suggestion.viz }); if (message) setVisualizationFeedback(message); }} />{visualizationFeedback ? <small className="dataset-interaction-message" role="status">{visualizationFeedback}</small> : null}</section> : <section><label>Chart</label><div className="chart-type-grid" role="radiogroup" aria-label="Chart type">{CHART_TYPE_OPTIONS.map(([type, label]) => { const active = tile.viz.type === type || (type === 'single_value' && tile.viz.type === 'kpi'); return <button key={type} type="button" role="radio" aria-checked={active} className={active ? 'on' : ''} disabled={disabled} onClick={() => { if (!active) updateVisualization(type); }}>{chartTypeIcon(type)}<span>{label}</span></button>; })}</div>{savedDatasetVisualization && !savedDatasetVisualization.compatible ? <small className="dataset-builder-error" role="alert">{savedDatasetVisualization.message} Choose Table to keep all selected fields visible.</small> : null}{visualizationFeedback ? <small className="dataset-interaction-message" role="status">{visualizationFeedback}</small> : null}</section>}
    {!tile.text && !(tile.query && tileEncoding) ? <section className="field-mapping"><label>Field mapping</label><div><span>X / category</span><select value={String(options.x ?? '')} onChange={(event) => setOption('x', event.target.value)}><option value="">Auto</option>{columns.map((column) => <option key={column} value={column}>{humanize(column)}</option>)}</select></div><div><span>Y / value</span><select value={String(options.y ?? '')} onChange={(event) => setOption('y', event.target.value)}><option value="">Auto</option>{columns.map((column) => <option key={column} value={column}>{humanize(column)}</option>)}</select></div><small className="field-help">Run preview to load the exact result fields.</small></section> : null}
    {!tile.text ? <ChartStylePanel
      key={tile.i}
      vizType={tile.viz.type}
      style={tile.viz.style}
      legacyFormat={typeof options.format === 'string' ? options.format : undefined}
      measureColumns={numberColumns}
      {...(numberColumns[0] ? { kpiUnit: (run?.status === 'ok' ? run.result?.columnsMeta?.find((meta) => meta.name === numberColumns[0]!.name)?.kind : undefined) } : {})}
      {...(tile.query && tileEncoding && tile.viz.type === 'pivot' ? {
        onTotals: (totals: PivotTotals) => {
          const message = updateShelves({ encoding: tileEncoding, query: tile.query!, visualization: 'pivot' }, compactVizStyle({ ...(tile.viz.style ?? {}), totals }));
          if (message) setVisualizationFeedback(message);
        },
      } : {})}
      disabled={disabled}
      onChange={(style) => {
        const { style: _previous, ...viz } = tile.viz;
        onUpdate({ viz: style ? { ...viz, style } : viz });
      }}
    /> : null}
    <section><label>Responsive size</label><div className="size-buttons">{[['Compact', 3, 2], ['Standard', 6, 4], ['Wide', 12, 4], ['Tall', 6, 7]].map(([label, w, h]) => <button key={label} type="button" onClick={() => onUpdate({ w: Number(w), h: Number(h) })}>{label}</button>)}</div></section>
    </> : null}
    {dataTile && tab === 'interactions' ? (tile.query && dataset
      ? <DatasetInteractionInspector tile={tile} page={page} pages={pages} sources={sources} descriptor={dataset} disabled={disabled} onChange={onUpdateInteractions} />
      : <p className="field-help">Click actions, cross-filters and drill-downs are available for tiles built from Dataset fields.</p>) : null}
    <footer className="inspector-footer">
      <span className={`run-state ${run?.status === 'ok' ? 'ok' : run ? 'error' : ''}`}>{run ? run.status === 'ok' ? `Live · ${rowCount} ${rowCount === 1 ? 'row' : 'rows'}` : 'Last run failed' : 'Not run yet'}</span>
      <button type="button" className="delete-component" onClick={onDelete}><Trash2 size={14} /> Remove</button>
    </footer>
    <small className="inspector-id">{pageId} / {tile.i}</small>
  </div>;
}

function DatasetEvidenceRows({ rows }: { rows: DatasetEvidenceRow[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  return <dl className="dataset-evidence-rows">{rows.map((row) => <div key={`${row.label}:${row.value}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;
}

function DatasetTileExecutionEvidence({ presentation }: { presentation: DatasetTileEvidencePresentation }): JSX.Element {
  return <div className="dataset-execution-evidence">
    <small>Authored Dataset query specification (declarative; not DQL)</small>
    <pre>{presentation.authoredQuerySpec ?? presentation.authoredQuerySpecUnavailable}</pre>
    <small>Executed SQL (server returned)</small>
    <pre>{presentation.executedSql ?? presentation.executedSqlUnavailable}</pre>
    <small>Bound parameter evidence (values redacted)</small>
    <DatasetEvidenceRows rows={presentation.parameterEvidence} />
    <small>Execution provenance</small>
    <DatasetEvidenceRows rows={presentation.provenance} />
    <small>{presentation.receipt.kind === 'semantic_provider_receipt' ? 'Semantic provider execution receipt' : 'Provider execution receipt'}</small>
    {presentation.receipt.rows.length ? <DatasetEvidenceRows rows={presentation.receipt.rows} /> : null}
    {presentation.receipt.notice ? <p>{presentation.receipt.notice}</p> : null}
  </div>;
}

function StaticComponentPreview({ loading, view }: { loading: boolean; view?: string }): JSX.Element {
  if (loading) {
    // The skeleton takes the tile's final shape, so the page does not jump
    // when results arrive.
    const shape = view === 'single_value' || view === 'kpi' ? 'kpi' : view === 'table' || view === 'pivot' ? 'table' : view === 'line' || view === 'area' ? 'line' : 'bars';
    return <div className={`preview-skeleton ${shape}`} role="status" aria-busy="true">
      <span className="visually-hidden">Running governed preview…</span>
      {shape === 'kpi' ? <><i className="sk-value" /><i className="sk-caption" /></> : null}
      {shape === 'table' ? Array.from({ length: 5 }, (_, index) => <i key={index} className="sk-row" />) : null}
      {shape === 'bars' ? <div className="sk-bars">{[62, 84, 48, 72, 36, 58].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div> : null}
      {shape === 'line' ? <svg className="sk-line" viewBox="0 0 200 80" preserveAspectRatio="none" aria-hidden="true"><path d="M0 60 L30 48 L60 54 L90 30 L120 38 L150 20 L200 26" /></svg> : null}
    </div>;
  }
  return <div className="preview-state idle"><span className="preview-idle-mark"><Play size={15} /></span><strong>Preview is not loaded</strong><span>App Studio runs this automatically when the data tile is added. Use Run preview to refresh an older draft.</span></div>;
}

function StudioFilterControl({
  filter,
  availability,
  value,
  applying,
  onChange,
}: {
  filter: NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number];
  availability?: StudioFilterAvailability;
  value: unknown;
  applying: boolean;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const label = filter.label ?? humanize(filter.id);
  const optionValues = Array.from(new Set([...(filter.options ?? []), ...(availability?.values ?? [])]));
  const [query, setQuery] = useState(String(value ?? ''));
  useEffect(() => setQuery(String(value ?? '')), [value]);
  if (filter.type === 'daterange') {
    const range = value && typeof value === 'object' && !Array.isArray(value) ? value as { start?: string; end?: string } : {};
    const availabilityLabel = applying
      ? 'Checking dates…'
      : availability?.dateRange
        ? `Available ${availability.dateRange.min} – ${availability.dateRange.max}`
        : availability?.valueCount === 0
          ? 'No date values exist for this field'
          : 'Run preview to check available dates';
    return <label className={`studio-filter range ${availability?.valueCount === 0 ? 'empty' : ''}`} aria-busy={applying}><span>{label}</span><input type="date" min={availability?.dateRange?.min} max={availability?.dateRange?.max} aria-label={`${label} start`} value={range.start ?? ''} onChange={(event) => onChange({ ...range, start: event.target.value })} /><i>–</i><input type="date" min={availability?.dateRange?.min} max={availability?.dateRange?.max} aria-label={`${label} end`} value={range.end ?? ''} onChange={(event) => onChange({ ...range, end: event.target.value })} /><small>{availabilityLabel}</small></label>;
  }
  if (filter.type === 'boolean') {
    return <label className="studio-filter boolean" aria-busy={applying}><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
  }
  if (filter.type === 'date') {
    return <label className={`studio-filter ${availability?.valueCount === 0 ? 'empty' : ''}`} aria-busy={applying}><span>{label}</span><input type="date" min={availability?.dateRange?.min} max={availability?.dateRange?.max} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} /><small>{applying ? 'Checking dates…' : availability?.dateRange ? `Available ${availability.dateRange.min} – ${availability.dateRange.max}` : availability?.valueCount === 0 ? 'No date values exist for this field' : 'Run preview to check available dates'}</small></label>;
  }
  if (optionValues.length > 0 && (filter.type === 'select' || filter.type === 'multiselect')) {
    return <StudioFilterDropdown label={label} values={optionValues} value={value} multiple={filter.type === 'multiselect'} applying={applying} truncated={availability?.truncated ?? false} onChange={onChange} />;
  }
  if (optionValues.length > 0 && filter.type === 'search') {
    const listId = `studio-filter-${filter.id.replace(/[^a-z0-9_-]/gi, '-')}-options`;
    return <div className="studio-filter searchable" aria-busy={applying}>
      <label htmlFor={`${listId}-input`}>{label}</label>
      <span className="studio-filter-combobox"><Search size={12} aria-hidden="true" /><input id={`${listId}-input`} type="search" list={listId} value={query} placeholder="All values" autoComplete="off" onChange={(event) => {
        const nextQuery = event.target.value;
        setQuery(nextQuery);
        onChange(nextQuery);
      }} /><ChevronDown size={12} aria-hidden="true" /></span>
      <datalist id={listId}>{optionValues.map((option) => <option key={option} value={option} />)}</datalist>
      <small>{applying ? 'Applying…' : `${optionValues.length}${availability?.truncated ? '+' : ''} ${optionValues.length === 1 && !availability?.truncated ? 'value' : 'values'} · type or choose`}</small>
    </div>;
  }
  return <label className="studio-filter" aria-busy={applying}><span>{label}</span><input type={filter.type === 'number' ? 'number' : 'search'} value={String(value ?? '')} placeholder="All values" onChange={(event) => onChange(filter.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)} /><small>{applying ? 'Applying…' : 'Updates automatically'}</small></label>;
}

function StudioFilterDropdown({
  label,
  values,
  value,
  multiple,
  applying,
  truncated,
  onChange,
}: {
  label: string;
  values: string[];
  value: unknown;
  multiple: boolean;
  applying: boolean;
  truncated: boolean;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const selected = multiple
    ? new Set(Array.isArray(value) ? value.map(String) : value === undefined || value === null || value === '' ? [] : [String(value)])
    : new Set(value === undefined || value === null || value === '' ? [] : [String(value)]);
  const visible = values.filter((option) => option.toLowerCase().includes(query.trim().toLowerCase()));
  const summary = selected.size === 0
    ? 'All values'
    : multiple
      ? `${selected.size} selected`
      : [...selected][0];
  const selectValue = (option: string) => {
    if (!multiple) {
      onChange(option);
      if (detailsRef.current) detailsRef.current.open = false;
      setQuery('');
      return;
    }
    const next = new Set(selected);
    if (next.has(option)) next.delete(option); else next.add(option);
    onChange([...next]);
  };
  return <details ref={detailsRef} className="studio-filter dropdown" aria-busy={applying}>
    <summary><span><small>{label}</small><strong>{summary}</strong></span><ChevronDown size={12} /></summary>
    <div className="studio-filter-menu">
      <label><Search size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search values" autoComplete="off" /></label>
      <button type="button" className="filter-option-clear" onClick={() => { onChange(multiple ? [] : ''); if (!multiple && detailsRef.current) detailsRef.current.open = false; }}>All values</button>
      <div>{visible.map((option) => <button key={option} type="button" className={selected.has(option) ? 'on' : ''} onClick={() => selectValue(option)}>{multiple ? <span className="filter-option-check">{selected.has(option) ? <Check size={11} /> : null}</span> : null}<span>{option}</span>{!multiple && selected.has(option) ? <Check size={12} /> : null}</button>)}</div>
      {visible.length === 0 ? <small>No matching values</small> : null}
      <footer>{applying ? 'Applying…' : `${values.length}${truncated ? '+' : ''} available values`}</footer>
    </div>
  </details>;
}

export function StudioTilePreview({
  tile,
  run,
  loading,
  themeMode,
  crossFilterFields = [],
  activeCrossFilters = [],
  onSelectDatasetMark,
  onDrillDatasetMark,
  onDrillBack,
  onNavigate,
  hasNavigation = false,
  linkProposal,
  onLinkField,
  chartHeight: placedChartHeight,
  onMark,
}: {
  /** A clicked mark opens the click menu (RFC 0009 step 6a). */
  onMark?: (row: Record<string, unknown>, at: MarkPointer | undefined, hierarchyCandidates: RuntimeDatasetHierarchyDrillCandidate[]) => void;
  tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number];
  run?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  themeMode: ThemeMode;
  /** Chart height from the tile's grid rows on the placed canvas. */
  chartHeight?: number;
  crossFilterFields?: string[];
  activeCrossFilters?: StudioDatasetCrossFilter[];
  onSelectDatasetMark?: (field: string, values: unknown[]) => void;
  onDrillDatasetMark?: (candidate: RuntimeDatasetHierarchyDrillCandidate, row: Record<string, unknown>) => void;
  onDrillBack?: () => void;
  onNavigate?: () => void;
  hasNavigation?: boolean;
  /** Same-name, same-type fields on page Datasets this tile could filter. */
  linkProposal?: DatasetCrossFilterLinkProposal;
  onLinkField?: () => void;
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [height, setHeight] = useState(190);
  // The card's height comes from its grid rows (see studio-component-card),
  // while this frame's measured height follows its own content. Sizing the
  // chart from the rows keeps it stable: it can neither grow nor shrink the
  // frame it sits in.
  // On the placed canvas the grid rows fix the card, and the chart area is
  // whatever the notices and controls leave (a flex item with a zero basis).
  // Its size never depends on the chart, so measuring it is safe there.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const placed = placedChartHeight !== undefined;
  const chartHeight = placed
    ? Math.max(96, bodyHeight ?? placedChartHeight)
    : Math.max(120, tile.h * 68 - 56);
  useEffect(() => {
    const node = bodyRef.current;
    if (!placed || !node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setBodyHeight(Math.floor(entry.contentRect.height)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [placed, run]);
  const [markActionId, setMarkActionId] = useState<string>('filter');
  useEffect(() => {
    const node = frameRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(220, Math.floor(entry.contentRect.width)));
      setHeight(Math.max(120, Math.floor(entry.contentRect.height)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [run]);
  if (!run) return <StaticComponentPreview loading={loading} view={tile.viz.type} />;
  if (run.status === 'ok' && run.tileType === 'driver' && run.driver) {
    return <div className="live-component-preview driver"><DriverView analysis={run.driver} compact={tile.h <= 4} /></div>;
  }
  if (run.status !== 'ok' && run.error?.startsWith('APP_DATASETS_FEATURE_DISABLED')) {
    return <div className="preview-state error"><strong>Field-based tiles are off</strong><span>{FIELD_TILES_OFF_MESSAGE}</span></div>;
  }
  if (run.status !== 'ok' || !run.result) return <div className="preview-state error"><strong>{humanize(run.status)}</strong><span>{run.error ?? 'This tile could not run with the current source and filters.'}</span></div>;
  const visualization = tile.query
    ? datasetTileVisualizationCompatibility(tile.query, tile.viz.type)
    : undefined;
  if (visualization && !visualization.compatible) {
    return <div className="preview-state error"><strong>Dataset visualization needs attention</strong><span>{visualization.message} Choose Table or change the Dataset field selection before running this tile.</span></div>;
  }
  const encodedTable = encodedChartConfig(tile).chart === 'table';
  const chart = encodedTable ? 'table' : tile.viz.type === 'single_value' ? 'kpi' : tile.viz.type;
  const chartConfig = {
    ...(run.chartConfig ?? {}),
    ...(tile.viz.options ?? {}),
    chart,
    // The draft's own style wins: the author sees the change before any rerun.
    ...(tile.viz.style ? { style: tile.viz.style, ...(tile.viz.style.palette ? { colorPalette: tile.viz.style.palette } : {}) } : {}),
    // So do its shelves (RFC 0009): axes, series, labels and tooltip.
    ...encodedChartConfig(tile),
  } as CellChartConfig;
  const shownResult = encodedTileResult(tile, run.result);
  const hierarchy = run.dataset?.hierarchy;
  const hierarchyCandidates = (hierarchy?.candidates ?? []).filter((candidate) => (
    run.result!.rows.some((row) => row[candidate.fromAlias] !== undefined && row[candidate.fromAlias] !== null)
  ));
  const selectableFields = crossFilterFields.filter((field) => run.result!.columns.includes(field));
  const selectedForTile = activeCrossFilters.filter((filter) => filter.fromTileId === tile.i);
  const markActions = onMark ? [] : datasetMarkActions(selectableFields, hierarchyCandidates);
  const selectedMarkAction = markActions.find((action) => action.id === markActionId) ?? markActions[0];
  const onRowSelect = onMark && tile.query && !tile.query.detail
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
      const selection = datasetMarkSelectionForRow(selectableFields, row);
      if (selection) onSelectDatasetMark?.(selection.field, selection.values);
    }
    : undefined;
  return (
    <div ref={frameRef} className="live-component-preview" onClick={(event) => event.stopPropagation()}>
      <div ref={bodyRef} className="live-component-body">
        {chart === 'kpi' && tile.query && usesKpiCard(tile.query, tile.viz.style)
          ? <KpiCard result={shownResult} query={tile.query} style={tile.viz.style} label={tile.title ?? 'This KPI'} />
          : chart === 'pivot' && tile.query && !tile.query.detail
          ? <PivotTable result={shownResult} layout={pivotLayout(tile.viz.encoding ?? encodingFromQuery(tile.query, 'pivot'), tile.query)} themeMode={themeMode} conditionalFormats={tile.viz.style?.conditional} maxHeight={placed ? chartHeight : height} {...(onRowSelect ? { onCellClick: onRowSelect } : {})} />
          : chart === 'table' || chart === 'pivot'
          ? <TableOutput result={shownResult} themeMode={themeMode} maxHeight={placed ? chartHeight : height} initialPageSize={10} onRowClick={onRowSelect} conditionalFormats={tile.viz.style?.conditional} />
          : <ChartOutput result={shownResult} themeMode={themeMode} chartConfig={{ ...chartConfig, title: undefined }} availableHeight={chartHeight} availableWidth={width} onMarkSelect={onRowSelect} />}
      </div>
      {selectableFields.length ? <div className={`dataset-mark-controls marks ${selectedForTile.length ? 'has-selection' : ''}`} aria-label="Cross-filter selection">
        <span>Select a result mark</span>
        {selectableFields.flatMap((field) => uniquePreviewValues(run.result!.rows, field).slice(0, 6).map((value) => ({ field, value }))).map(({ field, value }) => <button key={`${field}:${String(value)}`} type="button" className={selectedForTile.some((filter) => filter.field === field && filter.values.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) ? 'on' : ''} onClick={() => onSelectDatasetMark?.(field, [value])}>{humanize(field)}: {String(value)}</button>)}
        <small>{chart === 'table' ? 'You can also click a table row.' : 'Values come from this settled result.'}</small>
      </div> : null}
      {hierarchy && (hierarchyCandidates.length > 0 || hierarchy.activeSteps.length > 0) ? <div className="dataset-mark-controls hierarchy" aria-label="Hierarchy exploration">
        <span>Explore hierarchy · unsaved</span>
        {markActions.length > 1 ? <label>Click action <select value={selectedMarkAction?.id ?? ''} onChange={(event) => setMarkActionId(event.target.value)}>
          {markActions.map((action) => <option key={action.id} value={action.id}>{action.kind === 'filter' ? 'Filter linked tiles' : `Drill to ${humanize(action.candidate.toField)}`}</option>)}
        </select></label> : null}
        {selectedMarkAction?.kind === 'drill' ? <small>{markActions.length > 1 ? 'Choose the drill action, then ' : ''}Click a {humanize(selectedMarkAction.candidate.fromField)} mark to drill to {humanize(selectedMarkAction.candidate.toField)}.</small> : null}
        {hierarchy.activeSteps.length > 0 ? <small>All › {hierarchy.activeSteps.map((step) => step.values.map(String).join(', ')).join(' › ')}</small> : null}
        {hierarchy.activeSteps.length > 0 && onDrillBack ? <button type="button" onClick={onDrillBack}>Up one level</button> : null}
      </div> : null}
      {!selectableFields.length && linkProposal && onLinkField ? <div className="dataset-link-hint" role="note">
        <span>{onMark ? 'Keep only reaches tiles on this Dataset.' : `Clicking this ${chart === 'table' ? 'table' : 'chart'} filters nothing yet.`}</span>
        <button type="button" onClick={onLinkField} title={`Map ${humanize(linkProposal.fieldLabel)} to: ${linkProposal.targetLabels.join(', ')}`}>{onMark ? 'Also filter' : 'Link'} {humanize(linkProposal.fieldLabel)} {onMark ? 'on' : 'to'} {linkProposal.mappings.length === 1 ? linkProposal.targetLabels[0] : `${linkProposal.mappings.length} Datasets`}</button>
      </div> : null}
      {hasNavigation ? <button type="button" className="dataset-detail-navigation" onClick={onNavigate}>Open details <ArrowRight size={13} /></button> : null}
    </div>
  );
}

function datasetCrossFilterFields(
  page: AppStudioBuildDraft['pages'][number],
  tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
): string[] {
  if (!tile.query) return [];
  const mapped = new Set((page.interactions?.crossFilter?.mappings ?? [])
    .filter((mapping) => mapping.fromTileId === tile.i)
    .map((mapping) => mapping.fromField));
  return tileQueryOutputAliases(tile.query)
    .filter((output) => output.kind === 'dimension' && mapped.has(output.alias))
    .map((output) => output.alias);
}

function uniquePreviewValues(rows: Array<Record<string, unknown>>, field: string): unknown[] {
  const values = new Map<string, unknown>();
  for (const row of rows) {
    const value = row[field];
    if (value === undefined || value === null || typeof value === 'object') continue;
    values.set(JSON.stringify(value), value);
  }
  return [...values.values()];
}

function restoreOperations(current: AppStudioBuildDraft, target: AppStudioBuildDraft): AppStudioDraftOperation[] {
  return [
    { type: 'set_name', name: target.name },
    { type: 'set_template', template: target.template },
    { type: 'set_frame', frame: target.frame },
    { type: 'set_source_policy', sourcePolicy: target.sourcePolicy },
    { type: 'set_requirements', requirements: target.requirements, coverage: target.coverage },
    ...current.sources.filter((source) => !target.sources.some((item) => item.id === source.id)).map((source): AppStudioDraftOperation => ({ type: 'remove_source', sourceId: source.id })),
    ...target.sources.map((source): AppStudioDraftOperation => ({ type: 'upsert_source', source })),
    ...current.pages.filter((page) => !target.pages.some((item) => item.id === page.id)).map((page): AppStudioDraftOperation => ({ type: 'remove_page', pageId: page.id })),
    ...target.pages.map((page): AppStudioDraftOperation => ({ type: 'upsert_page', page })),
    ...current.reviewTasks.filter((task) => !target.reviewTasks.some((item) => item.id === task.id)).map((task): AppStudioDraftOperation => ({ type: 'remove_review_task', taskId: task.id })),
    ...target.reviewTasks.map((task): AppStudioDraftOperation => ({ type: 'set_review_task', task })),
  ];
}

function studioTemplatePage(
  page: AppStudioBuildDraft['pages'][number],
  template: StudioTemplate,
  appName: string,
): AppStudioBuildDraft['pages'][number] {
  const contentItems = page.layout.items.filter((item) => !(item.i.startsWith('template-') && item.i.endsWith('-introduction')));
  if (template === 'blank') {
    return {
      ...page,
      sections: [],
      layout: { ...page.layout, items: packStudioItems(contentItems, 12) },
    };
  }
  const introId = `template-${template}-introduction`;
  const intro = {
    i: introId, x: 0, y: 0, w: 12, h: 2,
    title: template === 'investigation' ? 'Investigation question' : 'Executive context',
    sectionId: 'exec_summary',
    text: { markdown: template === 'executive_brief'
      ? `# ${appName}\n\nSummarize the decision and the governed evidence that supports it.`
      : template === 'operational_dashboard'
        ? `# ${appName}\n\nMonitor performance, changes, drivers, and the details that require action.`
        : `# ${appName}\n\nDocument the question, findings, caveats, and supporting evidence.` },
    viz: { type: 'text' },
    sourceClass: 'narrative' as const,
    trustState: 'draft_ready' as const,
    reviewStatus: 'draft_ready' as const,
  };
  const sections = template === 'investigation'
    ? [
      { id: 'exec_summary', title: 'Question', kind: 'exec_summary' as const, order: 0 },
      { id: 'insight', title: 'Findings and comparisons', kind: 'insight' as const, order: 1 },
      { id: 'appendix', title: 'Caveats and evidence', kind: 'appendix' as const, order: 2 },
    ]
    : [
      { id: 'exec_summary', title: 'Executive summary', kind: 'exec_summary' as const, order: 0 },
      { id: 'kpi_band', title: 'Key metrics', kind: 'kpi_band' as const, order: 1 },
      { id: 'insight', title: template === 'executive_brief' ? 'Decision evidence' : 'Trends and drivers', kind: 'insight' as const, order: 2 },
      { id: 'appendix', title: 'Detail and evidence', kind: 'appendix' as const, order: 3 },
    ];
  return {
    ...page,
    sections,
    layout: { ...page.layout, items: packStudioItems([intro, ...contentItems], 12) },
  };
}

function collapseTemplateIntroductions(
  items: AppStudioBuildDraft['pages'][number]['layout']['items'],
  activeTemplate?: StudioTemplate,
): AppStudioBuildDraft['pages'][number]['layout']['items'] {
  const introductionPrefix = 'template-';
  const introductionSuffix = '-introduction';
  const introductions = items.filter((item) => item.i.startsWith(introductionPrefix) && item.i.endsWith(introductionSuffix));
  if (introductions.length <= 1) return items;
  const preferredId = activeTemplate && activeTemplate !== 'blank' ? `template-${activeTemplate}-introduction` : undefined;
  const preferred = introductions.find((item) => item.i === preferredId) ?? introductions[introductions.length - 1];
  return items.filter((item) => !(item.i.startsWith(introductionPrefix) && item.i.endsWith(introductionSuffix)) || item.i === preferred.i);
}

function packStudioItems(items: AppStudioBuildDraft['pages'][number]['layout']['items'], columns: number): AppStudioBuildDraft['pages'][number]['layout']['items'] {
  const cols = Math.max(1, Math.floor(columns));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.y - right.item.y || left.item.x - right.item.x || left.index - right.index)
    .map(({ item }) => {
    const width = Math.min(cols, Math.max(1, item.w));
    const height = Math.max(1, item.h);
    if (x + width > cols) {
      x = 0;
      y += rowHeight || height;
      rowHeight = 0;
    }
    const packed = { ...item, x, y, w: width, h: height };
    x += width;
    rowHeight = Math.max(rowHeight, height);
    if (x >= cols) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    return packed;
  });
}

function recommendedComponentKind(source: AppBlockRecommendation): 'kpi' | 'chart' | 'table' {
  const view = normalizeViz(source.chartType);
  if (view === 'single_value') return 'kpi';
  if (view === 'table') return 'table';
  return 'chart';
}

/**
 * The App's domain as the server stored it on the draft's first page
 * (`createStoredAppBuildDraft`). `general` is the no-domain default, so it
 * returns undefined and lists stay unfiltered.
 */
export function appDraftDomain(draft: Pick<AppStudioBuildDraft, 'pages'> | null | undefined): string | undefined {
  const domain = draft?.pages[0]?.metadata.domain?.trim();
  return domain && domain.toLowerCase() !== 'general' ? domain : undefined;
}

/** One glossary: a Dataset has fields, Metrics come from a semantic model, a saved query is a plain block. */
function sourceCatalogKindLabel(source: AppBlockRecommendation): 'Dataset' | 'Metrics' | 'Saved query' {
  if (source.capabilities?.dataset?.kind === 'semantic') return 'Metrics';
  if (source.capabilities?.dataset) return 'Dataset';
  if (source.capabilities?.semanticModelId) return 'Metrics';
  return 'Saved query';
}

/** Visible trust uses two words only. */
function trustLabel(trust: string | undefined): 'Certified' | 'Needs review' {
  return trust === 'certified' ? 'Certified' : 'Needs review';
}

const CHART_TYPE_OPTIONS: Array<[AppStudioBuildDraft['pages'][number]['layout']['items'][number]['viz']['type'], string]> = [
  ['single_value', 'KPI'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'],
  ['table', 'Table'], ['pivot', 'Pivot'], ['scatter', 'Scatter'], ['heatmap', 'Heatmap'],
];

function chartTypeIcon(type: string): JSX.Element {
  if (type === 'single_value' || type === 'kpi') return <Gauge size={16} />;
  if (type === 'table' || type === 'pivot') return <Table2 size={16} />;
  if (type === 'line' || type === 'area') return <LineChart size={16} />;
  if (type === 'scatter' || type === 'heatmap') return <ScatterChart size={16} />;
  return <BarChart3 size={16} />;
}

/** Plain-language count of what applying a proposal does to one page. */
function proposalSummaryText(page: ProposedPage): { text: string; removed: number } {
  const count = (change: string) => page.items.filter((item) => item.change === change).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const added = count('added');
  const updated = count('updated');
  const removed = count('removed');
  const parts = [
    page.isNew ? 'new page' : '',
    added ? plural(added, 'new tile', 'new tiles') : '',
    updated ? plural(updated, 'changed tile', 'changed tiles') : '',
    page.linkedTileIds.size ? plural(page.linkedTileIds.size, 'new click link', 'new click links') : '',
    removed ? `replaces ${plural(removed, 'existing tile', 'existing tiles')}` : '',
  ].filter(Boolean);
  return { text: parts.length ? parts.join(', ') : 'no changes on this page', removed };
}

function tileKindLabel(tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]): string {
  if (tile.viz.type === 'heading') return 'HEADING';
  if (tile.text) return 'TEXT';
  if (tile.driver) return 'DRIVERS';
  const labels: Record<string, string> = { single_value: 'KPI', kpi: 'KPI', bar: 'BAR CHART', line: 'LINE CHART', area: 'AREA CHART', scatter: 'SCATTER', heatmap: 'HEATMAP', table: 'TABLE', pivot: 'PIVOT TABLE' };
  return labels[tile.viz.type] ?? humanize(tile.viz.type).toUpperCase();
}

function componentKindLabel(kind: 'kpi' | 'chart' | 'table'): 'KPI' | 'Chart' | 'Table' {
  return kind === 'kpi' ? 'KPI' : kind === 'table' ? 'Table' : 'Chart';
}

/** Source type in the App glossary; rows append the trust word (Certified or Needs review). */
function sourceKindLabel(
  kind: AppStudioBuildDraft['sources'][number]['kind'],
  capabilities?: AppStudioBuildDraft['sources'][number]['capabilities'],
): string {
  if (kind === 'text') return 'Page content';
  if (kind === 'review_dql') return 'Draft DQL';
  if (kind === 'exploratory_sql') return 'Draft SQL';
  if (kind === 'governed_semantic' || kind === 'semantic_query') return 'Metrics';
  if (capabilities?.dataset?.kind === 'semantic' || capabilities?.semanticModelId) return 'Metrics';
  if (capabilities?.dataset) return 'Dataset';
  return 'Saved query';
}

function isPresentationOnlyOperation(operation: AppStudioDraftOperation): boolean {
  if (operation.type === 'set_layout' || operation.type === 'set_narrative' || operation.type === 'set_canvas') return true;
  if (operation.type !== 'update_tile') return false;
  const allowed = new Set(['title', 'description', 'owner', 'viz', 'display', 'x', 'y', 'w', 'h', 'sectionId']);
  return Object.keys(operation.patch).every((key) => allowed.has(key));
}

function pageHasDataTiles(page: AppStudioBuildDraft['pages'][number]): boolean {
  return page.layout.items.some(isDataTile);
}

function isDataTile(item: AppStudioBuildDraft['pages'][number]['layout']['items'][number]): boolean {
  return Boolean(item.block || item.semantic || item.draftAnalysis || item.query || item.driver);
}

interface CanvasGesture {
  pageId: string;
  kind: 'move' | 'resize' | 'resize-e' | 'resize-s';
  pointerId: number;
  startX: number;
  startY: number;
  columnPx: number;
  rowStepPx: number;
  origin: AppStudioBuildDraft['pages'][number]['layout']['items'][number];
  base: AppStudioBuildDraft['pages'][number]['layout']['items'];
  items: AppStudioBuildDraft['pages'][number]['layout']['items'];
  moved: boolean;
  /** The pointer is up and the new layout is being saved. */
  committing: boolean;
}

function modifierKeyLabel(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
}

function unsupportedTileFilters(tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) {
  return (tile.filterBindings ?? []).filter((binding) => binding.capability === 'unsupported' || Boolean(binding.unsupportedReason));
}

function templateIcon(id: StudioTemplate): JSX.Element {
  if (id === 'executive_brief') return <FileText size={18} />;
  if (id === 'operational_dashboard') return <LayoutDashboard size={18} />;
  if (id === 'investigation') return <Search size={18} />;
  return <Plus size={18} />;
}

function normalizeViz(type?: string): 'bar' | 'line' | 'area' | 'table' | 'single_value' {
  const value = type?.toLowerCase() ?? '';
  if (value.includes('line') || value.includes('trend')) return 'line';
  if (value.includes('area')) return 'area';
  if (value.includes('table')) return 'table';
  if (value.includes('kpi') || value.includes('single')) return 'single_value';
  return 'bar';
}

function createAppStudioPreviewRunScope(): string {
  return `studio_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

