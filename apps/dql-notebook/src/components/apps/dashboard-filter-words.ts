import { describeDashboardDateRange, formatDashboardCalendarDate } from '@zlens/core/apps/filter-dates';
import { formatBusinessLabel } from './app-text';

/**
 * One way to write a page filter and its value in words, shared by the filter
 * row, the summary story, the review appendix, tile receipts, Ask and
 * Research. A filter reads by its label ("Ordered At"), never its id, and a
 * value reads as a person would say it ("1 Jan 2025 – 30 Jun 2025",
 * "From 1 Jan 2025", "At least 500"), never as `[object Object]` or JSON.
 */

export type WordsDashboardFilter = { id?: string; type?: string; label?: string };

/** Keys that ride along with page variables but are not filters. */
const INTERNAL_VARIABLE = /^(smartView|persona|dashboardId|appId)$/i;

export function dashboardFilterLabel(id: string, filter?: WordsDashboardFilter | null): string {
  return filter?.label?.trim() || formatBusinessLabel(id);
}

const RELATIVE_DATE = /^(last_\d{1,4}_days|today|yesterday|month_to_date|quarter_to_date|year_to_date)$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/;

/**
 * A filter value in words, or `null` when the value applies nothing (empty,
 * an empty list, or a range with neither end).
 */
export function formatDashboardFilterValue(value: unknown, filter?: WordsDashboardFilter | null): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (RELATIVE_DATE.test(text)) {
      const words = text.replace(/_/g, ' ');
      return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
    }
    if (CALENDAR_DATE.test(text)) return formatDashboardCalendarDate(text.slice(0, 10));
    return text;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // A season or year reads 2024, not 2,024.
    if (filter?.id && /(season|year)/i.test(filter.id) && Number.isInteger(value) && value >= 1900 && value <= 2200) return String(value);
    return value.toLocaleString();
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return formatDashboardCalendarDate(value.toISOString().slice(0, 10));
  if (Array.isArray(value)) {
    if (filter?.type === 'daterange') return describeDashboardDateRange(value);
    const parts = value.map((item) => formatDashboardFilterValue(item, filter && { id: filter.id })).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const isRange = keys.length > 0 && keys.every((key) => ['start', 'end', 'from', 'to', 'min', 'max'].includes(key));
    if (isRange) {
      const ends = keys.map((key) => record[key]).filter((end) => end !== undefined && end !== null && end !== '');
      if (ends.length === 0) return null;
      if (filter?.type === 'number_range' || ends.every((end) => typeof end === 'number')) {
        const min = typeof record.min === 'number' ? record.min.toLocaleString() : undefined;
        const max = typeof record.max === 'number' ? record.max.toLocaleString() : undefined;
        if (min && max) return `${min} – ${max}`;
        if (min) return `At least ${min}`;
        if (max) return `At most ${max}`;
      }
      return describeDashboardDateRange(record);
    }
    const parts = keys.flatMap((key) => {
      const text = formatDashboardFilterValue(record[key]);
      return text ? [`${formatBusinessLabel(key)} ${text}`] : [];
    });
    return parts.length ? parts.join(', ') : null;
  }
  return String(value);
}

/**
 * The page filters that apply something, in words: label and value. Filters
 * the page declares read by their label; any other variable by its name made
 * readable. Internal keys and empty values are left out.
 */
export function describeDashboardFilterValues(
  variables: Record<string, unknown>,
  filters?: ReadonlyArray<WordsDashboardFilter & { id: string }> | null,
): Array<{ id: string; label: string; value: string }> {
  const byId = new Map((filters ?? []).map((filter) => [filter.id, filter]));
  return Object.entries(variables).flatMap(([id, value]) => {
    if (INTERNAL_VARIABLE.test(id) || id.startsWith('__')) return [];
    const filter = byId.get(id);
    const text = formatDashboardFilterValue(value, filter ?? { id });
    return text ? [{ id, label: dashboardFilterLabel(id, filter), value: text }] : [];
  });
}

/** "1 data source", "2 data sources". */
export function dataSourceCountWords(count: number): string {
  return `${count} data source${count === 1 ? '' : 's'}`;
}

/**
 * How many distinct data sources a page run read: two tiles on one Dataset
 * are one source, and text tiles read none. The story's evidence references
 * are not sources (one Dataset can be cited many times, or not at all).
 */
export function runDataSourceCount(tiles: ReadonlyArray<{
  tileType?: string;
  dataset?: { sourceId?: string };
  blockPath?: string;
  blockId?: string;
  artifact?: { name?: string; sourcePath?: string } | null;
  citation?: { name?: string; path?: string };
}>): number {
  const sources = new Set<string>();
  for (const tile of tiles) {
    if (tile.tileType === 'text') continue;
    const id = tile.dataset?.sourceId
      ?? tile.blockPath
      ?? tile.blockId
      ?? tile.artifact?.sourcePath
      ?? tile.artifact?.name
      ?? tile.citation?.path
      ?? tile.citation?.name;
    if (id) sources.add(id);
  }
  return sources.size;
}
