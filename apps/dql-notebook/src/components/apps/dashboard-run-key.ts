/**
 * When an App page viewer runs its page (B1).
 *
 * The viewer used to run whenever it received a new `dashboard` object or a
 * new variables object, even when nothing a run reads had changed. Opening a
 * page with filters ran it twice: once with `{}` and again a moment later
 * with the filter defaults (`{ customer_name: '' }`), which select the same
 * rows. When the two requests reached the server out of order, the older one
 * cancelled the newer one and the reader was left on "superseded".
 *
 * The viewer now runs when its run key changes: the page revision (the page's
 * content, not its object identity) plus the effective filter values, viewer
 * filters, marks, drills and persona. Equal keys mean an equal run.
 */
import type { DashboardDocumentResponse } from '../../api/client';

type DashboardPage = DashboardDocumentResponse['dashboard'];

/** JSON with object keys sorted, so equal content gives an equal string. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'null';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/** A short, stable fingerprint of a string (FNV-1a, two lanes). */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/** The page's revision: its content, so a re-fetched copy of the same page is the same revision. */
export function dashboardPageRevision(page: DashboardPage): string {
  return fingerprint(stableStringify(page));
}

/** A filter value that selects nothing; the server treats these as "not filtered". */
export function isUnsetDashboardRunValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * The variables a run actually uses: the page's param and filter defaults,
 * then the viewer's values, with unset values dropped. This mirrors
 * `dashboardRuntimeVariables` on the server, so `{}` before the filter
 * defaults load and the defaults themselves are the same run.
 */
export function effectiveDashboardRunVariables(
  page: Pick<DashboardPage, 'params' | 'filters'>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const param of page.params ?? []) {
    if (param.default !== undefined) merged[param.id] = param.default;
  }
  for (const filter of page.filters ?? []) {
    if (filter.default !== undefined) merged[filter.id] = filter.default;
  }
  Object.assign(merged, variables);
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => !isUnsetDashboardRunValue(value)));
}

export interface DashboardRunKeyInput {
  appId: string;
  page: DashboardPage;
  /** dashboardPageRevision(page), when the caller already has it. */
  pageRevision?: string;
  variables: Record<string, unknown>;
  viewerFilters?: unknown;
  crossFilters?: unknown;
  hierarchyDrills?: unknown;
  persona?: string | null;
}

/** What a viewer's automatic run depends on. A new key is a new run; an equal key is the same run. */
export function dashboardRunKey(input: DashboardRunKeyInput): string {
  return stableStringify({
    appId: input.appId,
    dashboardId: input.page.id,
    pageRevision: input.pageRevision ?? dashboardPageRevision(input.page),
    variables: effectiveDashboardRunVariables(input.page, input.variables),
    viewerFilters: input.viewerFilters ?? [],
    crossFilters: input.crossFilters ?? [],
    hierarchyDrills: input.hierarchyDrills ?? [],
    persona: input.persona ?? null,
  });
}

/** How many times a viewer re-runs a page that came back stale before it shows the stale state. */
export const MAX_STALE_RERUNS = 2;

/**
 * Whether the viewer should run its page again by itself: the newest run came
 * back stale (superseded by a newer interaction, or the project changed while
 * it ran) and the bounded retries are not used up. A reader has no Run button,
 * so a stale page must never be the last thing they see.
 */
export function shouldRerunStaleDashboardRun(
  result: { stale?: boolean } | null | undefined,
  attempt: number,
): boolean {
  return Boolean(result?.stale) && attempt < MAX_STALE_RERUNS;
}
