// Apps & dashboards — file format loaders and validators.
//
// `dql.app.json` and `.dqld` are the on-disk shapes. Compiled views
// (`ManifestApp`, `ManifestDashboard`) live in `manifest/types.ts`.

export { normalizeProductDomainContext } from './product-domain-context.js';
export type { ProductDomainContext } from './product-domain-context.js';

export {
  parseAppDocument,
  loadAppDocument,
  findAppDocuments,
  resolveRlsContext,
  memberAttributes,
  appFolderRelPath,
  suggestAppId,
} from './app-document.js';
export type {
  AppDocument,
  AppMember,
  AppRole,
  AppPolicy,
  AppRlsBinding,
  AppSchedule,
  AppScheduleDelivery,
  AppHomepage,
  AppVisibility,
  AppLifecycle,
  AppNotebookRef,
  AppDocumentParseError,
  AppDocumentLoadResult,
} from './app-document.js';

export { readDashboardVizStyle } from './viz-style.js';
export {
  clampGridBox,
  compactGridLayout,
  firstFreeGridCell,
  gridBoxesOverlap,
  moveGridItem,
  nudgeGridItem,
  placeGridCopy,
  resizeGridItem,
  settleGridLayout,
  MAX_TILE_ROWS,
} from './grid-layout.js';
export type { GridBox } from './grid-layout.js';
export type {
  DashboardVizStyle,
  DashboardVizReferenceLine,
  DashboardVizBand,
  DashboardVizAnnotation,
} from './viz-style.js';

export {
  parseDashboardDocument,
  loadDashboardDocument,
  findDashboardsForApp,
  findAllDashboards,
  isBlockIdRef,
  extractDashboardBlockRefs,
  dashboardDatasetParameterFilterErrors,
  readDriverDefinition,
  readDashboardNarrative,
  readDashboardCanvas,
  DASHBOARD_DRIVER_GRAINS,
  MAX_DRIVER_DIMENSIONS,
  MAX_DRIVER_FILTERS,
  DRIVER_ALL_DIMENSIONS,
  MAX_TILE_DESCRIPTION,
  MAX_TILE_OWNER,
} from './dashboard-document.js';

export {
  applyDatasetHierarchyDrill,
  datasetHierarchyFields,
  datasetTileVisualizationCompatibility,
  datasetQueryRequiresAggregateComponentEvidence,
  isTileTimeGrain,
  normalizeTileQuery,
  tileQueryIsTopNIntent,
  tileQueryOutputAliases,
  tileQueryValidationRuns,
  tileQueryHash,
  tileQueryMeasure,
  tileQueryMeasureScope,
  validateTileQuery,
} from './tile-query.js';
export { isPartialPeriod, readKpiStyle, summarizeKpi } from './kpi.js';
export type { DashboardKpiStyle, KpiPoint, KpiSummary } from './kpi.js';
export {
  MAX_PIVOT_COLUMNS,
  MAX_PIVOT_ROWS,
  PIVOT_TOTAL_FLAG,
  buildPivotGrid,
  pivotLayout,
  pivotRollups,
  pivotTotalFlag,
  pivotTotalsWithDefaults,
  withPivotRollups,
  withoutRollups,
} from './pivot.js';
export type { PivotGrid, PivotHeader, PivotLayout, PivotRow, PivotTotals } from './pivot.js';
export {
  CONDITIONAL_OP_SYMBOLS,
  CONDITIONAL_TONE_LABELS,
  MAX_CONDITIONAL_FORMATS,
  conditionalCell,
  conditionalStats,
  describeConditionalRule,
  readConditionalFormats,
} from './conditional-format.js';
export type { ConditionalCell, ConditionalRule, ConditionalRuleOp, ConditionalStats, ConditionalTone, DashboardConditionalFormat } from './conditional-format.js';
export {
  MAX_TILE_CALCULATIONS,
  QUICK_CALC_KINDS,
  QUICK_CALC_LABELS,
  checkTileCalculations,
  formatTileCalcExpr,
  measureCalcFacts,
  normalizeTileCalculations,
  parseTileFormula,
  quickCalcVerdict,
  tileCalcMeasureReferences,
  tileCalculationOutputs,
  uniqueCalculationId,
} from './tile-calcs.js';
export type {
  TileCalcCheck,
  TileCalcDiagnostic,
  TileCalcExpr,
  TileCalcFacts,
  TileCalcOutput,
  TileCalcUnit,
  TileCalculation,
  TileFormulaParse,
  TileQuickCalcKind,
} from './tile-calcs.js';
export type {
  DatasetTileVisualizationCompatibility,
  DatasetTileVisualizationIssueCode,
  TileFilterOperator,
  TileQuery,
  TileQueryComparison,
  TileQueryComparisonPeriod,
  TileQueryDiagnostic,
  TileQueryDimension,
  TileQueryFilter,
  TileQueryMeasure,
  TileQueryAdaptation,
  TileQueryValidation,
  TileQueryValidationOutcome,
  TileTimeGrain,
  DatasetHierarchyDrillResult,
} from './tile-query.js';

export {
  createAppBuildDraft,
  createBlankAppBuildPage,
  newAppBuildDraftId,
  applyAppBuildDraftOperations,
  appBuildDraftHash,
  appBuildPreviewIntentFingerprint,
  packDashboardLayoutItems,
} from './app-build-draft.js';
export { appSourceIdsUsedByTiles, appSourcesNotUsedByTiles } from './app-data-sources.js';
export type { AppDataSourceLike, AppDataTileLike, AppDataDraftLike } from './app-data-sources.js';
export type {
  AppBuildDraft,
  AppBuildFrame,
  AppBuildClarification,
  AppBuildRequirement,
  AppBuildRequirementCoverage,
  AppBuildRunReceipt,
  AppBuildPreflightReceipt,
  AppBuildAuthoringMode,
  AppBuildSourcePolicy,
  AppBuildTemplateId,
  AppBuildDraftSourceKind,
  AppBuildSourceLifecycle,
  AppBuildSourceCapabilities,
  AppBuildDraftSource,
  AppBuildReviewTask,
  AppBuildDraftOperation,
} from './app-build-draft.js';
export type {
  DashboardDocument,
  DashboardParam,
  DashboardFilter,
  DashboardDatasetFilterBinding,
  DashboardBlockRef,
  DashboardSemanticQueryRef,
  DashboardStoryEvidencePlan,
  DashboardStoryFact,
  DashboardStoryClaim,
  DashboardStoryBrief,
  DashboardVizConfig,
  DashboardDisplayMetadata,
  DashboardDisplayMode,
  DashboardDisplayComponent,
  DashboardDisplayLayoutIntent,
  DashboardDisplayTrustState,
  DashboardDisplayReviewStatus,
  DashboardTileFilterBinding,
  DashboardTileParameterBinding,
  DashboardTileSourceEvidence,
  DashboardGridItem,
  DashboardDriverDefinition,
  DashboardDriverGrain,
  DashboardNarrative,
  DashboardNarrativeBlock,
  DashboardCanvas,
  DashboardDatasetBinding,
  DashboardInteractions,
  DashboardCrossFilterMapping,
  DashboardDetailInteraction,
  DashboardNavigateInteraction,
  DashboardGridLayout,
  DashboardResponsiveLayouts,
  DashboardLoadResult,
  DashboardParseError,
  DashboardSection,
} from './dashboard-document.js';

export type { AppAnalyticalContextV1 } from './app-analytical-context.js';

export {
  buildStoryBindingCatalog,
  bindingCaption,
  figureLabel,
  validateStoryText,
  splitStoryText,
  storyBindingKeys,
  formatStoryValue,
  STORY_BINDING_PATTERN,
  MAX_STORY_TEXT,
  MAX_STORY_BLOCKS,
} from './story-bindings.js';
export type { StoryBinding, StoryBindingCatalog, StoryBindingTileInput, StoryTextIssue } from './story-bindings.js';
export { columnNameTokens, detectResultOrdering, isRankColumnName, nonMeasureColumnRole, resultLeaderRow, selectResultMeasures } from './result-measures.js';
export type { ColumnNameRole, ResultColumnContract, ResultMeasureInput, ResultMeasureSelection, ResultOrdering, ResultSourceHint } from './result-measures.js';

export { rankResultRows, compareResultMembers } from './result-ranking.js';
export type { RankedResultRow, RankResultRowsOptions } from './result-ranking.js';

export {
  checkCanvasHtml, fillCanvasHtml, escapeHtml, MAX_CANVAS_HTML, annotateCanvasHtml, canvasContainerPath, canvasNodeAt, canvasPieceKind,
  insertCanvasNodes, moveCanvasNode, parseCanvasHtml, rebindCanvasValue, removeCanvasNode, replaceCanvasNode, serializeCanvasNodes,
} from './canvas-page.js';
export type { CanvasIssue, CanvasNode, CanvasPath, CanvasPieceKind, CheckedCanvas } from './canvas-page.js';
export { READER_TRUST_LABELS, appTrustSummary, isDataTileForTrust, readerTileTrust, readerTrustCounts, readerTrustSummary } from './reader-trust.js';
export type { AppTrustState, AppTrustSummary, ReaderTrust, ReaderTrustItem, ReaderTrustState, ReaderTrustTile } from './reader-trust.js';
export { evaluateMonitors, readAppMonitors, MAX_MONITORS_PER_SCHEDULE } from './monitors.js';
export type { AppMonitor, AppMonitorCondition, MonitorEvaluation, MonitorPreviousValue, MonitorStatus } from './monitors.js';
export { diffDashboardPages, diffAppDeliveries, renderLayoutDiffSvg, NUMBER_ASPECTS } from './app-diff.js';
export type { PageDiff, PageAspect, TileAspect, TileBox, TileChange, TileChangeKind } from './app-diff.js';
export {
  SHELVES, SHELF_LABELS, addFieldByClick, chartFromEncoding, defaultShelfFor, encodingFromQuery, encodingHas, encodingQueryIssues,
  encodingChartColumns, fieldKey, isMeasureRef, outputAlias, placeOnShelf, queryFromEncoding, readDashboardVizEncoding, refName, removeField, removeFromShelf, shelfAccepts, shelfContents,
} from './viz-encoding.js';
export type { DashboardVizEncoding, EncodedChart, EncodedChartColumns, FieldFormatKind, ShelfFieldRef, ShelfFieldSettings, ShelfId } from './viz-encoding.js';
export {
  SHOW_ME_CHARTS, SHOW_ME_LABELS, SHOW_ME_MAX_SERIES, SHOW_ME_MAX_SLICES, applyShowMe, showMe, showMeFactsFromDescriptor, showMeFirstChoice,
  showMeInputFromEncoding, showMeInputFromQuery,
} from './show-me.js';
export type { ShowMeChart, ShowMeDimension, ShowMeFacts, ShowMeInput, ShowMeMeasure, ShowMeSuggestion, ShowMeVizType } from './show-me.js';
