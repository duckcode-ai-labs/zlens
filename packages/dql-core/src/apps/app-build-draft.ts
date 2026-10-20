import { createHash } from 'node:crypto';
import type { DashboardDocument, DashboardFilter, DashboardGridItem, DashboardGridLayout } from './dashboard-document.js';
import { datasetTileVisualizationCompatibility } from './tile-query.js';
import { readDashboardVizStyle } from './viz-style.js';
import { encodingQueryIssues, readDashboardVizEncoding } from './viz-encoding.js';
import { MAX_TILE_DESCRIPTION, MAX_TILE_OWNER, readDashboardCanvas, readDashboardNarrative } from './dashboard-document.js';
import type { DashboardCanvas, DashboardNarrative } from './dashboard-document.js';
import { settleGridLayout } from './grid-layout.js';
import type { DatasetDescriptor } from '../datasets/descriptor.js';
import type { MetricCapabilityContract } from '../contracts/analytical.js';

export type AppBuildAuthoringMode = 'ai' | 'manual';
export type AppBuildSourcePolicy = 'governed_only' | 'include_review_required';
export type AppBuildTemplateId = 'executive_brief' | 'operational_dashboard' | 'investigation' | 'blank';

export interface AppBuildClarification {
  id: string;
  question: string;
  choices: Array<{ id: string; label: string; description?: string }>;
  required: boolean;
  answerId?: string;
}

export interface AppBuildFrame {
  goal: string;
  decision?: string;
  audience?: string;
  metrics: string[];
  dimensions: string[];
  grain?: string;
  timeRange?: string;
  comparison?: string;
  filters: string[];
  desiredOutput?: string;
  clarificationQuestions?: AppBuildClarification[];
}

export interface AppBuildRequirement {
  id: string;
  question: string;
  role: 'kpi' | 'trend' | 'breakdown' | 'detail' | 'narrative' | 'evidence';
  required: boolean;
  measures: string[];
  dimensions: string[];
  filters: string[];
  grain?: string;
}

export interface AppBuildRequirementCoverage {
  requirementId: string;
  status: 'covered' | 'partial' | 'gap';
  sourceIds: string[];
  componentIds: string[];
  reasons: string[];
}

export type AppBuildDraftSourceKind =
  | 'block'
  | 'certified_block'
  | 'governed_semantic'
  | 'review_block'
  | 'review_dql'
  | 'text'
  /** v1 read compatibility; new drafts use governed_semantic. */
  | 'semantic_query'
  /** v1 read compatibility; generated exploration is materialized as review_dql. */
  | 'exploratory_sql';

export type AppBuildSourceLifecycle =
  | 'certified'
  | 'review'
  | 'draft'
  | 'pending_recertification'
  | 'deprecated'
  | 'unknown';

export interface AppBuildSourceCapabilities {
  measures: string[];
  dimensions: string[];
  outputs: string[];
  filters: string[];
  grain?: string;
  chartType?: string;
  allowedVisualizations?: string[];
  /** Field-based dataset projection. Omitted for legacy whole-block sources. */
  dataset?: DatasetDescriptor;
  /**
   * Exact immutable semantic capabilities keyed by metricId.  A model-scoped
   * Dataset may expose several measures; callers must select from this map
   * rather than treating the source-wide Dataset operations as per-metric
   * authority.
   */
  metricCapabilities?: Record<string, MetricCapabilityContract>;
  semanticModelId?: string;
  parameters: Array<{
    name: string;
    type?: string;
    required: boolean;
    hasDefault: boolean;
  }>;
}

export type AppBuildDraftSource = {
  /** Canonical, path-disambiguated source id used by tiles and coverage. */
  id: string;
  kind: AppBuildDraftSourceKind;
  /** Legacy display/execution reference retained for v1/v2 readers. */
  sourceRef: string;
  qualifiedIdentity?: string;
  sourcePath?: string;
  executionRef?: string;
  snapshotId?: string;
  sourceRevision?: string;
  sourceFingerprint?: string;
  receiptId?: string;
  lifecycle?: AppBuildSourceLifecycle;
  capabilities?: AppBuildSourceCapabilities;
  trustState: 'certified' | 'review_required' | 'draft_ready';
  reviewStatus: 'not_required' | 'required' | 'approved';
};

export interface AppBuildReviewTask {
  id: string;
  message: string;
  status: 'open' | 'resolved';
  sourceId?: string;
  pageId?: string;
  tileId?: string;
}

export interface AppBuildRunReceipt {
  id: string;
  pageId: string;
  revision: number;
  snapshotId: string;
  filterFingerprint: string;
  resultFingerprint: string;
  /**
   * Server-issued fingerprint of the executable local-draft content that
   * produced this run. Legacy receipts may omit it for reading only; new
   * receipts cannot preflight or publish without an exact match.
   */
  intentFingerprint?: string;
  createdAt: string;
}

export interface AppBuildPreflightReceipt {
  id: string;
  revision: number;
  proposalHash: string;
  sourceFingerprint: string;
  createdAt: string;
}

/**
 * The one durable authoring aggregate for AI, manual, CLI, and Copilot work.
 * Drafts are local-only. Git-owned App source is produced only by explicit
 * Publish to Project and is never used as the mutable editor backing store.
 */
export interface AppBuildDraft {
  version: 3;
  id: string;
  appId: string;
  name: string;
  baseApp?: { appId: string; fingerprint: string };
  revision: number;
  proposalHash: string;
  authoringMode: AppBuildAuthoringMode;
  template: AppBuildTemplateId;
  sourcePolicy: AppBuildSourcePolicy;
  state: 'local_draft' | 'clarification_required' | 'preflight_ready' | 'project_published';
  frame: AppBuildFrame;
  requirements: AppBuildRequirement[];
  coverage: AppBuildRequirementCoverage[];
  sources: AppBuildDraftSource[];
  pages: DashboardDocument[];
  reviewTasks: AppBuildReviewTask[];
  /** One settled run receipt per page. Any content edit invalidates the set. */
  previewReceipts?: AppBuildRunReceipt[];
  /** @deprecated Early v2 alias for the most recently run page. */
  previewReceipt?: AppBuildRunReceipt;
  preflightReceipt?: AppBuildPreflightReceipt;
  publishedFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export type AppBuildDraftOperation =
  | { type: 'set_name'; name: string }
  | { type: 'set_template'; template: AppBuildTemplateId }
  | { type: 'set_frame'; frame: AppBuildFrame }
  | { type: 'set_source_policy'; sourcePolicy: AppBuildSourcePolicy }
  | { type: 'set_requirements'; requirements: AppBuildRequirement[]; coverage?: AppBuildRequirementCoverage[] }
  | { type: 'set_coverage'; coverage: AppBuildRequirementCoverage[] }
  | { type: 'upsert_source'; source: AppBuildDraftSource }
  | { type: 'remove_source'; sourceId: string }
  | { type: 'upsert_page'; page: DashboardDocument }
  | { type: 'remove_page'; pageId: string }
  | { type: 'add_tile'; pageId: string; tile: DashboardGridItem }
  | { type: 'update_tile'; pageId: string; tileId: string; patch: Partial<DashboardGridItem> }
  | { type: 'remove_tile'; pageId: string; tileId: string }
  | { type: 'set_filter'; pageId: string; filter: DashboardFilter }
  | { type: 'remove_filter'; pageId: string; filterId: string }
  /** Persist a field-bound interaction on the local page draft. It is a
   * content edit because the next preview must use the new mapping. */
  | { type: 'set_interactions'; pageId: string; interactions?: DashboardDocument['interactions'] }
  | { type: 'set_layout'; pageId: string; layout: DashboardGridLayout & { responsive?: DashboardDocument['layout']['responsive'] } }
  /** Story layout (RFC 0008 step 8); `null` removes it. Text with a literal number is refused. */
  | { type: 'set_narrative'; pageId: string; narrative: DashboardNarrative | null }
  /** Governed HTML page (RFC 0008 step 9); `null` removes it. Unsafe markup is refused. */
  | { type: 'set_canvas'; pageId: string; canvas: DashboardCanvas | null }
  | { type: 'set_review_task'; task: AppBuildReviewTask }
  | { type: 'remove_review_task'; taskId: string }
  | { type: 'set_preview_receipt'; receipt: AppBuildRunReceipt }
  /**
   * Server-issued invalidation for a page whose latest full preview was
   * incomplete. It deliberately carries the receipt observed when that run
   * began so a late result cannot erase a newer successful preview.
   */
  | { type: 'clear_preview_receipt'; pageId: string; expectedReceiptId?: string };

export function createAppBuildDraft(input: {
  id: string;
  appId: string;
  name?: string;
  baseApp?: AppBuildDraft['baseApp'];
  authoringMode: AppBuildAuthoringMode;
  template?: AppBuildTemplateId;
  sourcePolicy?: AppBuildSourcePolicy;
  frame: AppBuildFrame;
  requirements?: AppBuildRequirement[];
  coverage?: AppBuildRequirementCoverage[];
  sources?: AppBuildDraftSource[];
  pages?: DashboardDocument[];
  reviewTasks?: AppBuildReviewTask[];
  now?: string;
}): AppBuildDraft {
  const now = input.now ?? new Date().toISOString();
  const clarifications = input.frame.clarificationQuestions ?? [];
  const needsClarification = clarifications.some((question) => question.required && !question.answerId);
  const draftWithoutHash = {
    version: 3 as const,
    id: input.id,
    appId: input.appId,
    name: input.name?.trim() || input.frame.goal.trim() || input.appId,
    ...(input.baseApp ? { baseApp: input.baseApp } : {}),
    revision: 1,
    authoringMode: input.authoringMode,
    template: input.template ?? 'blank',
    sourcePolicy: input.sourcePolicy ?? 'governed_only',
    state: needsClarification ? 'clarification_required' as const : 'local_draft' as const,
    frame: input.frame,
    requirements: input.requirements ?? [],
    coverage: input.coverage ?? [],
    sources: input.sources ?? [],
    pages: input.pages ?? [],
    reviewTasks: input.reviewTasks ?? [],
    createdAt: now,
    updatedAt: now,
  };
  assertAppBuildDraftPolicy(draftWithoutHash);
  return { ...draftWithoutHash, proposalHash: appBuildDraftHash(draftWithoutHash) };
}

/** A new local App Build Draft id, in the one format every entry point uses. */
export function newAppBuildDraftId(now = Date.now()): string {
  return `build_${now}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The empty first page of a new local App Build Draft. App Studio, Ask and
 * MCP all start from this page; its domain is the App's domain.
 */
export function createBlankAppBuildPage(input: {
  name: string;
  goal?: string;
  domain?: string;
  audience?: string;
}): DashboardDocument {
  const items: DashboardGridItem[] = [];
  return {
    version: 2,
    id: 'overview',
    metadata: {
      title: 'Overview',
      description: input.goal?.trim() || `Local draft canvas for ${input.name}`,
      domain: input.domain?.trim() || 'general',
      audience: input.audience?.trim() || 'stakeholders',
      visibility: 'private',
      lifecycle: 'draft',
    },
    layout: {
      kind: 'grid', cols: 12, rowHeight: 80, items,
      responsive: {
        wide: { kind: 'grid', cols: 12, rowHeight: 80, items },
        medium: { kind: 'grid', cols: 6, rowHeight: 80, items },
        narrow: { kind: 'grid', cols: 1, rowHeight: 80, items },
      },
    },
  };
}

export function applyAppBuildDraftOperations(
  draft: AppBuildDraft,
  expectedRevision: number,
  operations: AppBuildDraftOperation[],
  now = new Date().toISOString(),
): AppBuildDraft {
  if (draft.revision !== expectedRevision) {
    throw new Error(`APP_BUILD_REVISION_CONFLICT: expected ${expectedRevision}, current ${draft.revision}`);
  }
  if (operations.length === 0) return draft;
  let next: AppBuildDraft = structuredClone(draft);
  for (const operation of operations) next = applyOperation(next, operation);
  next = reconcileCoverageReferences(next);
  const contentChanged = operations.some((operation) => (
    operation.type !== 'set_preview_receipt' && operation.type !== 'clear_preview_receipt'
  ));
  const settledDataChanged = operations.some((operation) => !operationPreservesSettledData(draft, operation));
  next.updatedAt = now;
  if (contentChanged) {
    next.revision += 1;
    if (settledDataChanged) {
      delete next.previewReceipts;
      delete next.previewReceipt;
    } else {
      if (next.previewReceipts) next.previewReceipts = next.previewReceipts.map((receipt) => ({ ...receipt, revision: next.revision }));
      if (next.previewReceipt) next.previewReceipt = { ...next.previewReceipt, revision: next.revision };
    }
    delete next.preflightReceipt;
    delete next.publishedFingerprint;
    const needsClarification = (next.frame.clarificationQuestions ?? [])
      .some((question) => question.required && !question.answerId);
    next.state = needsClarification ? 'clarification_required' : 'local_draft';
    next.proposalHash = appBuildDraftHash({ ...next, proposalHash: undefined });
  }
  assertAppBuildDraftPolicy(next);
  return next;
}

/**
 * Coverage is part of the aggregate, not an independent planner memo. Keep its
 * references aligned after source/page/tile mutations so a removed component
 * can never remain reported as covered or block publication as a ghost gap.
 */
function reconcileCoverageReferences(draft: AppBuildDraft): AppBuildDraft {
  const sourceIds = new Set(draft.sources.map((source) => source.id));
  const componentIds = new Set(draft.pages.flatMap((page) => page.layout.items.map((item) => item.i)));
  return {
    ...draft,
    coverage: draft.coverage.map((item) => {
      const validSourceIds = item.sourceIds.filter((sourceId) => sourceIds.has(sourceId));
      const validComponentIds = item.componentIds.filter((componentId) => componentIds.has(componentId));
      return {
        ...item,
        sourceIds: validSourceIds,
        componentIds: validComponentIds,
        status: validSourceIds.length > 0 && validComponentIds.length > 0 ? item.status : 'gap',
      };
    }),
  };
}

function operationPreservesSettledData(draft: AppBuildDraft, operation: AppBuildDraftOperation): boolean {
  if (operation.type === 'set_preview_receipt' || operation.type === 'clear_preview_receipt') return true;
  // Story text only presents results; it changes no query.
  if (operation.type === 'set_narrative' || operation.type === 'set_canvas') return true;
  if (operation.type === 'update_tile') {
    const presentationKeys = new Set(['title', 'description', 'owner', 'viz', 'display', 'x', 'y', 'w', 'h', 'sectionId']);
    return Object.keys(operation.patch).every((key) => presentationKeys.has(key));
  }
  if (operation.type !== 'set_layout') return false;
  const page = draft.pages.find((candidate) => candidate.id === operation.pageId);
  if (!page || page.layout.items.length !== operation.layout.items.length) return false;
  const currentById = new Map(page.layout.items.map((item) => [item.i, item]));
  return operation.layout.items.every((item) => {
    const current = currentById.get(item.i);
    return current !== undefined && JSON.stringify(withoutTileGeometry(item)) === JSON.stringify(withoutTileGeometry(current));
  });
}

function withoutTileGeometry<T extends { x: number; y: number; w: number; h: number }>(item: T): Omit<T, 'x' | 'y' | 'w' | 'h'> {
  const { x: _x, y: _y, w: _w, h: _h, ...contract } = item;
  return contract;
}

export function appBuildDraftHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/**
 * Bind a preview to the full server-owned draft content for one page.
 *
 * This intentionally includes the field query, filters, interactions,
 * parameter bindings, source revisions/contracts, and all other authored
 * content. Receipt/preflight/publication bookkeeping is excluded because it
 * changes after a successful preview without changing what was executed.
 * Arrays retain their authored order; object keys are canonicalized so a JSON
 * transport cannot mint a different digest for equivalent object content.
 */
export function appBuildPreviewIntentFingerprint(draft: AppBuildDraft, pageId: string): string {
  const page = draft.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`App Build page not found: ${pageId}`);
  const content = {
    version: 1,
    draftId: draft.id,
    appId: draft.appId,
    name: draft.name,
    baseApp: draft.baseApp,
    authoringMode: draft.authoringMode,
    template: draft.template,
    sourcePolicy: draft.sourcePolicy,
    frame: draft.frame,
    requirements: draft.requirements,
    coverage: draft.coverage,
    sources: draft.sources,
    page,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalAppBuildPreviewContent(content))).digest('hex')}`;
}

function canonicalAppBuildPreviewContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAppBuildPreviewContent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalAppBuildPreviewContent(entry)]));
}

function applyOperation(draft: AppBuildDraft, operation: AppBuildDraftOperation): AppBuildDraft {
  switch (operation.type) {
    case 'set_name': {
      const name = operation.name.trim();
      if (!name) throw new Error('App name is required');
      return { ...draft, name };
    }
    case 'set_template': return { ...draft, template: operation.template };
    case 'set_frame': return { ...draft, frame: operation.frame };
    case 'set_source_policy': return { ...draft, sourcePolicy: operation.sourcePolicy };
    case 'set_requirements': return { ...draft, requirements: operation.requirements, coverage: operation.coverage ?? draft.coverage };
    case 'set_coverage': return { ...draft, coverage: operation.coverage };
    case 'upsert_source': return { ...draft, sources: upsertById(draft.sources, operation.source) };
    case 'remove_source': return {
      ...draft,
      sources: draft.sources.filter((source) => source.id !== operation.sourceId),
      coverage: draft.coverage.map((item) => ({ ...item, sourceIds: item.sourceIds.filter((id) => id !== operation.sourceId) })),
    };
    case 'upsert_page': {
      const normalized = normalizeEditedPage(operation.page);
      // `upsert_page` is the public mutation used by Studio and API callers.
      // A page created after an App filter exists must not silently become an
      // unfiltered escape hatch merely because it has no Dataset tile yet.
      if (draft.pages.some((page) => page.id === normalized.id)) {
        return { ...draft, pages: upsertById(draft.pages, normalized) };
      }
      return {
        ...draft,
        pages: [...draft.pages, inheritAppScopedFiltersForNewPage(draft.pages, normalized)],
      };
    }
    case 'remove_page': return { ...draft, pages: draft.pages.filter((page) => page.id !== operation.pageId) };
    case 'set_review_task': return { ...draft, reviewTasks: upsertById(draft.reviewTasks, operation.task) };
    case 'remove_review_task': return { ...draft, reviewTasks: draft.reviewTasks.filter((task) => task.id !== operation.taskId) };
    case 'set_preview_receipt': return {
      ...draft,
      previewReceipt: operation.receipt,
      previewReceipts: upsertReceiptByPage(
        draft.previewReceipts ?? (draft.previewReceipt ? [draft.previewReceipt] : []),
        operation.receipt,
      ),
    };
    case 'clear_preview_receipt': return clearPreviewReceiptForPage(draft, operation);
    default:
      return updatePage(draft, operation.pageId, (page) => {
        if (operation.type === 'add_tile') {
          if (page.layout.items.some((tile) => tile.i === operation.tile.i)) throw new Error(`Tile already exists: ${operation.tile.i}`);
          return { ...page, layout: { ...page.layout, items: [...page.layout.items, operation.tile] } };
        }
        if (operation.type === 'update_tile') {
          return { ...page, layout: { ...page.layout, items: page.layout.items.map((tile) => tile.i === operation.tileId ? { ...tile, ...operation.patch, i: tile.i } : tile) } };
        }
        if (operation.type === 'remove_tile') {
          // A story block that embedded the removed tile goes with it.
          const narrative = page.narrative
            ? { ...page.narrative, blocks: page.narrative.blocks.filter((block) => block.kind !== 'tile' || block.tileId !== operation.tileId) }
            : undefined;
          return { ...page, ...(narrative ? { narrative } : {}), layout: { ...page.layout, items: page.layout.items.filter((tile) => tile.i !== operation.tileId) } };
        }
        if (operation.type === 'set_canvas') {
          if (operation.canvas === null) {
            const { canvas: _removed, ...rest } = page;
            return rest;
          }
          const errors: string[] = [];
          const canvas = readDashboardCanvas(operation.canvas, new Set(page.layout.items.map((tile) => tile.i)), (message) => errors.push(message));
          if (!canvas) throw new Error(errors.join(' ') || 'The page markup is not valid.');
          return { ...page, canvas };
        }
        if (operation.type === 'set_narrative') {
          if (operation.narrative === null) {
            const { narrative: _removed, ...rest } = page;
            return rest;
          }
          const errors: string[] = [];
          const narrative = readDashboardNarrative(operation.narrative, new Set(page.layout.items.map((tile) => tile.i)), (message) => errors.push(message));
          if (!narrative) throw new Error(errors.join(' ') || 'The story is not valid.');
          return { ...page, narrative };
        }
        if (operation.type === 'set_filter') {
          return { ...page, filters: upsertById(page.filters ?? [], operation.filter) };
        }
        if (operation.type === 'remove_filter') {
          return { ...page, filters: (page.filters ?? []).filter((filter) => filter.id !== operation.filterId) };
        }
        if (operation.type === 'set_interactions') {
          return { ...page, ...(operation.interactions ? { interactions: operation.interactions } : { interactions: undefined }) };
        }
        return { ...page, layout: operation.layout };
      });
  }
}

function updatePage(draft: AppBuildDraft, pageId: string, update: (page: DashboardDocument) => DashboardDocument): AppBuildDraft {
  let found = false;
  const pages = draft.pages.map((page) => {
    if (page.id !== pageId) return page;
    found = true;
    return normalizeEditedPage(update(page));
  });
  if (!found) throw new Error(`Page not found: ${pageId}`);
  return { ...draft, pages };
}

/** A v1 page is upgraded only when an explicit App Studio edit reaches it. */
function normalizeEditedPage(page: DashboardDocument): DashboardDocument {
  // Tiles keep the cells their author gave them; only overlaps move, and
  // empty rows close (RFC 0008 step 5). Row-packing here used to discard
  // every free placement on save.
  const items = settleGridLayout(page.layout.items, 12);
  const fieldBased = page.version === 3 || Boolean(page.datasets?.length) || items.some((item) => Boolean(item.query));
  return {
    ...page,
    // Preserve v3 field bindings through ordinary local-draft edits. Legacy
    // v1/v2 pages remain readable until an explicit edit, as before.
    version: fieldBased ? 3 : 2,
    layout: {
      ...page.layout,
      items,
      responsive: projectResponsiveLayouts(items, page.layout.rowHeight),
    },
  };
}

/**
 * App-level filters are one logical control with page-qualified Dataset
 * bindings.  Copy the control into a new page through the server/reducer,
 * but start every Dataset binding as an explicit empty object.  The author
 * must later choose a real source/field/tile mapping; no field-name fallback
 * or inherited tile inclusion is permitted.
 *
 * Existing v1/v2 pages are deliberately left alone until an explicit edit
 * makes them v3. A newly created page is not legacy state, so a Dataset-bound
 * App filter upgrades it to v3 to retain its explicit empty binding across
 * persisted document parsing.
 */
function inheritAppScopedFiltersForNewPage(
  existingPages: DashboardDocument[],
  page: DashboardDocument,
): DashboardDocument {
  const appScoped = new Map<string, DashboardFilter>();
  for (const existing of existingPages) {
    for (const filter of existing.filters ?? []) {
      if (filter.scope?.app === true && !appScoped.has(filter.id)) appScoped.set(filter.id, filter);
    }
  }
  if (appScoped.size === 0) return page;

  const inheritedIds = new Set(appScoped.keys());
  const pageLocal = (page.filters ?? []).filter((filter) => !inheritedIds.has(filter.id));
  let requiresV3 = page.version === 3;
  const inherited = [...appScoped.values()].map((filter) => {
    const { datasetBindings: _datasetBindings, scope: _scope, ...logical } = filter;
    // `{}` is an explicit Dataset exclusion on a page that has not yet been
    // bound. Presence, rather than a populated mapping, is the authority.
    const isDatasetBound = filter.datasetBindings !== undefined;
    requiresV3 ||= isDatasetBound;
    return {
      ...logical,
      scope: { app: true },
      ...(isDatasetBound ? { datasetBindings: {} } : {}),
    };
  });
  return {
    ...page,
    ...(requiresV3 ? { version: 3 } : {}),
    filters: [...pageLocal, ...inherited],
  };
}

/**
 * Produce a compact, non-overlapping row layout while preserving the author's
 * visual reading order. App Studio uses this after every explicit edit so
 * imported or stale geometry can never place a tile outside the active grid.
 */
export function packDashboardLayoutItems(
  items: DashboardDocument['layout']['items'],
  cols: number,
): DashboardDocument['layout']['items'] {
  const columnCount = Math.max(1, Math.floor(cols));
  let x = 0;
  let y = 0;
  let currentRowHeight = 0;
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.y - right.item.y || left.item.x - right.item.x || left.index - right.index)
    .map(({ item }) => {
      const width = Math.min(columnCount, Math.max(1, Math.floor(item.w)));
      const height = Math.max(1, Math.floor(item.h));
      if (x + width > columnCount) {
        x = 0;
        y += currentRowHeight || height;
        currentRowHeight = 0;
      }
      const next = { ...item, x, y, w: width, h: height };
      x += width;
      currentRowHeight = Math.max(currentRowHeight, height);
      if (x >= columnCount) {
        x = 0;
        y += currentRowHeight;
        currentRowHeight = 0;
      }
      return next;
    });
}

function projectResponsiveLayouts(
  items: DashboardDocument['layout']['items'],
  rowHeight: number,
): NonNullable<DashboardDocument['layout']['responsive']> {
  const project = (cols: number): DashboardDocument['layout']['items'] => {
    const projected = items.map((item) => {
      const width = cols === 1 ? 1 : Math.min(cols, Math.max(2, Math.ceil(item.w / 2)));
      return { ...item, w: width };
    });
    return packDashboardLayoutItems(projected, cols);
  };
  return {
    wide: { kind: 'grid', cols: 12, rowHeight, items },
    medium: { kind: 'grid', cols: 6, rowHeight, items: project(6) },
    narrow: { kind: 'grid', cols: 1, rowHeight, items: project(1) },
  };
}

function upsertById<T extends { id: string }>(values: T[], next: T): T[] {
  return values.some((value) => value.id === next.id)
    ? values.map((value) => value.id === next.id ? next : value)
    : [...values, next];
}

function upsertReceiptByPage(values: AppBuildRunReceipt[], next: AppBuildRunReceipt): AppBuildRunReceipt[] {
  return values.some((value) => value.pageId === next.pageId)
    ? values.map((value) => value.pageId === next.pageId ? next : value)
    : [...values, next];
}

function clearPreviewReceiptForPage(
  draft: AppBuildDraft,
  operation: Extract<AppBuildDraftOperation, { type: 'clear_preview_receipt' }>,
): AppBuildDraft {
  const receipts = draft.previewReceipts ?? (draft.previewReceipt ? [draft.previewReceipt] : []);
  const existing = receipts.find((receipt) => receipt.pageId === operation.pageId);
  if (operation.expectedReceiptId !== undefined && existing?.id !== operation.expectedReceiptId) {
    throw new Error(`APP_BUILD_PREVIEW_RECEIPT_CONFLICT: page ${operation.pageId} no longer has the receipt observed by this preview.`);
  }
  if (!existing) return draft;
  const remaining = receipts.filter((receipt) => receipt.pageId !== operation.pageId);
  const next: AppBuildDraft = { ...draft };
  if (remaining.length > 0) next.previewReceipts = remaining;
  else delete next.previewReceipts;
  if (draft.previewReceipt?.pageId === operation.pageId) {
    const replacement = remaining.at(-1);
    if (replacement) next.previewReceipt = replacement;
    else delete next.previewReceipt;
  }
  return next;
}

function assertAppBuildDraftPolicy(draft: Omit<AppBuildDraft, 'proposalHash'> | AppBuildDraft): void {
  if (!draft.id.trim() || !draft.appId.trim()) throw new Error('App Build Draft requires id and appId');
  if (!draft.name.trim()) throw new Error('App Build Draft requires a name');
  if (!draft.frame.goal.trim()) throw new Error('App Build Frame requires a goal');
  const sourceIds = new Set<string>();
  for (const source of draft.sources) {
    if (sourceIds.has(source.id)) throw new Error(`Duplicate App source id: ${source.id}`);
    sourceIds.add(source.id);
    if (source.sourceRevision && source.sourceFingerprint && source.sourceRevision !== source.sourceFingerprint) {
      throw new Error(`Source ${source.id} has conflicting revision fingerprints`);
    }
  }
  for (const coverage of draft.coverage) {
    for (const sourceId of coverage.sourceIds) {
      if (!sourceIds.has(sourceId)) throw new Error(`Coverage ${coverage.requirementId} references missing source ${sourceId}`);
    }
  }
  assertAppScopedFilterConsistency(draft.pages);
  for (const page of draft.pages) {
    for (const tile of page.layout.items) {
      if (tile.sourceId && !sourceIds.has(tile.sourceId)) {
        throw new Error(`Tile ${page.id}/${tile.i} references missing source ${tile.sourceId}`);
      }
      if (tile.viz.style !== undefined) {
        const problems: string[] = [];
        readDashboardVizStyle(tile.viz.style, `Tile ${page.id}/${tile.i} viz.style`, (message) => problems.push(message));
        if (problems.length) throw new Error(problems.join('; '));
      }
      if (tile.viz.encoding !== undefined) {
        const problems: string[] = [];
        const encoding = readDashboardVizEncoding(tile.viz.encoding, `Tile ${page.id}/${tile.i} viz.encoding`, (message) => problems.push(message));
        if (encoding && !tile.query) problems.push(`Tile ${page.id}/${tile.i} viz.encoding needs a Dataset field query.`);
        if (encoding && tile.query) problems.push(...encodingQueryIssues(encoding, tile.query).map((issue) => `Tile ${page.id}/${tile.i}: ${issue}`));
        if (problems.length) throw new Error(problems.join('; '));
      }
      for (const [field, max] of [['description', MAX_TILE_DESCRIPTION], ['owner', MAX_TILE_OWNER]] as const) {
        const value = tile[field];
        if (value !== undefined && (typeof value !== 'string' || value.length > max)) {
          throw new Error(`Tile ${page.id}/${tile.i} ${field} must be text of at most ${max} characters.`);
        }
      }
      // Dataset field tiles are a v3-only contract. Existing v1/v2 drafts
      // retain their historic renderer semantics; new or edited v3 tiles
      // cannot persist a scalar visualization that would hide a selection.
      if (page.version === 3 && tile.query) {
        const visualization = datasetTileVisualizationCompatibility(tile.query, tile.viz.type);
        if (!visualization.compatible) {
          throw new Error(`Dataset tile ${page.id}/${tile.i} is incompatible with ${tile.viz.type}: ${visualization.message}`);
        }
      }
    }
  }
  if (draft.sourcePolicy === 'governed_only') {
    const reviewSource = draft.sources.find((source) =>
      (source.kind === 'block' && source.trustState !== 'certified')
      || source.kind === 'review_block'
      || source.kind === 'review_dql'
      || source.kind === 'exploratory_sql');
    if (reviewSource) throw new Error(`Source ${reviewSource.id} requires include_review_required policy`);
  }
}

/**
 * App-scoped dashboard filters are stored once per page so each page can keep
 * its own exact Dataset bindings and explicit exclusions. Their logical
 * control, however, is one App-owned contract. Reject shadowing or diverging
 * definitions here, after every non-UI as well as Studio mutation, rather
 * than relying on a browser to keep matching IDs aligned.
 */
function assertAppScopedFilterConsistency(pages: DashboardDocument[]): void {
  const byId = new Map<string, Array<{ pageId: string; filter: DashboardFilter }>>();
  for (const page of pages) {
    for (const filter of page.filters ?? []) {
      const entries = byId.get(filter.id) ?? [];
      entries.push({ pageId: page.id, filter });
      byId.set(filter.id, entries);
    }
  }
  for (const [id, entries] of byId) {
    if (!entries.some((entry) => entry.filter.scope?.app === true)) continue;
    if (entries.some((entry) => entry.filter.scope?.app !== true)) {
      throw new Error(`App-scoped filter ${id} cannot be shadowed by a page-local filter with the same id.`);
    }
    const expected = appScopedFilterDefinition(entries[0]!.filter);
    for (const entry of entries.slice(1)) {
      if (appScopedFilterDefinition(entry.filter) !== expected) {
        throw new Error(`App-scoped filter ${id} has conflicting definitions on pages ${entries[0]!.pageId} and ${entry.pageId}.`);
      }
    }
    // Older v1/v2 pages remain readable without a conversion on open. Every
    // v3 page, however, is a current Dataset-capable authoring surface and
    // must carry the App control so a direct operation cannot omit it.
    for (const page of pages) {
      if (page.version !== 3) continue;
      const pageFilter = page.filters?.find((filter) => filter.id === id);
      if (!pageFilter) {
        throw new Error(`App-scoped filter ${id} is missing from v3 page ${page.id}. Add the page through the governed App draft operation so it starts explicitly excluded.`);
      }
      if (pageFilter.scope?.app !== true) {
        throw new Error(`App-scoped filter ${id} cannot be shadowed by a page-local filter on v3 page ${page.id}.`);
      }
    }
  }
}

/** Dataset bindings are intentionally omitted: they are page-qualified. */
function appScopedFilterDefinition(filter: DashboardFilter): string {
  return JSON.stringify(canonicalAppBuildPreviewContent({
    id: filter.id,
    type: filter.type,
    label: filter.label,
    default: filter.default,
    options: filter.options,
    bindsTo: filter.bindsTo,
    field: filter.field,
    required: filter.required,
    multiple: filter.multiple,
    timezone: filter.timezone,
    optionSource: filter.optionSource,
    dependsOn: filter.dependsOn,
  }));
}
