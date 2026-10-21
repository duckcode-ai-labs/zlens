/**
 * How App page filters reach Metrics (semantic) tiles, and the per-tile
 * "what applied, what didn't" report every page run returns.
 *
 * Dataset tiles resolve their filters in datasets/dashboard-dataset-filters.ts
 * and Saved query / draft tiles through applyDashboardFiltersToBlockExecution
 * in local-runtime.ts. All of them use the one date rule in
 * @zlens/core (apps/filter-dates.ts).
 */
import {
  dashboardFilterDoesNotApplyBinding,
  dateRangeParts,
  isDashboardDateFilterType,
  isDashboardNarrativeTile,
  isEmptyDashboardDateValue,
  resolveDashboardDateFilter,
  type DashboardDocument,
  type DashboardGridItem,
} from '@zlens/core';

/**
 * Why a page filter did not narrow a tile.
 * - `no_value`       — the filter has no value right now (never shown to readers).
 * - `does_not_apply` — the author chose "Does not apply" for this tile.
 * - `not_linked`     — nobody linked the filter to this tile.
 * - `unsupported`    — linked, but this tile type cannot apply this kind of
 *                      filter (for example text search on MetricFlow).
 * - `invalid_value`  — the value could not become a condition.
 */
export type DashboardTileFilterSkipCode = 'no_value' | 'does_not_apply' | 'not_linked' | 'unsupported' | 'invalid_value';

export interface DashboardTileFilterSkip {
  filter: string;
  reason: string;
  code: DashboardTileFilterSkipCode;
}

export interface DashboardSemanticTileFilterResolution {
  filters: Array<{ dimension: string; operator: string; values: string[] }>;
  applied: Array<{ filter: string; binding: string; mode: 'semantic' }>;
  skipped: DashboardTileFilterSkip[];
}

type DashboardFilter = NonNullable<DashboardDocument['filters']>[number];

function isEmptyFilterValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return Array.isArray(value) && value.length === 0;
}

/** A date range with neither end set has no value, like an empty dropdown. */
function isEmptyPageFilterValue(filter: Pick<DashboardFilter, 'type'>, value: unknown): boolean {
  return isEmptyFilterValue(value) || (isDashboardDateFilterType(filter.type) && isEmptyDashboardDateValue(value));
}

function semanticLiteral(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Turn the page filters linked to one Metrics tile into semantic filters.
 *
 * A filter applies to any dimension the metric's model exposes — not only the
 * dimensions the tile groups by — so a KPI tile with no dimensions is still
 * filtered by `region`. Date filters follow the one date rule (`gte` start,
 * `lt` the day after the end); a number range is `gte`/`lte` (MetricFlow has no
 * BETWEEN). A range is never sent as `in`. Anything that cannot apply is
 * reported in `skipped` with a reason instead of being dropped silently.
 */
export function dashboardSemanticFiltersForTile(
  dashboard: Pick<DashboardDocument, 'filters'>,
  item: Pick<DashboardGridItem, 'i' | 'semantic' | 'filterBindings'>,
  dashboardValues: Record<string, unknown>,
  options: {
    /** Whether the tile's metrics can be filtered on this dimension. Defaults to the tile's own dimensions. */
    dimensionAvailable?: (dimension: string) => boolean;
    now?: Date;
  } = {},
): DashboardSemanticTileFilterResolution {
  const resolution: DashboardSemanticTileFilterResolution = { filters: [], applied: [], skipped: [] };
  if (!item.semantic) return resolution;
  const ownDimensions = new Set([...(item.semantic.dimensions ?? []), ...(item.semantic.timeDimension ? [item.semantic.timeDimension] : [])]);
  const dimensionAvailable = options.dimensionAvailable ?? ((dimension: string) => ownDimensions.has(dimension));
  const metricFlow = item.semantic.provider === 'metricflow';
  for (const filter of dashboard.filters ?? []) {
    const skip = (code: DashboardTileFilterSkipCode, reason: string) => resolution.skipped.push({ filter: filter.id, code, reason });
    if (filter.scope?.tileIds && !filter.scope.tileIds.includes(item.i)) {
      skip('does_not_apply', 'This tile is outside the filter’s chosen tiles.');
      continue;
    }
    const explicit = dashboardFilterDoesNotApplyBinding(item, filter.id);
    if (explicit) {
      skip('does_not_apply', explicit.unsupportedReason?.trim() || 'The author chose “Does not apply” for this tile.');
      continue;
    }
    const value = dashboardValues[filter.id];
    if (isEmptyPageFilterValue(filter, value)) {
      skip('no_value', 'no value supplied');
      continue;
    }
    const dimension = item.filterBindings?.find((candidate) => candidate.filter === filter.id && candidate.binding)?.binding;
    if (!dimension) {
      skip('not_linked', `${filter.label ?? filter.id} is not linked to this tile.`);
      continue;
    }
    if (!dimensionAvailable(dimension)) {
      skip('unsupported', `${dimension} is not a dimension of this tile’s metrics, so ${filter.label ?? filter.id} cannot filter it.`);
      continue;
    }
    const compiled = semanticConditions(filter, dimension, value, metricFlow, options.now);
    if ('skip' in compiled) {
      skip(compiled.skip, compiled.reason);
      continue;
    }
    resolution.filters.push(...compiled.filters);
    resolution.applied.push({ filter: filter.id, binding: dimension, mode: 'semantic' });
  }
  return resolution;
}

function semanticConditions(
  filter: DashboardFilter,
  dimension: string,
  value: unknown,
  metricFlow: boolean,
  now: Date | undefined,
): { filters: DashboardSemanticTileFilterResolution['filters'] } | { skip: DashboardTileFilterSkipCode; reason: string } {
  if (isDashboardDateFilterType(filter.type)) {
    const resolved = resolveDashboardDateFilter({ filterId: filter.label ?? filter.id, type: filter.type, value, timezone: filter.timezone, now });
    if (!resolved) return { skip: 'no_value', reason: 'no value supplied' };
    if (resolved.kind === 'error') return { skip: 'invalid_value', reason: resolved.message };
    // A one-sided range sends only its own side ("from" / "until").
    if (resolved.kind === 'explicit') {
      return { filters: [
        ...(resolved.start !== undefined ? [{ dimension, operator: 'gte', values: [semanticLiteral(resolved.start)] }] : []),
        ...(resolved.end !== undefined ? [{ dimension, operator: 'lte', values: [semanticLiteral(resolved.end)] }] : []),
      ] };
    }
    return { filters: [
      ...(resolved.bounds.startDate ? [{ dimension, operator: 'gte', values: [resolved.bounds.startDate] }] : []),
      ...(resolved.bounds.endExclusiveDate ? [{ dimension, operator: 'lt', values: [resolved.bounds.endExclusiveDate] }] : []),
    ] };
  }
  if (filter.type === 'number_range') {
    const range = dateRangeParts(value);
    if (!range) return { skip: 'invalid_value', reason: `${filter.label ?? filter.id} needs a lowest and a highest number.` };
    return { filters: [
      { dimension, operator: 'gte', values: [semanticLiteral(range.start)] },
      { dimension, operator: 'lte', values: [semanticLiteral(range.end)] },
    ] };
  }
  if (filter.type === 'search') {
    if (metricFlow) {
      return { skip: 'unsupported', reason: `MetricFlow cannot search inside text, so ${filter.label ?? filter.id} does not filter this Metrics tile.` };
    }
    const search = String(Array.isArray(value) ? value[0] ?? '' : value).trim();
    if (!search) return { skip: 'no_value', reason: 'no value supplied' };
    return { filters: [{ dimension, operator: 'contains', values: [search] }] };
  }
  const values = (Array.isArray(value) ? value : [value]).filter((entry) => !isEmptyFilterValue(entry)).map(semanticLiteral);
  if (values.length === 0) return { skip: 'no_value', reason: 'no value supplied' };
  return { filters: [{ dimension, operator: values.length > 1 ? 'in' : 'equals', values }] };
}

/** What one tile did with the page's filters, for readers and Studio. */
export interface DashboardTileFilterReport {
  /** Page filters (with a value) that narrowed this tile. */
  applied: string[];
  /** Page filters (with a value) that did not, with why. */
  notApplied: Array<{ filter: string; code: Exclude<DashboardTileFilterSkipCode, 'no_value'>; reason: string }>;
}

type ReportTile = {
  status?: string;
  tileType?: string;
  filters?: {
    applied?: Array<{ filter?: string }>;
    skipped?: Array<{ filter?: string; reason?: string; code?: string }>;
  };
  dataset?: { unboundFilters?: Array<{ filterId: string; code: string; message: string }> };
};

const SKIP_CODES = new Set<DashboardTileFilterSkipCode>(['no_value', 'does_not_apply', 'not_linked', 'unsupported', 'invalid_value']);

/**
 * Build one tile's filter report from what the server actually did with it.
 * Only declared page filters with a value are reported. Text tiles and tiles
 * that did not run return `undefined` (no pills).
 */
export function dashboardTileFilterReport(input: {
  dashboard: Pick<DashboardDocument, 'id' | 'filters'>;
  item: Pick<DashboardGridItem, 'i' | 'text' | 'viz' | 'query' | 'driver' | 'aiPin' | 'parameterBindings'>;
  tile: ReportTile;
  values: Record<string, unknown>;
}): DashboardTileFilterReport | undefined {
  if (isDashboardNarrativeTile(input.item) || input.tile.status !== 'ok') return undefined;
  const active = (input.dashboard.filters ?? []).filter((filter) => (
    !(filter.scope?.page && filter.scope.page !== input.dashboard.id) && !isEmptyPageFilterValue(filter, input.values[filter.id])
  ));
  const report: DashboardTileFilterReport = { applied: [], notApplied: [] };
  if (active.length === 0) return report;
  if (input.item.query || input.item.driver) {
    const unbound = new Map((input.tile.dataset?.unboundFilters ?? []).map((issue) => [issue.filterId, issue]));
    for (const filter of active) {
      if (filter.scope?.tileIds && !filter.scope.tileIds.includes(input.item.i)) {
        report.notApplied.push({ filter: filter.id, code: 'does_not_apply', reason: 'This tile is outside the filter’s chosen tiles.' });
        continue;
      }
      const issue = unbound.get(filter.id);
      if (!issue) report.applied.push(filter.id);
      else report.notApplied.push({ filter: filter.id, code: issue.code === 'DATASET_TILE_EXCLUDED' ? 'does_not_apply' : 'not_linked', reason: issue.message });
    }
    return report;
  }
  if (input.item.aiPin) {
    for (const filter of active) {
      const bound = (input.item.parameterBindings ?? []).some((binding) => binding.source === 'dashboard_filter'
        && (binding.filter ?? binding.field ?? binding.param) === filter.id);
      if (bound) report.applied.push(filter.id);
      else report.notApplied.push({ filter: filter.id, code: 'not_linked', reason: 'A saved insight takes page filters only through its parameters.' });
    }
    return report;
  }
  const applied = new Set((input.tile.filters?.applied ?? []).map((entry) => entry.filter).filter(Boolean) as string[]);
  const skipped = new Map((input.tile.filters?.skipped ?? []).filter((entry) => entry.filter).map((entry) => [entry.filter!, entry]));
  for (const filter of active) {
    if (applied.has(filter.id)) {
      report.applied.push(filter.id);
      continue;
    }
    const entry = skipped.get(filter.id);
    const code = entry?.code && SKIP_CODES.has(entry.code as DashboardTileFilterSkipCode)
      ? entry.code as DashboardTileFilterSkipCode
      : entry?.reason === 'no value supplied' ? 'no_value' : 'not_linked';
    if (code === 'no_value') continue;
    report.notApplied.push({ filter: filter.id, code, reason: entry?.reason ?? 'This tile did not apply this filter.' });
  }
  return report;
}

/**
 * Plain sentences for a tile's evidence drawer: which page filters applied
 * and which did not, with why. Filters without a value are left out.
 */
export function dashboardTileFilterExplanation(
  dashboard: Pick<DashboardDocument, 'filters'>,
  summary: { applied: Array<{ filter: string }>; skipped: Array<{ filter: string; reason: string; code?: string }> },
): string[] {
  const filters = new Map((dashboard.filters ?? []).map((filter) => [filter.id, filter]));
  const label = (id: string) => filters.get(id)?.label ?? id;
  const applied = [...new Set(summary.applied.map((entry) => entry.filter).filter((id) => filters.has(id)))];
  const notApplied = summary.skipped.filter((entry) => filters.has(entry.filter)
    && entry.code !== 'no_value' && entry.reason !== 'no value supplied');
  const lines: string[] = [];
  if (applied.length) lines.push(`Page filters applied: ${applied.map(label).join(', ')}.`);
  if (notApplied.length) {
    lines.push(`Page filters not applied: ${notApplied.map((entry) => `${label(entry.filter)} (${entry.reason.replace(/\.$/, '')})`).join('; ')}.`);
  }
  return lines;
}

/** True when every page filter that has a value applied to the tile. */
export function dashboardTileFiltersAllApplied(
  dashboard: Pick<DashboardDocument, 'filters'>,
  summary: { skipped: Array<{ filter: string; reason: string; code?: string }> },
): boolean {
  const declared = new Set((dashboard.filters ?? []).map((filter) => filter.id));
  return !summary.skipped.some((entry) => declared.has(entry.filter) && entry.code !== 'no_value' && entry.reason !== 'no value supplied');
}

/**
 * The page values one tile may see. A filter the author marked "Does not
 * apply" for this tile (or whose `scope.tileIds` leaves it out) is removed, so
 * it cannot reach the tile through a block parameter of the same name.
 */
export function dashboardValuesForTile(
  dashboard: Pick<DashboardDocument, 'filters'>,
  item: Pick<DashboardGridItem, 'i' | 'filterBindings'>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const excluded = (dashboard.filters ?? []).filter((filter) => (
    (filter.scope?.tileIds && !filter.scope.tileIds.includes(item.i))
    || Boolean(dashboardFilterDoesNotApplyBinding(item, filter.id))
  ));
  if (excluded.length === 0) return values;
  const next = { ...values };
  for (const filter of excluded) delete next[filter.id];
  return next;
}

/** Only the page filters' own values, keyed by filter id, for one tile. */
export function dashboardFilterValuesForTile(
  dashboard: Pick<DashboardDocument, 'filters'>,
  item: Pick<DashboardGridItem, 'i' | 'filterBindings'>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const scoped = dashboardValuesForTile(dashboard, item, values);
  return Object.fromEntries((dashboard.filters ?? [])
    .filter((filter) => Object.prototype.hasOwnProperty.call(scoped, filter.id))
    .map((filter) => [filter.id, scoped[filter.id]]));
}
