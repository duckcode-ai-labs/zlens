import { checkCanvasHtml } from './canvas-page.js';
import { MAX_STORY_BLOCKS, validateStoryText } from './story-bindings.js';
/**
 * Dashboard documents — `apps/<app>/dashboards/<id>.dqld`.
 *
 * `.dqld` is JSON. A dashboard composes certified blocks (or notebook cells
 * bound to block files) into an explicit grid layout with params, filters,
 * and a viz config per item. Distinct from `.dqlnb` notebooks, which are a
 * linear cell sequence.
 *
 * The reference shape allows two forms:
 * - by-id  : `{ "blockId": "revenue_total" }` — resolved at compile time
 *            against the manifest's blocks map.
 * - by-path: `{ "ref": "blocks/revenue_total.dql" }` — resolved against the
 *            block scanner's path-to-name map.
 *
 * Either form may also pin a git SHA (`"version": "git:abc123"`).
 */

import { readDashboardVizStyle, type DashboardVizStyle } from './viz-style.js';
import { encodingQueryIssues, readDashboardVizEncoding, type DashboardVizEncoding } from './viz-encoding.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import {
  datasetTileVisualizationCompatibility,
  normalizeTileQuery,
  tileQueryOutputAliases,
  type TileQuery,
} from './tile-query.js';
import {
  normalizeSemanticTileConversionProvenance,
  type SemanticTileConversionProvenanceV1,
} from '../datasets/provenance.js';

export type DashboardParam = {
  id: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'daterange';
  default?: unknown;
  description?: string;
};

/**
 * A field mapping is source-qualified by Dataset. `tileIds` is an optional
 * explicit include list for field-query components that share that Dataset.
 * Its absence preserves v3's original all-bound-tiles behavior; a present
 * empty list deliberately excludes every matching component.
 */
export type DashboardDatasetFilterBinding = {
  field: string;
  tileIds?: string[];
};

export type DashboardFilter = {
  id: string;
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'date'
    | 'daterange'
    | 'relative_date'
    | 'select'
    | 'multiselect'
    | 'search'
    | 'number_range';
  label?: string;
  default?: unknown;
  /** For 'select': allowed values. */
  options?: string[];
  /** Optional dimension reference the filter binds to. */
  bindsTo?: string;
  /** Qualified identity; display names alone are never sufficient binding proof. */
  field?: {
    name: string;
    relation?: string;
    semanticModel?: string;
    provider?: string;
  };
  required?: boolean;
  multiple?: boolean;
  /** IANA zone used when a date-only control bounds a timestamp field. */
  timezone?: string;
  /** `app` persists a field-bound filter through page navigation in a v3 App. */
  scope?: { app?: boolean; page?: string; tileIds?: string[] };
  /** Explicit dataset binding. Fields never bind across sources by name alone. */
  datasetBindings?: Record<string, DashboardDatasetFilterBinding>;
  optionSource?: {
    mode: 'static' | 'distinct_query';
    sourceRef?: string;
    field?: string;
    snapshotId?: string;
    limit?: number;
  };
  dependsOn?: string[];
};

export type DashboardBlockRef =
  | { blockId: string; version?: string }
  | { ref: string; version?: string };

export type DashboardVizConfig = {
  /** Chart kind. The renderer picks the matching @zlens/charts component. */
  type:
    | 'single_value'
    | 'grouped_bar'
    | 'stacked_bar'
    | 'line'
    | 'bar'
    | 'area'
    | 'pie'
    | 'donut'
    | 'scatter'
    | 'heatmap'
    | 'histogram'
    | 'waterfall'
    | 'gauge'
    | 'table'
    | 'pivot'
    | 'map'
    | 'funnel'
    | 'sankey'
    | 'kpi'
    | 'text'
    | 'heading';
  /** Free-form per-renderer options (axes, colors, etc.). */
  options?: Record<string, unknown>;
  /** Typed chart styling shared by the Studio style panel and App AI (RFC 0008). */
  style?: DashboardVizStyle;
  /** Shelves a Dataset tile is built from (RFC 0009 step 1); the query follows them. */
  encoding?: DashboardVizEncoding;
};

export type DashboardDisplayMode = 'manual' | 'ai_generated' | 'block_hint';
export type DashboardDisplayComponent =
  | 'BusinessBrief'
  | 'KpiMetric'
  | 'TrendPanel'
  | 'RankingPanel'
  | 'EvidenceTable'
  | 'PivotTable'
  | 'TrustCallout'
  | 'NarrativePanel'
  | 'ResearchActions';
export type DashboardDisplayLayoutIntent = 'auto' | 'compact' | 'standard' | 'wide' | 'tall' | 'full';
export type DashboardDisplayTrustState = 'certified' | 'review_required' | 'draft_ready';
export type DashboardDisplayReviewStatus = 'certified' | 'draft_ready' | 'review_required';

export type DashboardDisplayMetadata = {
  /** Presentation source. The block remains the data contract; this is consumer-level UI metadata. */
  mode: DashboardDisplayMode;
  component: DashboardDisplayComponent;
  defaultVisualization: DashboardVizConfig['type'];
  allowedVisualizations: DashboardVizConfig['type'][];
  fieldHints?: Record<string, string>;
  layoutIntent: DashboardDisplayLayoutIntent;
  rationale: string;
  trustState: DashboardDisplayTrustState;
  reviewStatus: DashboardDisplayReviewStatus;
};

export type DashboardTileFilterBinding = {
  /** Dashboard/app filter id such as `period`, `region`, or `season`. */
  filter: string;
  /** Physical column/expression or semantic field this filter can bind to. */
  binding?: string;
  /** Whether this becomes a block parameter or an outer predicate at execution time. */
  mode?: 'parameter' | 'predicate' | 'semantic';
  /** Block parameter names controlled by this app filter. */
  paramNames?: string[];
  /** If true, the tile should warn when the filter is missing. */
  required?: boolean;
  /** Populated when a global filter intentionally does not apply to this tile. */
  unsupportedReason?: string;
  /** Explicit capability prevents a global filter from appearing silently partial. */
  capability?: 'supported' | 'unsupported' | 'preflight_required';
};

export type DashboardTileParameterBinding = {
  /** Block parameter name. */
  param: string;
  /** Where the parameter value comes from on the consumption surface. */
  source: 'dashboard_filter' | 'constant' | 'persona' | 'variable';
  filter?: string;
  field?: string;
  value?: unknown;
  /** Typed block contract metadata used to render the correct consumer control. */
  parameterType?: 'string' | 'number' | 'boolean' | 'date' | 'string[]' | 'number[]' | 'date[]';
  required?: boolean;
  default?: unknown;
  policy?: 'dynamic' | 'static' | 'business' | 'derived' | 'optional' | 'ambiguous_review_required';
};

export type DashboardTileSourceEvidence = {
  source: string;
  reason: string;
  kind?: string;
  nodeId?: string;
  path?: string;
  trustState?: DashboardDisplayTrustState;
};

export type DashboardTextTile = {
  markdown: string;
};

export type DashboardAiPinRef = {
  id: string;
};

/** Git-owned, review-required App analysis. SQL lives in the referenced DQL
 * draft, never inline in the dashboard document. */
export type DashboardDraftAnalysisRef = {
  ref: string;
  artifactFingerprint: string;
  snapshotId?: string;
  executionReceiptId?: string;
};

export type DashboardTileSourceClass =
  | 'certified_block'
  | 'governed_semantic'
  | 'exploratory_analysis'
  | 'narrative';

export type DashboardTileReview = {
  status: 'not_required' | 'required' | 'approved';
  sourceFingerprint?: string;
  preflightReceiptId?: string;
  reviewedAt?: string;
  reviewedBy?: string;
};

/** Canonical governed semantic query. This stores intent and reviewed semantic
 * references, never copied/generated SQL. The runtime compiles it against the
 * active snapshot before every execution. */
export type DashboardSemanticQueryRef = {
  id: string;
  provider: 'metricflow' | 'native';
  metrics: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; operator: string; value: unknown }>;
  timeDimension?: string;
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  semanticModelRefs: string[];
  /** Qualified snapshot identities; names above remain the v1 execution projection. */
  qualifiedMetricIds?: string[];
  qualifiedModelIds?: string[];
  resolvedPlanFingerprint?: string;
  definitionFingerprint: string;
  snapshotId?: string;
};

export type DashboardStoryEvidencePlan = {
  version: 1;
  goal: string;
  audience?: string;
  /** Tile ids eligible to contribute facts. Empty means every governed data tile. */
  eligibleTileIds?: string[];
  /** Tile ids whose verified results may support driver language. */
  driverTileIds?: string[];
  /** Preferred business terms to retain in the story. */
  vocabulary?: string[];
};

export type DashboardStoryFact = {
  id: string;
  tileId: string;
  kind: 'value' | 'rank' | 'share' | 'delta' | 'trend' | 'driver' | 'scope' | 'freshness';
  label: string;
  value: string | number | boolean | null;
  unit?: string;
  comparison?: { baseline: string | number; delta?: string | number };
  grain?: string;
  filters?: Record<string, unknown>;
  evidenceRef: string;
  trustState: DashboardDisplayTrustState;
};

export type DashboardStoryClaim = {
  text: string;
  factIds: string[];
  kind: 'observation' | 'comparison' | 'driver' | 'implication' | 'caveat';
};

export type DashboardStoryBrief = {
  headline: string;
  paragraphs: string[];
  implication?: string;
  caveat?: string;
  claims: DashboardStoryClaim[];
  evidenceRefs: string[];
  trustState: DashboardDisplayTrustState;
  generatedBy: 'deterministic' | 'ai';
};

/** Snapshot-bound source aliases used by v3 field-based tiles. */
export type DashboardDatasetBinding = {
  id: string;
  sourceId: string;
  sourceRevision: string;
  snapshotId: string;
  contractFingerprint: string;
};

export type DashboardCrossFilterMapping = {
  /** A cross-filter must identify the exact Dataset tile that emitted it. */
  fromTileId: string;
  fromField: string;
  toDataset: string;
  toField: string;
};

export type DashboardDetailInteraction = {
  dataset: string;
  columns: string[];
};

export type DashboardNavigateInteraction = {
  fromTile: string;
  toPage: string;
  carryFilters: string[];
};

/** Declarative interactions are validated once, then interpreted by the App runtime. */
export type DashboardInteractions = {
  crossFilter?: { enabled?: boolean; mappings: DashboardCrossFilterMapping[] };
  detail?: DashboardDetailInteraction;
  navigate?: DashboardNavigateInteraction[];
};

/**
 * "Why did it move?" (RFC 0008 step 7): explain one period's change in a
 * Dataset measure against the period before it, member by member, for a few
 * dimensions. Every number comes from governed Dataset comparison queries;
 * the split is arithmetic, not AI.
 */
export interface DashboardDriverDefinition {
  version: 1;
  /** Approved Dataset measure field. */
  measure: string;
  /** Approved Dataset time field. */
  timeField: string;
  grain: DashboardDriverGrain;
  /** A local calendar date (YYYY-MM-DD) inside the period being explained. */
  anchor: string;
  comparison: 'previous_period' | 'previous_year';
  /**
   * Approved dimension fields to break the change down by, most useful
   * first. `["*"]` lets the runtime use the Dataset's approved dimensions.
   */
  dimensions: string[];
  /** IANA zone for period boundaries; UTC when absent. */
  timezone?: string;
  /**
   * What the reader is looking at when they ask: their selections, drills
   * and the clicked mark, as filters on approved fields. Both periods are
   * filtered the same way, so the explanation describes the numbers on
   * screen. The runtime validates them like any tile filter.
   */
  filters?: Array<{ field: string; op: 'eq' | 'neq' | 'in' | 'not_in'; values: Array<string | number | boolean> }>;
}

/** At most this many filters narrow one explanation. */
export const MAX_DRIVER_FILTERS = 12;

export type DashboardNarrativeBlock =
  | { id: string; kind: 'text'; markdown: string }
  | { id: string; kind: 'tile'; tileId: string };

export interface DashboardNarrative {
  version: 1;
  /** `story` shows the blocks, `canvas` the governed HTML page, `dashboard` the grid. */
  presentation: 'story' | 'dashboard' | 'canvas';
  blocks: DashboardNarrativeBlock[];
  /** Who wrote the current text. AI text is still checked like any other. */
  generatedBy?: 'author' | 'ai' | 'deterministic';
  model?: string;
}

export interface DashboardCanvas {
  version: 1;
  /** Canonical, checked markup. */
  html: string;
  generatedBy?: 'author' | 'ai' | 'deterministic';
  model?: string;
}

export type DashboardDriverGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';
export const DASHBOARD_DRIVER_GRAINS: readonly DashboardDriverGrain[] = ['day', 'week', 'month', 'quarter', 'year'];
export const MAX_DRIVER_DIMENSIONS = 6;
/** Use every approved dimension of the Dataset (up to the maximum). */
export const DRIVER_ALL_DIMENSIONS = '*';

export type DashboardGridItem = {
  /** Stable layout id — used by the grid editor for positioning persistence. */
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * What the tile shows and how to read it, in markdown. Readers see it under
   * the title (RFC 0008 step 6).
   */
  description?: string;
  /** Who answers for this tile's numbers, as a name or team. */
  owner?: string;
  /** A driver tile over this item's Dataset (`sourceId`). */
  driver?: DashboardDriverDefinition;
  /**
   * Canonical AppBuildDraft source binding. App Studio v3 writes this for
   * every data tile; legacy published dashboards remain readable without it.
   */
  sourceId?: string;
  /** Snapshot-bound source revision selected by App Studio. */
  sourceRevision?: string;
  /** Certified/shared block source. Existing dashboards use this shape. */
  block?: DashboardBlockRef;
  /** Local narrative/section text tile. */
  text?: DashboardTextTile;
  /** Local AI-generated answer pin stored in .dql/local/apps.sqlite. */
  aiPin?: DashboardAiPinRef;
  /** Governed semantic query compiled against the current snapshot. */
  semantic?: DashboardSemanticQueryRef;
  /** Durable lineage from one explicit legacy semantic-to-Dataset conversion. */
  semanticTileConversionProvenance?: SemanticTileConversionProvenanceV1;
  /** Explicitly accepted, app-scoped exploratory DQL draft. */
  draftAnalysis?: DashboardDraftAnalysisRef;
  /** Declarative field-based query over exactly one selected Dataset. */
  query?: TileQuery;
  viz: DashboardVizConfig;
  /** Governed GenUI/display contract for this specific App or notebook tile. */
  display?: DashboardDisplayMetadata;
  /** App-level filter compatibility and binding metadata for this tile. */
  filterBindings?: DashboardTileFilterBinding[];
  /** Runtime parameter binding metadata for this tile. */
  parameterBindings?: DashboardTileParameterBinding[];
  /** Evidence used by AI/App Builder to choose this tile and presentation. */
  sourceEvidence?: DashboardTileSourceEvidence[];
  sourceClass?: DashboardTileSourceClass;
  review?: DashboardTileReview;
  /** Denormalized trust marker for stakeholder and source-control surfaces. */
  trustState?: DashboardDisplayTrustState;
  /** Denormalized review marker for stakeholder and source-control surfaces. */
  reviewStatus?: DashboardDisplayReviewStatus;
  /** Optional human-readable title shown in the tile header. */
  title?: string;
  /** Story layout: which dashboard section this tile belongs to (optional, additive). */
  sectionId?: string;
};

/**
 * Story-layout section (optional, additive): groups tiles into a narrated flow —
 * executive summary → KPI band → per-question insights → review appendix.
 * Dashboards without sections render as the classic grid.
 */
export type DashboardSection = {
  id: string;
  title: string;
  kind: 'exec_summary' | 'kpi_band' | 'insight' | 'appendix';
  /** Narrated intro for the section (real numbers from executed results). */
  narrative?: string;
  order: number;
};

export type DashboardGridLayout = {
  kind: 'grid';
  cols: number;
  rowHeight: number;
  items: DashboardGridItem[];
};

export type DashboardResponsiveLayouts = {
  /** Canonical authoring geometry. Existing v1 layout is treated as `wide`. */
  wide?: DashboardGridLayout;
  medium?: DashboardGridLayout;
  narrow?: DashboardGridLayout;
};

export interface DashboardDocument {
  version: 1 | 2 | 3;
  id: string;
  metadata: {
    title: string;
    description?: string;
    domain?: string;
    subdomain?: string;
    groups?: string[];
    audience?: string;
    visibility?: 'shared' | 'private' | 'template';
    lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
    tags?: string[];
    businessOutcome?: string;
    businessOwner?: string;
    decisionUse?: string;
    reviewCadence?: string;
    businessRules?: string[];
    caveats?: string[];
    /**
     * The author added the auto-written Summary to this page (D6). Off unless
     * set: readers never get the Summary on a page whose author did not add it.
     */
    summary?: boolean;
  };
  params?: DashboardParam[];
  filters?: DashboardFilter[];
  /** v3 only: source identity is fixed while field selection remains editable. */
  datasets?: DashboardDatasetBinding[];
  interactions?: DashboardInteractions;
  /** Story layout sections (optional). Old dashboards simply have none. */
  sections?: DashboardSection[];
  /** Runtime story evidence contract. Result-specific prose is never persisted. */
  story?: DashboardStoryEvidencePlan;
  /**
   * Story layout (RFC 0008 step 8): the page read as prose with embedded
   * tiles. Every number in the text is a `{{binding}}` to a tile result.
   */
  narrative?: DashboardNarrative;
  /**
   * Governed HTML page (RFC 0008 step 9): checked markup whose data comes
   * only from <dql-value bind> and <dql-tile tile>. Shown when the
   * narrative's presentation is `canvas`.
   */
  canvas?: DashboardCanvas;
  layout: DashboardGridLayout & { responsive?: DashboardResponsiveLayouts };
}

export interface DashboardParseError {
  path: string;
  message: string;
}

export interface DashboardLoadResult {
  document: DashboardDocument | null;
  errors: DashboardParseError[];
}

export function parseDashboardDocument(text: string, path = '<dashboard.dqld>'): DashboardLoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      document: null,
      errors: [{ path, message: `invalid JSON: ${(err as Error).message}` }],
    };
  }
  return validateDashboardDocument(raw, path);
}

export function loadDashboardDocument(filePath: string): DashboardLoadResult {
  if (!existsSync(filePath)) {
    return { document: null, errors: [{ path: filePath, message: 'file not found' }] };
  }
  const text = readFileSync(filePath, 'utf-8');
  return parseDashboardDocument(text, filePath);
}

/** Return the absolute paths of every `.dqld` file under `<appDir>/dashboards/`. */
export function findDashboardsForApp(appDir: string): string[] {
  const dashboardsDir = join(appDir, 'dashboards');
  if (!existsSync(dashboardsDir)) return [];
  return scanDashboardsRecursive(dashboardsDir);
}

/** Return the absolute paths of every `.dqld` file under any `apps/<id>/dashboards/`. */
export function findAllDashboards(projectRoot: string): string[] {
  const appsDir = join(projectRoot, 'apps');
  if (!existsSync(appsDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    out.push(...findDashboardsForApp(join(appsDir, entry.name)));
  }
  return out.sort();
}

function scanDashboardsRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      out.push(...scanDashboardsRecursive(p));
    } else if (entry.isFile() && extname(entry.name) === '.dqld') {
      out.push(p);
    }
  }
  return out;
}

/** True when the layout item references a block by id (vs by path). */
export function isBlockIdRef(ref: DashboardBlockRef): ref is { blockId: string; version?: string } {
  return typeof (ref as { blockId?: unknown }).blockId === 'string';
}

/** Extract every block name/id referenced from a dashboard, regardless of ref form. */
export function extractDashboardBlockRefs(doc: DashboardDocument): {
  byId: string[];
  byPath: string[];
} {
  const byId: string[] = [];
  const byPath: string[] = [];
  for (const item of doc.layout.items) {
    if (!item.block) continue;
    if (isBlockIdRef(item.block)) byId.push(item.block.blockId);
    else byPath.push(item.block.ref);
  }
  return { byId, byPath };
}

// ---- Validation ----

function validateDashboardDocument(raw: unknown, path: string): DashboardLoadResult {
  const errors: DashboardParseError[] = [];
  const err = (msg: string) => errors.push({ path, message: msg });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('expected a JSON object at the top level');
    return { document: null, errors };
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.version ?? 1;
  if (version !== 1 && version !== 2 && version !== 3) err(`unsupported version ${String(version)} (expected 1, 2, or 3)`);

  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    err('id must be a non-empty string');
    return { document: null, errors };
  }
  const id = obj.id;

  const metadata = readMetadata(obj.metadata, err);
  const params = readParams(obj.params, err);
  const filters = readFilters(obj.filters, err);
  const datasets = readDatasets(obj.datasets, err);
  const interactions = readInteractions(obj.interactions, err);
  const sections = readSections(obj.sections, err);
  const story = readStoryEvidencePlan(obj.story, err);
  const layout = readLayout(obj.layout, err);
  const narrative = obj.narrative === undefined ? undefined : readDashboardNarrative(obj.narrative, new Set(layout.items.map((item) => item.i)), err);
  const canvas = obj.canvas === undefined ? undefined : readDashboardCanvas(obj.canvas, new Set(layout.items.map((item) => item.i)), err);

  if (version === 3) {
    validateDashboardV3References(datasets, filters, interactions, layout, err);
    for (const message of dashboardDatasetParameterFilterErrors({
      version: 3,
      params,
      filters,
      datasets,
      layout,
    })) err(message);
  } else {
    validateDashboardLegacyCompatibility(obj, datasets, filters, interactions, layout, err);
  }

  if (errors.length > 0) {
    return { document: null, errors };
  }

  return {
    document: {
      version: version as 1 | 2 | 3,
      id,
      metadata,
      params: params.length > 0 ? params : undefined,
      filters: filters.length > 0 ? filters : undefined,
      ...(datasets.length > 0 ? { datasets } : {}),
      ...(interactions ? { interactions } : {}),
      sections: sections.length > 0 ? sections : undefined,
      ...(story ? { story } : {}),
      ...(narrative ? { narrative } : {}),
      ...(canvas ? { canvas } : {}),
      layout,
    },
    errors: [],
  };
}

/**
 * Field-based Datasets were introduced with the v3 document contract.  Keep
 * older dashboards readable, including their page navigation, but reject a
 * v3 Dataset declaration grafted onto a v1/v2 document before it reaches a
 * compiler or execution surface that cannot bind its governance contract.
 */
function validateDashboardLegacyCompatibility(
  raw: Record<string, unknown>,
  datasets: DashboardDatasetBinding[],
  filters: DashboardFilter[],
  interactions: DashboardInteractions | undefined,
  layout: DashboardDocument['layout'],
  err: (m: string) => void,
): void {
  if (raw.datasets !== undefined || datasets.length > 0) {
    err('datasets require dashboard version 3');
  }
  for (const filter of filters) {
    if (filter.datasetBindings && Object.keys(filter.datasetBindings).length > 0) {
      err(`filters.${filter.id}.datasetBindings require dashboard version 3`);
    }
  }
  for (const item of layout.items) {
    if (item.query) err(`layout.items.${item.i}.query requires dashboard version 3`);
  }
  if (interactions?.crossFilter) err('interactions.crossFilter requires dashboard version 3');
  if (interactions?.detail) err('interactions.detail requires dashboard version 3');
}

function validateDashboardV3References(
  datasets: DashboardDatasetBinding[],
  filters: DashboardFilter[],
  interactions: DashboardInteractions | undefined,
  layout: DashboardDocument['layout'],
  err: (m: string) => void,
): void {
  const bySourceId = new Map(datasets.map((dataset) => [dataset.sourceId, dataset]));
  const byDatasetId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const byTileId = new Map(layout.items.map((item) => [item.i, item]));
  for (const item of layout.items) {
    if (!item.query) continue;
    const visualization = datasetTileVisualizationCompatibility(item.query, item.viz.type);
    if (!visualization.compatible) {
      err(`layout.items.${item.i}.viz ${visualization.message}`);
    }
    const dataset = item.sourceId ? bySourceId.get(item.sourceId) : undefined;
    if (!dataset) {
      err(`layout.items.${item.i}.query sourceId does not match a declared dataset`);
      continue;
    }
    if (item.sourceRevision !== dataset.sourceRevision) {
      err(`layout.items.${item.i}.query sourceRevision does not match its declared dataset`);
    }
  }
  for (const filter of filters) {
    for (const [datasetId, binding] of Object.entries(filter.datasetBindings ?? {})) {
      const dataset = byDatasetId.get(datasetId);
      if (!dataset) {
        err(`filters.${filter.id}.datasetBindings references unknown dataset ${datasetId}`);
        continue;
      }
      if (binding.tileIds === undefined) continue;
      const seenTileIds = new Set<string>();
      for (const tileId of binding.tileIds) {
        if (!tileId.trim() || seenTileIds.has(tileId)) {
          err(`filters.${filter.id}.datasetBindings.${datasetId}.tileIds must contain unique non-empty tile ids`);
          continue;
        }
        seenTileIds.add(tileId);
        const tile = byTileId.get(tileId);
        if (!tile) {
          err(`filters.${filter.id}.datasetBindings.${datasetId}.tileIds references unknown tile ${tileId}`);
          continue;
        }
        // A driver tile runs comparison queries on its source's Dataset, so it
        // follows that Dataset's filters like a field query does.
        if (!(tile.query || tile.driver) || tile.sourceId !== dataset.sourceId || tile.sourceRevision !== dataset.sourceRevision) {
          err(`filters.${filter.id}.datasetBindings.${datasetId}.tileIds tile ${tileId} does not resolve to that exact Dataset binding`);
        }
      }
    }
  }
  for (const mapping of interactions?.crossFilter?.mappings ?? []) {
    if (!byDatasetId.has(mapping.toDataset)) err(`interactions.crossFilter references unknown target dataset ${mapping.toDataset}`);
    const sourceItem = layout.items.find((item) => item.i === mapping.fromTileId);
    if (!sourceItem) {
      err(`interactions.crossFilter references unknown source tile ${mapping.fromTileId}`);
      continue;
    }
    if (!sourceItem.query || !sourceItem.sourceId || !sourceItem.sourceRevision) {
      err(`interactions.crossFilter source tile ${mapping.fromTileId} must be a field-based Dataset tile with an exact source binding`);
      continue;
    }
    const sourceDataset = bySourceId.get(sourceItem.sourceId);
    if (!sourceDataset || sourceDataset.sourceRevision !== sourceItem.sourceRevision) {
      err(`interactions.crossFilter source tile ${mapping.fromTileId} does not resolve to its declared Dataset source`);
      continue;
    }
    if (!tileQueryOutputAliases(sourceItem.query).some((output) => output.alias === mapping.fromField)) {
      err(`interactions.crossFilter source field ${mapping.fromField} is not a selected output of tile ${mapping.fromTileId}`);
    }
  }
  if (interactions?.detail && !byDatasetId.has(interactions.detail.dataset)) {
    err(`interactions.detail references unknown dataset ${interactions.detail.dataset}`);
  }
}

/**
 * Dataset field filters own their filter IDs at runtime. Reusing one as a
 * dashboard parameter would make the same request value both a governed
 * predicate and a source parameter. Require authors to use an explicitly
 * named tile parameter binding instead, so the source invocation remains
 * distinguishable from the field-filter contract.
 *
 * This is deliberately v3-only: older dashboards retain their historic
 * parameter/filter behavior because they have no Dataset field-query path.
 */
export function dashboardDatasetParameterFilterErrors(
  dashboard: Pick<DashboardDocument, 'version' | 'params' | 'filters' | 'datasets' | 'layout'>,
): string[] {
  if (dashboard.version !== 3) return [];
  const parameterIds = new Set((dashboard.params ?? []).map((parameter) => parameter.id));
  return (dashboard.filters ?? []).flatMap((filter) => {
    const hasDatasetFieldBinding = Boolean(filter.datasetBindings && Object.keys(filter.datasetBindings).length > 0);
    if (!hasDatasetFieldBinding || !parameterIds.has(filter.id)) return [];
    return [`params.${filter.id} conflicts with filters.${filter.id}: Dataset field filters require a distinct dashboard parameter id; bind source input through an explicit, separately named tile parameter.`];
  });
}

function readStoryEvidencePlan(raw: unknown, err: (m: string) => void): DashboardStoryEvidencePlan | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('story must be an object when present');
    return undefined;
  }
  const story = raw as Record<string, unknown>;
  if (story.version !== 1) err('story.version must be 1');
  if (typeof story.goal !== 'string' || !story.goal.trim()) {
    err('story.goal must be a non-empty string');
    return undefined;
  }
  return {
    version: 1,
    goal: story.goal,
    audience: typeof story.audience === 'string' ? story.audience : undefined,
    eligibleTileIds: stringArrayOrUndefined(story.eligibleTileIds, 'story.eligibleTileIds', err),
    driverTileIds: stringArrayOrUndefined(story.driverTileIds, 'story.driverTileIds', err),
    vocabulary: stringArrayOrUndefined(story.vocabulary, 'story.vocabulary', err),
  };
}

/** Story sections are optional and additive — absent/invalid entries are skipped
 *  (a malformed section must never brick an otherwise valid dashboard). */
function readSections(raw: unknown, err: (m: string) => void): DashboardSection[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('sections must be an array when present');
    return [];
  }
  const kinds = ['exec_summary', 'kpi_band', 'insight', 'appendix'] as const;
  const sections: DashboardSection[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return;
    const section = entry as Record<string, unknown>;
    if (typeof section.id !== 'string' || section.id.length === 0) return;
    if (typeof section.title !== 'string') return;
    if (typeof section.kind !== 'string' || !kinds.includes(section.kind as typeof kinds[number])) return;
    sections.push({
      id: section.id,
      title: section.title,
      kind: section.kind as DashboardSection['kind'],
      narrative: typeof section.narrative === 'string' ? section.narrative : undefined,
      order: typeof section.order === 'number' ? section.order : index,
    });
  });
  return sections;
}

function readMetadata(raw: unknown, err: (m: string) => void): DashboardDocument['metadata'] {
  if (typeof raw !== 'object' || raw === null) {
    err('metadata must be an object');
    return { title: 'Untitled' };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== 'string' || o.title.length === 0) {
    err('metadata.title must be a non-empty string');
    return { title: 'Untitled' };
  }
  const tags = o.tags;
  let tagsTyped: string[] | undefined;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((x) => typeof x === 'string')) {
      err('metadata.tags must be an array of strings');
    } else {
      tagsTyped = tags as string[];
    }
  }
  return {
    title: o.title,
    description: typeof o.description === 'string' ? o.description : undefined,
    domain: typeof o.domain === 'string' ? o.domain : undefined,
    subdomain: typeof o.subdomain === 'string' ? o.subdomain : undefined,
    groups: stringArrayOrUndefined(o.groups, 'metadata.groups', err),
    audience: typeof o.audience === 'string' ? o.audience : undefined,
    visibility: enumOrUndefined(o.visibility, 'metadata.visibility', ['shared', 'private', 'template'] as const, err),
    lifecycle: enumOrUndefined(o.lifecycle, 'metadata.lifecycle', ['draft', 'review', 'certified', 'deprecated'] as const, err),
    tags: tagsTyped,
    businessOutcome: typeof o.businessOutcome === 'string' ? o.businessOutcome : undefined,
    businessOwner: typeof o.businessOwner === 'string' ? o.businessOwner : undefined,
    decisionUse: typeof o.decisionUse === 'string' ? o.decisionUse : undefined,
    reviewCadence: typeof o.reviewCadence === 'string' ? o.reviewCadence : undefined,
    businessRules: stringArrayOrUndefined(o.businessRules, 'metadata.businessRules', err),
    caveats: stringArrayOrUndefined(o.caveats, 'metadata.caveats', err),
    ...(o.summary === true ? { summary: true } : {}),
  };
}

function stringArrayOrUndefined(raw: unknown, field: string, err: (m: string) => void): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
    err(`${field} must be an array of strings`);
    return undefined;
  }
  return raw as string[];
}

function readParams(raw: unknown, err: (m: string) => void): DashboardParam[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('params must be an array');
    return [];
  }
  const allowed = ['string', 'number', 'boolean', 'date', 'daterange'] as const;
  const out: DashboardParam[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as Record<string, unknown>;
    if (typeof p?.id !== 'string' || typeof p?.type !== 'string'
      || !allowed.includes(p.type as typeof allowed[number])) {
      err(`params[${i}] must have string id and type in ${allowed.join('|')}`);
      continue;
    }
    out.push({
      id: p.id,
      type: p.type as DashboardParam['type'],
      default: p.default,
      description: typeof p.description === 'string' ? p.description : undefined,
    });
  }
  return out;
}

function readFilters(raw: unknown, err: (m: string) => void): DashboardFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('filters must be an array');
    return [];
  }
  const allowed = ['string', 'number', 'boolean', 'date', 'daterange', 'relative_date', 'select', 'multiselect', 'search', 'number_range'] as const;
  const out: DashboardFilter[] = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i] as Record<string, unknown>;
    if (typeof f?.id !== 'string' || typeof f?.type !== 'string'
      || !allowed.includes(f.type as typeof allowed[number])) {
      err(`filters[${i}] must have string id and type in ${allowed.join('|')}`);
      continue;
    }
    let opts: string[] | undefined;
    if (f.options !== undefined) {
      if (!Array.isArray(f.options) || !f.options.every((x) => typeof x === 'string')) {
        err(`filters[${i}].options must be an array of strings`);
      } else {
        opts = f.options as string[];
      }
    }
    out.push({
      id: f.id,
      type: f.type as DashboardFilter['type'],
      label: typeof f.label === 'string' ? f.label : undefined,
      default: f.default,
      options: opts,
      bindsTo: typeof f.bindsTo === 'string' ? f.bindsTo : undefined,
      field: readDashboardFilterField(f.field, i, err),
      required: typeof f.required === 'boolean' ? f.required : undefined,
      multiple: typeof f.multiple === 'boolean' ? f.multiple : undefined,
      timezone: readDashboardFilterTimezone(f.timezone, i, err),
      scope: readDashboardFilterScope(f.scope, i, err),
      datasetBindings: readDashboardDatasetFilterBindings(f.datasetBindings, i, err),
      optionSource: readDashboardFilterOptionSource(f.optionSource, i, err),
      dependsOn: stringArrayOrUndefined(f.dependsOn, `filters[${i}].dependsOn`, err),
    });
  }
  return out;
}

function readDashboardFilterTimezone(raw: unknown, index: number, err: (m: string) => void): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    err(`filters[${index}].timezone must be a non-empty IANA time zone string`);
    return undefined;
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: raw.trim() });
    return raw.trim();
  } catch {
    err(`filters[${index}].timezone is not a valid IANA time zone`);
    return undefined;
  }
}

/**
 * Validate a story narrative. Text may not contain a literal number: each
 * figure is a `{{binding}}`, so the story always shows the data it came from.
 */
export function readDashboardNarrative(value: unknown, tileIds: ReadonlySet<string>, err: (message: string) => void): DashboardNarrative | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err('narrative must be an object.');
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  let failed = false;
  const fail = (message: string) => { failed = true; err(`narrative.${message}`); };
  if (raw.version !== 1) fail('version must be 1');
  if (raw.presentation !== 'story' && raw.presentation !== 'dashboard' && raw.presentation !== 'canvas') fail('presentation must be story|dashboard|canvas');
  if (!Array.isArray(raw.blocks) || raw.blocks.length > MAX_STORY_BLOCKS) fail(`blocks must be a list of at most ${MAX_STORY_BLOCKS} blocks`);
  const blocks: DashboardNarrativeBlock[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (Array.isArray(raw.blocks) ? raw.blocks : []).entries()) {
    const block = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const id = typeof block.id === 'string' && block.id.trim() ? block.id.trim() : '';
    if (!id || seen.has(id)) { fail(`blocks[${index}].id must be a unique non-empty string`); continue; }
    seen.add(id);
    if (block.kind === 'text' && typeof block.markdown === 'string') {
      for (const issue of validateStoryText(block.markdown)) fail(`blocks[${index}]: ${issue.message}`);
      blocks.push({ id, kind: 'text', markdown: block.markdown });
    } else if (block.kind === 'tile' && typeof block.tileId === 'string') {
      if (!tileIds.has(block.tileId)) fail(`blocks[${index}].tileId ${block.tileId} is not a tile on this page`);
      blocks.push({ id, kind: 'tile', tileId: block.tileId });
    } else {
      fail(`blocks[${index}] must be {kind:"text", markdown} or {kind:"tile", tileId}`);
    }
  }
  const generatedBy = raw.generatedBy === 'author' || raw.generatedBy === 'ai' || raw.generatedBy === 'deterministic' ? raw.generatedBy : undefined;
  if (failed) return undefined;
  return {
    version: 1,
    presentation: raw.presentation as DashboardNarrative['presentation'],
    blocks,
    ...(generatedBy ? { generatedBy } : {}),
    ...(typeof raw.model === 'string' && raw.model.trim() ? { model: raw.model.trim().slice(0, 120) } : {}),
  };
}

/**
 * Validate a governed HTML page. Unsafe markup and literal numbers are
 * refused; valid markup is stored in its canonical form.
 */
export function readDashboardCanvas(value: unknown, tileIds: ReadonlySet<string>, err: (message: string) => void): DashboardCanvas | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err('canvas must be an object.');
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.html !== 'string') {
    err('canvas must be {version: 1, html: "..."}.');
    return undefined;
  }
  const checked = checkCanvasHtml(raw.html, { tileIds });
  if (checked.issues.length) {
    for (const issue of checked.issues.slice(0, 10)) err(`canvas: ${issue.message}`);
    return undefined;
  }
  const generatedBy = raw.generatedBy === 'author' || raw.generatedBy === 'ai' || raw.generatedBy === 'deterministic' ? raw.generatedBy : undefined;
  return {
    version: 1,
    html: checked.html,
    ...(generatedBy ? { generatedBy } : {}),
    ...(typeof raw.model === 'string' && raw.model.trim() ? { model: raw.model.trim().slice(0, 120) } : {}),
  };
}

/** Validate a driver definition; the runtime checks the fields against the Dataset. */
export function readDriverDefinition(value: unknown, path: string, err: (message: string) => void): DashboardDriverDefinition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(`${path} must be an object.`);
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const before = { count: 0 };
  const fail = (message: string) => { before.count += 1; err(`${path}.${message}`); };
  const text = (key: string) => (typeof raw[key] === 'string' && (raw[key] as string).trim() ? (raw[key] as string).trim() : undefined);
  const measure = text('measure');
  const timeField = text('timeField');
  const anchor = text('anchor');
  const grain = text('grain') as DashboardDriverGrain | undefined;
  const comparison = raw.comparison ?? 'previous_period';
  const timezone = raw.timezone === undefined ? undefined : text('timezone');
  if (raw.version !== 1) fail('version must be 1');
  if (!measure) fail('measure must name a Dataset measure');
  if (!timeField) fail('timeField must name a Dataset time field');
  if (!grain || !DASHBOARD_DRIVER_GRAINS.includes(grain)) fail(`grain must be one of ${DASHBOARD_DRIVER_GRAINS.join('|')}`);
  if (!anchor || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) fail('anchor must be a date (YYYY-MM-DD)');
  if (comparison !== 'previous_period' && comparison !== 'previous_year') fail('comparison must be previous_period|previous_year');
  if (raw.timezone !== undefined && !timezone) fail('timezone must be an IANA zone name');
  const dimensions = Array.isArray(raw.dimensions)
    ? Array.from(new Set(raw.dimensions.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())))
    : [];
  if (!Array.isArray(raw.dimensions) || dimensions.length === 0 || dimensions.length > MAX_DRIVER_DIMENSIONS) {
    fail(`dimensions must list 1 to ${MAX_DRIVER_DIMENSIONS} dimension fields`);
  }
  const filters: NonNullable<DashboardDriverDefinition['filters']> = [];
  if (raw.filters !== undefined) {
    if (!Array.isArray(raw.filters) || raw.filters.length > MAX_DRIVER_FILTERS) fail(`filters must list at most ${MAX_DRIVER_FILTERS} filters`);
    else raw.filters.forEach((entry, index) => {
      const filter = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      const field = typeof filter.field === 'string' ? filter.field.trim() : '';
      const op = filter.op;
      const values = Array.isArray(filter.values) ? filter.values.filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value)) : [];
      if (!field || (op !== 'eq' && op !== 'neq' && op !== 'in' && op !== 'not_in') || values.length === 0 || values.length > 200) {
        fail(`filters[${index}] must name a field, an operator (eq|neq|in|not_in) and 1 to 200 values`);
        return;
      }
      filters.push({ field, op, values });
    });
  }
  if (before.count > 0) return undefined;
  return {
    version: 1,
    measure: measure!,
    timeField: timeField!,
    grain: grain!,
    anchor: anchor!,
    comparison: comparison as DashboardDriverDefinition['comparison'],
    dimensions,
    ...(timezone ? { timezone } : {}),
    ...(filters.length ? { filters } : {}),
  };
}

/** Tile descriptions are short markdown notes, not documents. */
export const MAX_TILE_DESCRIPTION = 2000;
export const MAX_TILE_OWNER = 120;

function readTileText(value: unknown, path: string, max: number, err: (message: string) => void): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    err(`${path} must be a string.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    err(`${path} must be at most ${max} characters.`);
    return undefined;
  }
  return trimmed || undefined;
}

function readLayout(raw: unknown, err: (m: string) => void): DashboardDocument['layout'] {
  if (typeof raw !== 'object' || raw === null) {
    err('layout must be an object');
    return { kind: 'grid', cols: 12, rowHeight: 80, items: [] };
  }
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'grid') {
    err(`layout.kind must be "grid" (got ${String(o.kind)})`);
  }
  const cols = typeof o.cols === 'number' && o.cols > 0 ? o.cols : 12;
  const rowHeight = typeof o.rowHeight === 'number' && o.rowHeight > 0 ? o.rowHeight : 80;

  if (!Array.isArray(o.items)) {
    err('layout.items must be an array');
    return { kind: 'grid', cols, rowHeight, items: [] };
  }

  const allowedViz = [
    'single_value', 'line', 'bar', 'grouped_bar', 'stacked_bar', 'area', 'pie', 'donut', 'scatter',
    'heatmap', 'histogram', 'waterfall', 'gauge', 'table', 'pivot', 'map', 'funnel', 'sankey', 'kpi', 'text', 'heading',
  ] as const;

  const items: DashboardGridItem[] = [];
  for (let i = 0; i < o.items.length; i++) {
    const it = o.items[i] as Record<string, unknown>;
    if (typeof it?.i !== 'string') {
      err(`layout.items[${i}].i must be a string`);
      continue;
    }
    const x = num(it.x), y = num(it.y), w = num(it.w), h = num(it.h);
    if (x === null || y === null || w === null || h === null) {
      err(`layout.items[${i}] must have numeric x, y, w, h`);
      continue;
    }

    const blockRaw = it.block as Record<string, unknown> | undefined;
    const textRaw = it.text as Record<string, unknown> | undefined;
    const aiPinRaw = it.aiPin as Record<string, unknown> | undefined;
    const semantic = readSemanticQueryRef(it.semantic, i, err);
    const draftAnalysis = readDraftAnalysisRef(it.draftAnalysis, i, err);
    const query = it.query === undefined ? undefined : normalizeTileQuery(it.query);
    if (it.query !== undefined && !query) err(`layout.items[${i}].query must be a valid TileQuery object`);
    let block: DashboardBlockRef | null = null;
    if (blockRaw && typeof blockRaw.blockId === 'string') {
      block = { blockId: blockRaw.blockId, version: typeof blockRaw.version === 'string' ? blockRaw.version : undefined };
    } else if (blockRaw && typeof blockRaw.ref === 'string') {
      block = { ref: blockRaw.ref, version: typeof blockRaw.version === 'string' ? blockRaw.version : undefined };
    }
    const text = textRaw && typeof textRaw.markdown === 'string'
      ? { markdown: textRaw.markdown }
      : null;
    const aiPin = aiPinRaw && typeof aiPinRaw.id === 'string'
      ? { id: aiPinRaw.id }
      : null;
    // A driver tile (RFC 0008 step 7) takes its data from its Dataset source;
    // its definition is read and validated below.
    const hasDriver = it.driver !== undefined && it.driver !== null;
    if (!block && !text && !aiPin && !semantic && !draftAnalysis && !query && !hasDriver) {
      err(`layout.items[${i}] must have a block, semantic, draftAnalysis, text, or aiPin source (or a field-based query or driver)`);
      continue;
    }
    if (hasDriver && (typeof it.sourceId !== 'string' || !it.sourceId.trim() || typeof it.sourceRevision !== 'string' || !it.sourceRevision.trim())) {
      err(`layout.items[${i}].driver requires snapshot-bound sourceId and sourceRevision`);
    }
    if (query && (typeof it.sourceId !== 'string' || !it.sourceId.trim() || typeof it.sourceRevision !== 'string' || !it.sourceRevision.trim())) {
      err(`layout.items[${i}].query requires snapshot-bound sourceId and sourceRevision`);
    }

    const vizRaw = it.viz as Record<string, unknown> | undefined;
    if (!vizRaw || typeof vizRaw.type !== 'string'
      || !allowedViz.includes(vizRaw.type as typeof allowedViz[number])) {
      err(`layout.items[${i}].viz.type must be in ${allowedViz.join('|')}`);
      continue;
    }
    let opts: Record<string, unknown> | undefined;
    if (vizRaw.options !== undefined) {
      if (typeof vizRaw.options !== 'object' || vizRaw.options === null || Array.isArray(vizRaw.options)) {
        err(`layout.items[${i}].viz.options must be an object`);
      } else {
        opts = vizRaw.options as Record<string, unknown>;
      }
    }

    const vizStyle = readDashboardVizStyle(vizRaw.style, `layout.items[${i}].viz.style`, err);
    const vizEncoding = readDashboardVizEncoding(vizRaw.encoding, `layout.items[${i}].viz.encoding`, err);
    if (vizEncoding && !query) err(`layout.items[${i}].viz.encoding needs a Dataset field query`);
    if (vizEncoding && query) for (const issue of encodingQueryIssues(vizEncoding, query)) err(`layout.items[${i}].viz.encoding: ${issue}`);
    const display = readDisplayMetadata(it.display, i, allowedViz, err);
    const semanticTileConversionProvenance = readSemanticTileConversionProvenance(
      it.semanticTileConversionProvenance,
      i,
      err,
    );
    const filterBindings = readTileFilterBindings(it.filterBindings, i, err);
    const parameterBindings = readTileParameterBindings(it.parameterBindings, i, err);
    const sourceEvidence = readTileSourceEvidence(it.sourceEvidence, i, err);
    const sourceClass = enumOrUndefined(it.sourceClass, `layout.items[${i}].sourceClass`, ['certified_block', 'governed_semantic', 'exploratory_analysis', 'narrative'] as const, err);
    const review = readTileReview(it.review, i, err);
    const trustState = enumOrUndefined(it.trustState, `layout.items[${i}].trustState`, ['certified', 'review_required', 'draft_ready'] as const, err);
    const reviewStatus = enumOrUndefined(it.reviewStatus, `layout.items[${i}].reviewStatus`, ['certified', 'draft_ready', 'review_required'] as const, err);
    const description = readTileText(it.description, `layout.items[${i}].description`, MAX_TILE_DESCRIPTION, err);
    const driver = it.driver === undefined ? undefined : readDriverDefinition(it.driver, `layout.items[${i}].driver`, err);
    if (driver && !(typeof it.sourceId === 'string' && it.sourceId)) err(`layout.items[${i}].driver needs the tile's Dataset sourceId.`);
    const owner = readTileText(it.owner, `layout.items[${i}].owner`, MAX_TILE_OWNER, err);

    items.push({
      i: it.i,
      x, y, w, h,
      ...(typeof it.sourceId === 'string' && it.sourceId ? { sourceId: it.sourceId } : {}),
      ...(typeof it.sourceRevision === 'string' && it.sourceRevision ? { sourceRevision: it.sourceRevision } : {}),
      ...(block ? { block } : {}),
      ...(text ? { text } : {}),
      ...(aiPin ? { aiPin } : {}),
      ...(semantic ? { semantic } : {}),
      ...(semanticTileConversionProvenance ? { semanticTileConversionProvenance } : {}),
      ...(draftAnalysis ? { draftAnalysis } : {}),
      ...(query ? { query } : {}),
      viz: {
        type: vizRaw.type as DashboardVizConfig['type'],
        options: opts,
        ...(vizStyle ? { style: vizStyle } : {}),
        ...(vizEncoding ? { encoding: vizEncoding } : {}),
      },
      ...(display ? { display } : {}),
      ...(filterBindings.length > 0 ? { filterBindings } : {}),
      ...(parameterBindings.length > 0 ? { parameterBindings } : {}),
      ...(sourceEvidence.length > 0 ? { sourceEvidence } : {}),
      ...(sourceClass ? { sourceClass } : {}),
      ...(review ? { review } : {}),
      ...(trustState ? { trustState } : {}),
      ...(reviewStatus ? { reviewStatus } : {}),
      title: typeof it.title === 'string' ? it.title : undefined,
      ...(description ? { description } : {}),
      ...(owner ? { owner } : {}),
      ...(driver ? { driver } : {}),
      ...(typeof it.sectionId === 'string' && it.sectionId ? { sectionId: it.sectionId } : {}),
    });
  }

  const responsive = readResponsiveLayouts(o.responsive, err);
  return { kind: 'grid', cols, rowHeight, items, ...(responsive ? { responsive } : {}) };
}

function readSemanticTileConversionProvenance(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): SemanticTileConversionProvenanceV1 | undefined {
  if (raw === undefined) return undefined;
  const provenance = normalizeSemanticTileConversionProvenance(raw);
  if (!provenance) {
    err(`layout.items[${index}].semanticTileConversionProvenance must be a valid SemanticTileConversionProvenanceV1 object`);
    return undefined;
  }
  return provenance;
}

function readDashboardFilterField(raw: unknown, index: number, err: (m: string) => void): DashboardFilter['field'] {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`filters[${index}].field must be an object`);
    return undefined;
  }
  const field = raw as Record<string, unknown>;
  if (typeof field.name !== 'string' || !field.name.trim()) {
    err(`filters[${index}].field.name must be a non-empty string`);
    return undefined;
  }
  return {
    name: field.name,
    relation: typeof field.relation === 'string' ? field.relation : undefined,
    semanticModel: typeof field.semanticModel === 'string' ? field.semanticModel : undefined,
    provider: typeof field.provider === 'string' ? field.provider : undefined,
  };
}

function readDashboardFilterScope(raw: unknown, index: number, err: (m: string) => void): DashboardFilter['scope'] {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`filters[${index}].scope must be an object`);
    return undefined;
  }
  const scope = raw as Record<string, unknown>;
  return {
    app: scope.app === true || undefined,
    page: typeof scope.page === 'string' ? scope.page : undefined,
    tileIds: stringArrayOrUndefined(scope.tileIds, `filters[${index}].scope.tileIds`, err),
  };
}

function readDashboardDatasetFilterBindings(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardFilter['datasetBindings'] {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`filters[${index}].datasetBindings must be an object`);
    return undefined;
  }
  const bindings: Record<string, DashboardDatasetFilterBinding> = {};
  for (const [datasetId, candidate] of Object.entries(raw as Record<string, unknown>)) {
    if (!datasetId.trim() || typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      err(`filters[${index}].datasetBindings entries must have dataset ids and field objects`);
      continue;
    }
    const field = (candidate as Record<string, unknown>).field;
    if (typeof field !== 'string' || !field.trim()) {
      err(`filters[${index}].datasetBindings.${datasetId}.field must be a non-empty string`);
      continue;
    }
    const tileIds = stringArrayOrUndefined(
      (candidate as Record<string, unknown>).tileIds,
      `filters[${index}].datasetBindings.${datasetId}.tileIds`,
      err,
    );
    bindings[datasetId] = { field: field.trim(), ...(tileIds === undefined ? {} : { tileIds }) };
  }
  // An explicit empty object is meaningful for an App-scoped Dataset filter:
  // the page owns the control but deliberately has no source/tile inclusion
  // until an author makes one. Preserve it across reload rather than turning
  // it into an absent binding that a later page mutation could misread.
  return bindings;
}

function readDatasets(raw: unknown, err: (m: string) => void): DashboardDatasetBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('datasets must be an array when present');
    return [];
  }
  const seen = new Set<string>();
  const out: DashboardDatasetBinding[] = [];
  raw.forEach((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      err(`datasets[${index}] must be an object`);
      return;
    }
    const value = candidate as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
    const sourceRevision = typeof value.sourceRevision === 'string' ? value.sourceRevision.trim() : '';
    const snapshotId = typeof value.snapshotId === 'string' ? value.snapshotId.trim() : '';
    const contractFingerprint = typeof value.contractFingerprint === 'string' ? value.contractFingerprint.trim() : '';
    if (!id || !sourceId || !sourceRevision || !snapshotId || !contractFingerprint) {
      err(`datasets[${index}] requires id, sourceId, sourceRevision, snapshotId, and contractFingerprint`);
      return;
    }
    if (seen.has(id)) {
      err(`datasets[${index}].id ${id} is duplicated`);
      return;
    }
    seen.add(id);
    out.push({ id, sourceId, sourceRevision, snapshotId, contractFingerprint });
  });
  return out;
}

function readInteractions(raw: unknown, err: (m: string) => void): DashboardInteractions | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('interactions must be an object when present');
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  let crossFilter: DashboardInteractions['crossFilter'];
  const rawCrossFilter = value.crossFilter;
  if (rawCrossFilter !== undefined) {
    if (typeof rawCrossFilter !== 'object' || rawCrossFilter === null || Array.isArray(rawCrossFilter)) {
      err('interactions.crossFilter must be an object');
    } else {
      const record = rawCrossFilter as Record<string, unknown>;
      const mappings: DashboardCrossFilterMapping[] = [];
      if (!Array.isArray(record.mappings)) err('interactions.crossFilter.mappings must be an array');
      else record.mappings.forEach((candidate, index) => {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
          err(`interactions.crossFilter.mappings[${index}] must be an object`);
          return;
        }
        const mapping = candidate as Record<string, unknown>;
        const fromTileId = typeof mapping.fromTileId === 'string' ? mapping.fromTileId.trim() : '';
        const fromField = typeof mapping.fromField === 'string' ? mapping.fromField.trim() : '';
        const toDataset = typeof mapping.toDataset === 'string' ? mapping.toDataset.trim() : '';
        const toField = typeof mapping.toField === 'string' ? mapping.toField.trim() : '';
        if (!fromTileId || !fromField || !toDataset || !toField) {
          err(`interactions.crossFilter.mappings[${index}] requires fromTileId, fromField, toDataset, and toField`);
          return;
        }
        mappings.push({ fromTileId, fromField, toDataset, toField });
      });
      crossFilter = { enabled: record.enabled === false ? false : undefined, mappings };
    }
  }
  let detail: DashboardDetailInteraction | undefined;
  if (value.detail !== undefined) {
    if (typeof value.detail !== 'object' || value.detail === null || Array.isArray(value.detail)) err('interactions.detail must be an object');
    else {
      const record = value.detail as Record<string, unknown>;
      const dataset = typeof record.dataset === 'string' ? record.dataset.trim() : '';
      const columns = stringArrayOrUndefined(record.columns, 'interactions.detail.columns', err) ?? [];
      if (!dataset || columns.length === 0) err('interactions.detail requires dataset and at least one column');
      else detail = { dataset, columns };
    }
  }
  let navigate: DashboardNavigateInteraction[] | undefined;
  if (value.navigate !== undefined) {
    if (!Array.isArray(value.navigate)) err('interactions.navigate must be an array');
    else {
      navigate = value.navigate.flatMap((candidate, index) => {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
          err(`interactions.navigate[${index}] must be an object`);
          return [];
        }
        const record = candidate as Record<string, unknown>;
        const fromTile = typeof record.fromTile === 'string' ? record.fromTile.trim() : '';
        const toPage = typeof record.toPage === 'string' ? record.toPage.trim() : '';
        const carryFilters = stringArrayOrUndefined(record.carryFilters, `interactions.navigate[${index}].carryFilters`, err) ?? [];
        if (!fromTile || !toPage) {
          err(`interactions.navigate[${index}] requires fromTile and toPage`);
          return [];
        }
        return [{ fromTile, toPage, carryFilters }];
      });
    }
  }
  return crossFilter || detail || navigate ? { ...(crossFilter ? { crossFilter } : {}), ...(detail ? { detail } : {}), ...(navigate ? { navigate } : {}) } : undefined;
}

function readDashboardFilterOptionSource(raw: unknown, index: number, err: (m: string) => void): DashboardFilter['optionSource'] {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`filters[${index}].optionSource must be an object`);
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  if (source.mode !== 'static' && source.mode !== 'distinct_query') {
    err(`filters[${index}].optionSource.mode must be static or distinct_query`);
    return undefined;
  }
  return {
    mode: source.mode,
    sourceRef: typeof source.sourceRef === 'string' ? source.sourceRef : undefined,
    field: typeof source.field === 'string' ? source.field : undefined,
    snapshotId: typeof source.snapshotId === 'string' ? source.snapshotId : undefined,
    limit: typeof source.limit === 'number' && source.limit > 0 ? source.limit : undefined,
  };
}

function readResponsiveLayouts(raw: unknown, err: (m: string) => void): DashboardResponsiveLayouts | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('layout.responsive must be an object');
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const responsive: DashboardResponsiveLayouts = {};
  for (const breakpoint of ['wide', 'medium', 'narrow'] as const) {
    if (source[breakpoint] === undefined) continue;
    const projection = readLayout(source[breakpoint], err);
    // Responsive projections cannot recursively contain more projections.
    const { responsive: _nested, ...flat } = projection;
    responsive[breakpoint] = flat;
  }
  return Object.keys(responsive).length ? responsive : undefined;
}

function readDraftAnalysisRef(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardDraftAnalysisRef | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`layout.items[${index}].draftAnalysis must be an object`);
    return undefined;
  }
  const item = raw as Record<string, unknown>;
  if (typeof item.ref !== 'string' || !item.ref) {
    err(`layout.items[${index}].draftAnalysis.ref must be a non-empty string`);
    return undefined;
  }
  if (typeof item.artifactFingerprint !== 'string' || !item.artifactFingerprint) {
    err(`layout.items[${index}].draftAnalysis.artifactFingerprint must be a non-empty string`);
    return undefined;
  }
  return {
    ref: item.ref,
    artifactFingerprint: item.artifactFingerprint,
    snapshotId: typeof item.snapshotId === 'string' ? item.snapshotId : undefined,
    executionReceiptId: typeof item.executionReceiptId === 'string' ? item.executionReceiptId : undefined,
  };
}

function readTileReview(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardTileReview | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`layout.items[${index}].review must be an object`);
    return undefined;
  }
  const item = raw as Record<string, unknown>;
  const status = enumValue(item.status, ['not_required', 'required', 'approved'] as const, `layout.items[${index}].review.status`, err);
  if (!status) return undefined;
  return {
    status,
    sourceFingerprint: typeof item.sourceFingerprint === 'string' ? item.sourceFingerprint : undefined,
    preflightReceiptId: typeof item.preflightReceiptId === 'string' ? item.preflightReceiptId : undefined,
    reviewedAt: typeof item.reviewedAt === 'string' ? item.reviewedAt : undefined,
    reviewedBy: typeof item.reviewedBy === 'string' ? item.reviewedBy : undefined,
  };
}

function readSemanticQueryRef(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardSemanticQueryRef | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`layout.items[${index}].semantic must be an object`);
    return undefined;
  }
  const item = raw as Record<string, unknown>;
  const provider = enumValue(item.provider, ['metricflow', 'native'] as const, `layout.items[${index}].semantic.provider`, err);
  const metrics = stringArrayOrUndefined(item.metrics, `layout.items[${index}].semantic.metrics`, err) ?? [];
  const modelRefs = stringArrayOrUndefined(item.semanticModelRefs, `layout.items[${index}].semantic.semanticModelRefs`, err) ?? [];
  if (typeof item.id !== 'string' || !item.id) err(`layout.items[${index}].semantic.id must be a non-empty string`);
  if (metrics.length === 0) err(`layout.items[${index}].semantic.metrics must include at least one metric`);
  if (modelRefs.length === 0) err(`layout.items[${index}].semantic.semanticModelRefs must include at least one reference`);
  if (typeof item.definitionFingerprint !== 'string' || !item.definitionFingerprint) {
    err(`layout.items[${index}].semantic.definitionFingerprint must be a non-empty string`);
  }
  const filters: DashboardSemanticQueryRef['filters'] = [];
  if (item.filters !== undefined) {
    if (!Array.isArray(item.filters)) err(`layout.items[${index}].semantic.filters must be an array`);
    else item.filters.forEach((candidate, filterIndex) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        err(`layout.items[${index}].semantic.filters[${filterIndex}] must be an object`);
        return;
      }
      const filter = candidate as Record<string, unknown>;
      if (typeof filter.field !== 'string' || typeof filter.operator !== 'string') {
        err(`layout.items[${index}].semantic.filters[${filterIndex}] requires field and operator`);
        return;
      }
      filters.push({ field: filter.field, operator: filter.operator, value: filter.value });
    });
  }
  const orderBy: NonNullable<DashboardSemanticQueryRef['orderBy']> = [];
  if (item.orderBy !== undefined) {
    if (!Array.isArray(item.orderBy)) err(`layout.items[${index}].semantic.orderBy must be an array`);
    else item.orderBy.forEach((candidate, orderIndex) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return;
      const order = candidate as Record<string, unknown>;
      const direction = enumValue(order.direction, ['asc', 'desc'] as const, `layout.items[${index}].semantic.orderBy[${orderIndex}].direction`, err);
      if (typeof order.field === 'string' && direction) orderBy.push({ field: order.field, direction });
    });
  }
  if (!provider || typeof item.id !== 'string' || !item.id || metrics.length === 0 || modelRefs.length === 0 || typeof item.definitionFingerprint !== 'string' || !item.definitionFingerprint) return undefined;
  return {
    id: item.id,
    provider,
    metrics,
    dimensions: stringArrayOrUndefined(item.dimensions, `layout.items[${index}].semantic.dimensions`, err),
    ...(filters.length ? { filters } : {}),
    timeDimension: typeof item.timeDimension === 'string' ? item.timeDimension : undefined,
    ...(orderBy.length ? { orderBy } : {}),
    limit: typeof item.limit === 'number' && item.limit > 0 ? Math.floor(item.limit) : undefined,
    semanticModelRefs: modelRefs,
    qualifiedMetricIds: stringArrayOrUndefined(item.qualifiedMetricIds, `layout.items[${index}].semantic.qualifiedMetricIds`, err),
    qualifiedModelIds: stringArrayOrUndefined(item.qualifiedModelIds, `layout.items[${index}].semantic.qualifiedModelIds`, err),
    resolvedPlanFingerprint: typeof item.resolvedPlanFingerprint === 'string' ? item.resolvedPlanFingerprint : undefined,
    definitionFingerprint: item.definitionFingerprint,
    snapshotId: typeof item.snapshotId === 'string' ? item.snapshotId : undefined,
  };
}

function readDisplayMetadata(
  raw: unknown,
  index: number,
  allowedViz: readonly DashboardVizConfig['type'][],
  err: (m: string) => void,
): DashboardDisplayMetadata | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`layout.items[${index}].display must be an object`);
    return undefined;
  }
  const display = raw as Record<string, unknown>;
  const modes = ['manual', 'ai_generated', 'block_hint'] as const;
  const components = [
    'BusinessBrief',
    'KpiMetric',
    'TrendPanel',
    'RankingPanel',
    'EvidenceTable',
    'PivotTable',
    'TrustCallout',
    'NarrativePanel',
    'ResearchActions',
  ] as const;
  const layoutIntents = ['auto', 'compact', 'standard', 'wide', 'tall', 'full'] as const;
  const trustStates = ['certified', 'review_required', 'draft_ready'] as const;
  const reviewStatuses = ['certified', 'draft_ready', 'review_required'] as const;
  const mode = enumValue(display.mode, modes, `layout.items[${index}].display.mode`, err);
  const component = enumValue(display.component, components, `layout.items[${index}].display.component`, err);
  const defaultVisualization = enumValue(display.defaultVisualization, allowedViz, `layout.items[${index}].display.defaultVisualization`, err);
  const layoutIntent = enumValue(display.layoutIntent, layoutIntents, `layout.items[${index}].display.layoutIntent`, err);
  const trustState = enumValue(display.trustState, trustStates, `layout.items[${index}].display.trustState`, err);
  const reviewStatus = enumValue(display.reviewStatus, reviewStatuses, `layout.items[${index}].display.reviewStatus`, err);
  const rationale = typeof display.rationale === 'string' ? display.rationale : undefined;
  if (!rationale) err(`layout.items[${index}].display.rationale must be a string`);
  const allowedVisualizations = Array.isArray(display.allowedVisualizations)
    ? display.allowedVisualizations.filter((value): value is DashboardVizConfig['type'] =>
        typeof value === 'string' && allowedViz.includes(value as DashboardVizConfig['type']),
      )
    : [];
  if (!Array.isArray(display.allowedVisualizations) || allowedVisualizations.length === 0) {
    err(`layout.items[${index}].display.allowedVisualizations must include at least one supported visualization`);
  }
  let fieldHints: Record<string, string> | undefined;
  if (display.fieldHints !== undefined) {
    if (typeof display.fieldHints !== 'object' || display.fieldHints === null || Array.isArray(display.fieldHints)) {
      err(`layout.items[${index}].display.fieldHints must be an object`);
    } else {
      fieldHints = Object.fromEntries(
        Object.entries(display.fieldHints as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    }
  }
  if (!mode || !component || !defaultVisualization || !layoutIntent || !trustState || !reviewStatus || !rationale || allowedVisualizations.length === 0) {
    return undefined;
  }
  return {
    mode,
    component,
    defaultVisualization,
    allowedVisualizations,
    ...(fieldHints && Object.keys(fieldHints).length > 0 ? { fieldHints } : {}),
    layoutIntent,
    rationale,
    trustState,
    reviewStatus,
  };
}

function readTileFilterBindings(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardTileFilterBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err(`layout.items[${index}].filterBindings must be an array`);
    return [];
  }
  const out: DashboardTileFilterBinding[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      err(`layout.items[${index}].filterBindings[${i}] must be an object`);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.filter !== 'string' || record.filter.length === 0) {
      err(`layout.items[${index}].filterBindings[${i}].filter must be a non-empty string`);
      continue;
    }
    const mode = enumOrUndefined(record.mode, `layout.items[${index}].filterBindings[${i}].mode`, ['parameter', 'predicate', 'semantic'] as const, err);
    const paramNames = stringArrayOrUndefined(record.paramNames, `layout.items[${index}].filterBindings[${i}].paramNames`, err);
    const capability = enumOrUndefined(record.capability, `layout.items[${index}].filterBindings[${i}].capability`, ['supported', 'unsupported', 'preflight_required'] as const, err);
    out.push({
      filter: record.filter,
      binding: typeof record.binding === 'string' ? record.binding : undefined,
      ...(mode ? { mode } : {}),
      ...(paramNames ? { paramNames } : {}),
      required: typeof record.required === 'boolean' ? record.required : undefined,
      unsupportedReason: typeof record.unsupportedReason === 'string' ? record.unsupportedReason : undefined,
      ...(capability ? { capability } : {}),
    });
  }
  return out;
}

function readTileParameterBindings(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardTileParameterBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err(`layout.items[${index}].parameterBindings must be an array`);
    return [];
  }
  const out: DashboardTileParameterBinding[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      err(`layout.items[${index}].parameterBindings[${i}] must be an object`);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.param !== 'string' || record.param.length === 0) {
      err(`layout.items[${index}].parameterBindings[${i}].param must be a non-empty string`);
      continue;
    }
    const source = enumValue(record.source, ['dashboard_filter', 'constant', 'persona', 'variable'] as const, `layout.items[${index}].parameterBindings[${i}].source`, err);
    if (!source) continue;
    out.push({
      param: record.param,
      source,
      filter: typeof record.filter === 'string' ? record.filter : undefined,
      field: typeof record.field === 'string' ? record.field : undefined,
      value: record.value,
      parameterType: enumOrUndefined(record.parameterType, `layout.items[${index}].parameterBindings[${i}].parameterType`, ['string', 'number', 'boolean', 'date', 'string[]', 'number[]', 'date[]'] as const, err),
      required: typeof record.required === 'boolean' ? record.required : undefined,
      default: record.default,
      policy: enumOrUndefined(record.policy, `layout.items[${index}].parameterBindings[${i}].policy`, ['dynamic', 'static', 'business', 'derived', 'optional', 'ambiguous_review_required'] as const, err),
    });
  }
  return out;
}

function readTileSourceEvidence(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardTileSourceEvidence[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err(`layout.items[${index}].sourceEvidence must be an array`);
    return [];
  }
  const out: DashboardTileSourceEvidence[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      err(`layout.items[${index}].sourceEvidence[${i}] must be an object`);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.source !== 'string' || record.source.length === 0) {
      err(`layout.items[${index}].sourceEvidence[${i}].source must be a non-empty string`);
      continue;
    }
    if (typeof record.reason !== 'string' || record.reason.length === 0) {
      err(`layout.items[${index}].sourceEvidence[${i}].reason must be a non-empty string`);
      continue;
    }
    const trustState = enumOrUndefined(record.trustState, `layout.items[${index}].sourceEvidence[${i}].trustState`, ['certified', 'review_required', 'draft_ready'] as const, err);
    out.push({
      source: record.source,
      reason: record.reason,
      kind: typeof record.kind === 'string' ? record.kind : undefined,
      nodeId: typeof record.nodeId === 'string' ? record.nodeId : undefined,
      path: typeof record.path === 'string' ? record.path : undefined,
      ...(trustState ? { trustState } : {}),
    });
  }
  return out;
}

function enumValue<T extends readonly string[]>(
  raw: unknown,
  allowed: T,
  field: string,
  err: (m: string) => void,
): T[number] | undefined {
  if (typeof raw !== 'string' || !allowed.includes(raw as T[number])) {
    err(`${field} must be one of ${allowed.join('|')}`);
    return undefined;
  }
  return raw as T[number];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function enumOrUndefined<T extends readonly string[]>(
  raw: unknown,
  field: string,
  allowed: T,
  err: (m: string) => void,
): T[number] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T[number];
  err(`${field} must be one of ${allowed.join('|')}`);
  return undefined;
}
