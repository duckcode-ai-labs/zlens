import { tileQueryOutputAliases, type TileQuery } from '@zlens/core/apps/tile-query';
import type { QueryResult } from '../../../store/types';

/**
 * Sort and Top N live in one place: the tile query's `orderBy` and `limit`.
 * The measure pill's menu, the "Filters, sort and more" controls and the
 * default for a new bar chart all read and write those two fields, so they
 * always agree.
 */

export const TOP_N_CHOICES = [5, 10, 25] as const;

/** A bar chart with more categories than this shows only the top ones until the reader asks for all. */
export const BAR_CATEGORY_CAP_ABOVE = 50;
/** How many categories a capped bar chart shows. */
export const BAR_CATEGORY_CAP = 25;

type Direction = 'asc' | 'desc';

/** The tile query with its primary sort set to one output, or cleared from it. */
export function withSort(query: TileQuery, alias: string, direction: Direction | null): TileQuery {
  const others = (query.orderBy ?? []).filter((entry) => entry.alias.toLowerCase() !== alias.toLowerCase());
  const orderBy = direction ? [{ alias, direction }, ...others] : others;
  const { orderBy: _previous, ...rest } = query;
  return orderBy.length ? { ...rest, orderBy } : rest;
}

/**
 * "Show top N by this measure": sorted by the measure, highest first, and
 * capped at N rows. `null` shows every row again and keeps the sort.
 */
export function withTopN(query: TileQuery, alias: string, n: number | null): TileQuery {
  if (n === null) {
    const { limit: _limit, ...rest } = query;
    return rest;
  }
  const count = Math.max(1, Math.min(10_000, Math.round(n)));
  return { ...withSort(query, alias, 'desc'), limit: count };
}

/** The N of "Show top N" when the tile ranks by this measure, or null. */
export function topNFor(query: TileQuery, alias: string): number | null {
  const primary = query.orderBy?.[0];
  if (typeof query.limit !== 'number' || !primary || primary.direction !== 'desc') return null;
  return primary.alias.toLowerCase() === alias.toLowerCase() ? query.limit : null;
}

/** Top N needs something to rank: a category (not a date) and no period comparison or row detail. */
export function canShowTopN(query: TileQuery): boolean {
  if (query.detail || query.comparison) return false;
  return query.dimensions.some((dimension) => !dimension.timeGrain);
}

const BAR_TYPES = new Set(['bar', 'horizontal_bar', 'grouped_bar', 'stacked_bar', 'bar_chart']);

export function isBarVisualization(visualization: string | undefined): boolean {
  return BAR_TYPES.has(String(visualization ?? '').toLowerCase().replace(/-/g, '_'));
}

/**
 * A new bar chart sorts by its measure, highest first, so the biggest bars
 * lead. Only for a bar over categories (never dates), and only while the
 * query has no sort of its own.
 */
export function withDefaultBarSort(query: TileQuery, visualization: string | undefined): TileQuery {
  if (!isBarVisualization(visualization) || query.orderBy?.length || query.detail || query.comparison) return query;
  if (!query.dimensions.length || query.dimensions.some((dimension) => dimension.timeGrain)) return query;
  const measure = tileQueryOutputAliases(query).find((output) => output.kind === 'measure');
  return measure ? { ...query, orderBy: [{ alias: measure.alias, direction: 'desc' }] } : query;
}

/**
 * Whether the author chose a sort or a row cap in this change. A field
 * leaving the tile drops its sort with it; that is not a choice.
 */
export function sortTouched(previous: TileQuery, next: TileQuery): boolean {
  if (previous.limit !== next.limit) return true;
  const after = JSON.stringify(next.orderBy ?? []);
  if (JSON.stringify(previous.orderBy ?? []) === after) return false;
  const outputs = new Set(tileQueryOutputAliases(next).map((output) => output.alias.toLowerCase()));
  const kept = (previous.orderBy ?? []).filter((entry) => outputs.has(entry.alias.toLowerCase()));
  return JSON.stringify(kept) !== after;
}

export interface BarCategoryCap {
  /** The rows to draw. */
  result: QueryResult;
  /** Categories in the full result. */
  total: number;
  /** Categories drawn. */
  shown: number;
  /** Categories in the rows this tile holds (the first rows of a larger result hold fewer than total). */
  loaded: number;
  capped: boolean;
  /** More categories than the cap allows: the note can offer "Show all" or "Top 25". */
  cappable: boolean;
}

/**
 * A bar chart with more than 50 categories draws the top 25 until the
 * reader asks for all of them. The top ones follow the tile's own sort when
 * it has one; otherwise the largest values of the measure lead. A tile whose
 * author set a row limit is drawn as set.
 */
export function barCategoryCap(
  result: QueryResult,
  input: { chart: string | undefined; category?: string; value?: string; query?: TileQuery; showAll?: boolean },
): BarCategoryCap {
  const none = (total: number, cappable = false, loaded = total): BarCategoryCap => ({ result, total, shown: loaded, loaded, capped: false, cappable });
  if (!isBarVisualization(input.chart) || typeof input.query?.limit === 'number') return none(result.rows.length);
  const category = input.category && result.columns.includes(input.category)
    ? input.category
    : result.columns.find((column) => result.rows.some((row) => typeof row[column] === 'string'));
  if (!category) return none(result.rows.length);
  const order: string[] = [];
  const totals = new Map<string, number>();
  const value = input.value && result.columns.includes(input.value)
    ? input.value
    : result.columns.find((column) => column !== category && result.rows.some((row) => typeof row[column] === 'number'));
  for (const row of result.rows) {
    const key = String(row[category] ?? '');
    if (!totals.has(key)) { order.push(key); totals.set(key, 0); }
    const amount = value ? Number(row[value]) : 0;
    if (Number.isFinite(amount)) totals.set(key, totals.get(key)! + amount);
  }
  // A result that holds only the first rows of a larger one (one row per
  // category) counts every category the warehouse returned.
  const onePerCategory = order.length === result.rows.length;
  const total = onePerCategory && typeof result.rowCount === 'number' && result.rowCount > order.length ? result.rowCount : order.length;
  if (total <= BAR_CATEGORY_CAP_ABOVE) return none(total, false, order.length);
  if (input.showAll) return none(total, true, order.length);
  const ranked = input.query?.orderBy?.length || !value
    ? order
    : [...order].sort((left, right) => totals.get(right)! - totals.get(left)!);
  const keep = new Set(ranked.slice(0, BAR_CATEGORY_CAP));
  const rank = new Map(ranked.map((key, index) => [key, index]));
  const rows = result.rows
    .filter((row) => keep.has(String(row[category] ?? '')))
    .sort((left, right) => rank.get(String(left[category] ?? ''))! - rank.get(String(right[category] ?? ''))!);
  return { result: { ...result, rows }, total, shown: keep.size, loaded: order.length, capped: true, cappable: true };
}

/**
 * The chart settings that draw every bar the cap kept. Without this the chart
 * drew only its default first 20 categories under a "Showing top 25" note.
 * An author's own item limit stands.
 */
export function withBarCategoryLimit<T extends { maxItems?: number }>(config: T, cap: Pick<BarCategoryCap, 'shown'> | null | undefined): T {
  if (!cap || config.maxItems !== undefined || cap.shown <= 0) return config;
  return { ...config, maxItems: cap.shown };
}

/** "Showing top 25 of 935". */
export function barCapNote(cap: Pick<BarCategoryCap, 'shown' | 'total'>): string {
  return `Showing top ${cap.shown} of ${cap.total.toLocaleString('en-US')}`;
}
