import { describeDashboardDateRange, formatDashboardCalendarDate } from '@zlens/core/apps/filter-dates';
import type { AppStudioBuildDraft } from '../../api/client';

/** What App Studio knows about a filter field's values from the last run. */
export type StudioFilterValueAvailability = {
  valueCount?: number;
  dateRange?: { min: string; max: string };
};

/**
 * The value a filter control stores. A date range keeps only the ends that
 * are set: one end is a "from" / "until" range, and none clears the filter.
 */
export function studioFilterValue(filter: { type?: string }, value: unknown): unknown {
  if (filter.type !== 'daterange' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const range = value as { start?: unknown; end?: unknown };
  const start = typeof range.start === 'string' && range.start.trim() ? range.start : undefined;
  const end = typeof range.end === 'string' && range.end.trim() ? range.end : undefined;
  if (!start && !end) return undefined;
  return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

/**
 * What a date control says under its inputs. A date control never needs a
 * list of values: the chosen range (or what dates exist, once a run has read
 * them) is all it shows, and "no values" only when a run read the field and
 * found none.
 */
export function studioDateControlHint(input: {
  type: 'date' | 'daterange';
  value: unknown;
  availability?: StudioFilterValueAvailability;
}): { text: string; empty: boolean } {
  if (input.type === 'daterange') {
    const chosen = describeDashboardDateRange(input.value);
    if (chosen) return { text: chosen, empty: false };
  } else if (typeof input.value === 'string' && input.value.trim()) {
    return { text: `On ${formatDashboardCalendarDate(input.value.trim())}`, empty: false };
  }
  if (input.availability?.dateRange) {
    return { text: `Data from ${formatDashboardCalendarDate(input.availability.dateRange.min)} to ${formatDashboardCalendarDate(input.availability.dateRange.max)}`, empty: false };
  }
  if (input.availability?.valueCount === 0) return { text: 'This field has no dates in the current result', empty: true };
  return { text: input.type === 'daterange' ? 'Any date · set a start, an end, or both' : 'Any date', empty: false };
}


/**
 * The tiles on one page whose result a filter's value can change: Dataset
 * tiles mapped through the filter's Dataset binding, and Saved query / Metrics /
 * draft tiles with a supported link or a parameter bound to the filter. A
 * change to the filter re-runs exactly these tiles; every other tile keeps its
 * result.
 */
export function filterLinkedTileIds(page: AppStudioBuildDraft['pages'][number], filterId: string): string[] {
  const filter = page.filters?.find((candidate) => candidate.id === filterId);
  if (!filter) return [];
  return page.layout.items.filter((tile) => {
    if (filter.scope?.tileIds && !filter.scope.tileIds.includes(tile.i)) return false;
    if ((tile.query || tile.driver) && tile.sourceId && tile.sourceRevision) {
      return Boolean(page.datasets?.some((dataset) => {
        if (dataset.sourceId !== tile.sourceId || dataset.sourceRevision !== tile.sourceRevision) return false;
        const binding = filter.datasetBindings?.[dataset.id];
        return Boolean(binding && (!binding.tileIds || binding.tileIds.includes(tile.i)));
      }));
    }
    if (tile.parameterBindings?.some((binding) => binding.filter === filterId)) return true;
    return tile.filterBindings?.some((binding) => binding.filter === filterId && binding.capability !== 'unsupported') ?? false;
  }).map((tile) => tile.i);
}

/**
 * How App Studio re-runs a page after one filter changed:
 * - `tiles`: only the linked tiles, keeping every other tile's result;
 * - `page`: the whole page, when nothing settled is there to keep yet;
 * - `none`: the filter reaches no tile on this page.
 */
export function studioFilterRunPlan(input: {
  page: AppStudioBuildDraft['pages'][number];
  filterId: string;
  hasSettledPreview: boolean;
}): { kind: 'none' } | { kind: 'page' } | { kind: 'tiles'; tileIds: string[] } {
  const tileIds = filterLinkedTileIds(input.page, input.filterId);
  if (tileIds.length === 0) return { kind: 'none' };
  if (!input.hasSettledPreview) return { kind: 'page' };
  return { kind: 'tiles', tileIds };
}
