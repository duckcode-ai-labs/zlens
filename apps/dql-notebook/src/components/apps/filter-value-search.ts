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
export type FilterValueSource = { sourceId: string; field: string };

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
): { sourceId: string; field: string; search: string } | null {
  const search = query.trim();
  if (!source || !search || !filterValuesCapped(list)) return null;
  return { sourceId: source.sourceId, field: source.field, search };
}

/** Ask the server for every value that contains the text. */
export async function searchFilterValues(
  request: { sourceId: string; field: string; search: string },
  fetchValues: typeof api.datasetFieldValues = (sourceId, field, options) => api.datasetFieldValues(sourceId, field, options),
): Promise<{ values: string[]; truncated: boolean; failed: boolean }> {
  const response = await fetchValues(request.sourceId, request.field, { search: request.search });
  return { values: response.ok ? response.values : [], truncated: Boolean(response.ok && response.truncated), failed: !response.ok };
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
  const key = request ? `${request.sourceId}\u0000${request.field}\u0000${request.search.toLowerCase()}` : '';
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
