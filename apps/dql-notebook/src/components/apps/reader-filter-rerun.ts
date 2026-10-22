import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import { filterLinkedTileIds } from './app-studio-filter-values';

type Page = DashboardDocumentResponse['dashboard'];
type RunTile = DashboardRunResponse['tiles'][number];

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function isEmptyFilterValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const range = value as { start?: unknown; end?: unknown };
    if ('start' in range || 'end' in range) return !range.start && !range.end;
  }
  return false;
}

/** The page filters whose value differs between two sets of values. */
export function changedFilterIds(previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].filter((key) => !sameValue(previous[key], next[key])).sort();
}

/**
 * After a reader changes filter values, which tiles run again (round 3): the
 * tiles linked to each changed filter, the way App Studio re-runs a page
 * since #148. Every other tile keeps its result. Undefined runs the whole
 * page: nothing changed, a changed value is not one of this page's filters,
 * or no tile is linked to it.
 */
export function filterChangeRerunTileIds(page: Page, previous: Record<string, unknown>, next: Record<string, unknown>): string[] | undefined {
  const changed = changedFilterIds(previous, next);
  if (!changed.length) return undefined;
  const filters = new Set((page.filters ?? []).map((filter) => filter.id));
  const tiles = new Set<string>();
  for (const filterId of changed) {
    if (!filters.has(filterId)) return undefined;
    for (const tileId of filterLinkedTileIds(page, filterId)) tiles.add(tileId);
  }
  return tiles.size ? [...tiles].sort() : undefined;
}

/**
 * A tile that did not run again keeps its result, but what it says about the
 * changed filters must be current: a filter that now has a value and does not
 * reach the tile reads "Not filtered by …"; a filter that was cleared says
 * nothing. The server only reports filters with a value, so a tile whose
 * result predates the value would otherwise say nothing about it.
 */
export function withUnrunTileFilterNotices(input: {
  run: DashboardRunResponse;
  page: Page;
  changedFilterIds: string[];
  values: Record<string, unknown>;
  executedTileIds: string[];
}): DashboardRunResponse {
  const executed = new Set(input.executedTileIds);
  const changed = new Set(input.changedFilterIds);
  if (!changed.size) return input.run;
  const labelOf = (filterId: string) => input.page.filters?.find((filter) => filter.id === filterId)?.label?.trim() || filterId;
  const items = new Map(input.page.layout.items.map((item) => [item.i, item]));
  const tiles = input.run.tiles.map((tile): RunTile => {
    if (executed.has(tile.tileId) || tile.status !== 'ok') return tile;
    const item = items.get(tile.tileId);
    if (!item || item.text) return tile;
    const now = [...changed].filter((filterId) => !isEmptyFilterValue(input.values[filterId]));
    const message = (filterId: string) => `${labelOf(filterId)} is not linked to this tile.`;
    if (tile.dataset) {
      const kept = (tile.dataset.unboundFilters ?? []).filter((issue) => !changed.has(issue.filterId));
      const added = now.map((filterId) => ({ filterId, code: 'FILTER_MAPPING_MISSING', message: message(filterId) }));
      return { ...tile, dataset: { ...tile.dataset, unboundFilters: [...kept, ...added] } } as RunTile;
    }
    if (tile.filterReport) {
      const report = tile.filterReport;
      return {
        ...tile,
        filterReport: {
          applied: report.applied.filter((filterId) => !changed.has(filterId)),
          notApplied: [
            ...report.notApplied.filter((entry) => !changed.has(entry.filter)),
            ...now.map((filterId) => ({ filter: filterId, code: 'not_linked' as const, reason: message(filterId) })),
          ],
        },
      } as RunTile;
    }
    return tile;
  });
  return { ...input.run, tiles };
}
