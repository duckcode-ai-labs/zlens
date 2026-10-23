import { useEffect, useState } from 'react';
import { api } from '../../api/client';

/**
 * Searching a filter's values when the list is capped.
 *
 * A Dataset field's values load one page at a time (the first 200 for
 * browsing). Searching only that page made a customer past the first 200
 * look missing ("No matching values" for Lori Butler). When the list is
 * capped, typed text is searched on the server over every value of the
 * governed field; an uncapped list is matched in the browser. The editor's
 * dropdown and the reader's control share this.
 */
export type FilterValueSource =
  /** A governed Dataset field (`/api/app-datasets/field-values`). */
  | { sourceId: string; field: string }
  /** A saved query's output column (`/api/dashboard/filter-options`): the reader's ad-hoc "Filter by…" picker. */
  | { blockId: string; column: string };

/** A server search: the source plus the typed text. */
export type FilterValueSearchRequest = FilterValueSource & { search: string };

function sourceKey(source: FilterValueSource): string {
  return 'sourceId' in source ? `dataset\u0000${source.sourceId}\u0000${source.field}` : `block\u0000${source.blockId}\u0000${source.column}`;
}

export type FilterValueList = {
  values: string[];
  truncated?: boolean;
  /** How many values the field has, when the server counted them. */
  valueCount?: number;
  valueCountCapped?: boolean;
};

/** Whether the loaded values are only part of the field's values. */
export function filterValuesCapped(list: FilterValueList): boolean {
  return Boolean(list.truncated) || (typeof list.valueCount === 'number' && list.valueCount > list.values.length);
}

/**
 * The note under a capped list: "Type to search all 930 values". `null` when
 * every value is already listed.
 */
export function filterValueCapHint(list: FilterValueList): string | null {
  if (!filterValuesCapped(list)) return null;
  if (typeof list.valueCount === 'number' && list.valueCount > list.values.length) {
    return `Type to search all ${list.valueCount.toLocaleString('en-US')}${list.valueCountCapped ? '+' : ''} values`;
  }
  return 'Type to search all values';
}

/** Values in `values` that contain `query`, ignoring case. */
export function matchFilterValues(values: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return needle ? values.filter((value) => value.toLowerCase().includes(needle)) : values;
}

export type FilterValueSearchState = {
  /** What to list for the current text. */
  values: string[];
  /** A server search for the current text is in flight. */
  searching: boolean;
  /** The server found more matches than it returned. */
  truncated: boolean;
  /** The server search failed; the list falls back to the loaded values. */
  failed: boolean;
};

/**
 * The server request for typed text, or `null` when the loaded values are
 * enough (no text, no Dataset source, or every value already loaded).
 */
export function filterValueSearchRequest(
  source: FilterValueSource | undefined,
  list: FilterValueList,
  query: string,
): FilterValueSearchRequest | null {
  const search = query.trim();
  if (!source || !search || !filterValuesCapped(list)) return null;
  return 'sourceId' in source
    ? { sourceId: source.sourceId, field: source.field, search }
    : { blockId: source.blockId, column: source.column, search };
}

/** Ask the server for every value that contains the text. */
export async function searchFilterValues(
  request: FilterValueSearchRequest,
  fetchValues: typeof api.datasetFieldValues = (sourceId, field, options) => api.datasetFieldValues(sourceId, field, options),
  fetchBlockValues: typeof api.dashboardFilterOptions = (block, column, options) => api.dashboardFilterOptions(block, column, options),
): Promise<{ values: string[]; truncated: boolean; failed: boolean }> {
  if ('blockId' in request) {
    const response = await fetchBlockValues(request.blockId, request.column, { search: request.search, limit: FILTER_VALUE_PAGE });
    return { values: response?.options ?? [], truncated: Boolean(response?.truncated), failed: !response };
  }
  const response = await fetchValues(request.sourceId, request.field, { search: request.search });
  return { values: response.ok ? response.values : [], truncated: Boolean(response.ok && response.truncated), failed: !response.ok };
}

/** How many values one request lists for browsing or a search. */
export const FILTER_VALUE_PAGE = 200;

/**
 * A saved query column's first page of values and how many exist, for the
 * reader's "Filter by…" picker. `null` when the server cannot list them (the
 * picker then offers the values the tiles returned).
 */
export async function loadBlockFilterValues(
  source: { blockId: string; column: string },
  fetchBlockValues: typeof api.dashboardFilterOptions = (block, column, options) => api.dashboardFilterOptions(block, column, options),
): Promise<FilterValueList | null> {
  const response = await fetchBlockValues(source.blockId, source.column, { limit: FILTER_VALUE_PAGE });
  if (!response) return null;
  return {
    values: response.options,
    truncated: response.truncated,
    ...(response.valueCount !== undefined ? { valueCount: response.valueCount } : {}),
    ...(response.valueCountCapped ? { valueCountCapped: true } : {}),
  };
}

/**
 * The values to list for `query`. With a capped list and a Dataset source,
 * the server is asked (after a short pause in typing) for every value that
 * contains the text; until it answers, the loaded matches are shown.
 */
export function useFilterValueSearch(
  source: FilterValueSource | undefined,
  list: FilterValueList,
  query: string,
  delayMs = 250,
): FilterValueSearchState {
  const request = filterValueSearchRequest(source, list, query);
  const key = request ? `${sourceKey(request)}\u0000${request.search.toLowerCase()}` : '';
  const [result, setResult] = useState<{ key: string; values: string[]; truncated: boolean; failed: boolean } | null>(null);
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchFilterValues(request).then((found) => { if (!cancelled) setResult({ key, ...found }); });
    }, delayMs);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, delayMs]);
  const local = matchFilterValues(list.values, query);
  if (!request) return { values: local, searching: false, truncated: false, failed: false };
  if (!result || result.key !== key) return { values: local, searching: true, truncated: false, failed: false };
  if (result.failed) return { values: local, searching: false, truncated: false, failed: true };
  return { values: Array.from(new Set([...result.values, ...local])), searching: false, truncated: result.truncated, failed: false };
}
