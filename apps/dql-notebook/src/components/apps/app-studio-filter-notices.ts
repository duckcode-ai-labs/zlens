import {
  DASHBOARD_FILTER_DOES_NOT_APPLY_REASON,
  dashboardTileFilterChoice,
  isDashboardNarrativeTile,
  type DashboardFilterReachFilter,
  type DashboardFilterReachItem,
  type DashboardFilterReachPage,
} from '@zlens/core/apps/filter-reach';
import { isDashboardDateFilterType, isEmptyDashboardDateValue } from '@zlens/core/apps/filter-dates';
import type { DashboardRunResponse } from '../../api/client';
import { plainSourceText } from './source-names';

type RunTile = DashboardRunResponse['tiles'][number];

export type StudioFilterNoticeFilter = DashboardFilterReachFilter & { label?: string; type?: string };

export type StudioTileFilterNotice = {
  key: string;
  filterId: string;
  /** "Not filtered by Customer Name" */
  label: string;
  /** Why, in plain words. */
  detail: string;
};

/**
 * The "Not filtered by …" notices one tile shows in App Studio, in Edit and
 * in Preview, so an author sees what readers will: a selected customer next
 * to a revenue KPI the customer filter does not reach is visibly marked.
 *
 * For a filter with a value, the run's own word wins: the server's
 * `filterReport` (or a Dataset tile's `unboundFilters`) says which page
 * filters actually applied. A filter change re-runs only the linked tiles, so
 * an unlinked tile's last result may predate the value; when the run does not
 * mention a filter, the page's stored choice stands in (the same rule the
 * reader uses before its first run).
 *
 * Preview shows notices only for filters that have a value, as readers see
 * them. Edit also shows filters without a value, so the author sees each
 * tile's reach while building.
 */
export function studioTileFilterNotices(input: {
  page: DashboardFilterReachPage & { filters?: StudioFilterNoticeFilter[] };
  tile: DashboardFilterReachItem;
  run?: RunTile | null;
  values: Record<string, unknown>;
  mode: 'edit' | 'preview';
}): StudioTileFilterNotice[] {
  const { page, tile, run, values, mode } = input;
  if (isDashboardNarrativeTile(tile)) return [];
  const report = run?.status === 'ok' ? run.filterReport : undefined;
  const unbound = new Map((run?.status === 'ok' ? run.dataset?.unboundFilters ?? [] : []).map((issue) => [issue.filterId, issue]));
  const notices: StudioTileFilterNotice[] = [];
  for (const filter of page.filters ?? []) {
    const active = !isEmptyStudioFilterValue(filter, values[filter.id]);
    if (!active && mode === 'preview') continue;
    const name = filter.label?.trim() || humanizeFilterId(filter.id);
    const notice = (reason: string | undefined, code: string) => notices.push({
      key: `${filter.id}:${code}`,
      filterId: filter.id,
      label: `Not filtered by ${name}`,
      detail: noticeDetail(reason, name, code),
    });
    if (active && report) {
      if (report.applied.includes(filter.id)) continue;
      const skipped = report.notApplied.find((entry) => entry.filter === filter.id);
      if (skipped) { notice(skipped.reason, skipped.code); continue; }
    }
    if (active && !report && unbound.has(filter.id)) {
      const issue = unbound.get(filter.id)!;
      notice(issue.message, issue.code === 'DATASET_TILE_EXCLUDED' ? 'does_not_apply' : 'not_linked');
      continue;
    }
    const choice = dashboardTileFilterChoice(page, tile, filter);
    if (choice.choice === 'applies' || choice.choice === 'not_applicable') continue;
    // An unlinked tile gets the plain sentence, not the document's wording.
    notice(choice.choice === 'does_not_apply' ? choice.reason : undefined, choice.choice === 'does_not_apply' ? 'does_not_apply' : 'not_linked');
  }
  return notices;
}

/** A filter has no value: empty, an empty list, or a date range with neither end. */
export function isEmptyStudioFilterValue(filter: { type?: string }, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (isDashboardDateFilterType(filter.type)) return isEmptyDashboardDateValue(value);
  if (filter.type === 'number_range' && value && typeof value === 'object') {
    const range = value as { min?: unknown; max?: unknown };
    return (range.min === undefined || range.min === null || range.min === '') && (range.max === undefined || range.max === null || range.max === '');
  }
  return false;
}

function noticeDetail(reason: string | undefined, name: string, code: string): string {
  const text = reason?.trim();
  if (!text || text === DASHBOARD_FILTER_DOES_NOT_APPLY_REASON) {
    return code === 'does_not_apply'
      ? `This tile is set to “Does not apply” for ${name}, so it shows every value.`
      : `This tile isn’t linked to ${name}, so it shows every value.`;
  }
  return plainSourceText(text);
}

function humanizeFilterId(id: string): string {
  return id.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
}
