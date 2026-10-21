/**
 * Which App page run a viewer's request should get.
 *
 * One mounted viewer (one `runScope`) owns one supersession lane on the local
 * server: a newer interaction cancels the older one, so an old filter's rows
 * never paint over a new one. That rule broke a just-published App. The
 * viewer sent the same page run twice in quick succession (once before the
 * page's filter defaults were applied, once after), and when the requests
 * reached the server out of order the older one cancelled the newer. The
 * reader was left on "A newer dashboard interaction superseded this run."
 *
 * Two rules fix it, both decided here so they can be tested without a server:
 *
 * - The same request (same page revision, effective filter values, viewer
 *   filters, marks, scheduling bounds, person and project state) joins the
 *   run already in flight instead of cancelling it. Both callers get its
 *   result.
 * - A request the browser numbered as older than one the server has already
 *   seen for that viewer never cancels the newer run; it is answered as
 *   superseded straight away. A genuinely different, newer request still
 *   supersedes.
 */
import { createHash } from 'node:crypto';

export type DashboardRunAdmission =
  /** Join the identical run already in flight and answer with its result. */
  | { kind: 'reuse' }
  /** This request is older than one already seen for this viewer: answer it as superseded, cancel nothing. */
  | { kind: 'refuse_older' }
  /** Start a run; cancel the in-flight run of this viewer, if any. */
  | { kind: 'start'; supersedesPrior: boolean };

export interface DashboardRunAdmissionInput {
  /** The run in flight for this viewer scope, if any. */
  prior?: { requestKey?: string; sequence?: number } | undefined;
  /** The highest request number the server has seen for this viewer scope. */
  lastSequence?: number | undefined;
  /** This request's key (see dashboardRunRequestKey); absent when it may not be shared. */
  requestKey?: string | undefined;
  /** This request's number from the browser (monotonic per mounted viewer). */
  sequence?: number | undefined;
}

export function admitDashboardRun(input: DashboardRunAdmissionInput): DashboardRunAdmission {
  if (input.sequence !== undefined && input.lastSequence !== undefined && input.sequence < input.lastSequence) {
    return { kind: 'refuse_older' };
  }
  if (input.prior && input.requestKey && input.prior.requestKey === input.requestKey) {
    return { kind: 'reuse' };
  }
  return { kind: 'start', supersedesPrior: Boolean(input.prior) };
}

/** A browser request number: a non-negative safe integer, or nothing. */
export function parseDashboardRunSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A filter value that selects nothing. Every filter path treats these as
 * "not filtered" (`isEmptyDashboardFilterValue` in local-runtime and the
 * Dataset filters), so `{}` and `{ customer_name: '' }` are the same request.
 * Whitespace-only strings are kept: not every path trims them.
 */
export function isUnsetDashboardRunValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** Effective run variables with unset values dropped and keys in a stable order. */
export function normalizeDashboardRunVariables(variables: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(variables)
    .filter(([, value]) => !isUnsetDashboardRunValue(value))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
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

export interface DashboardRunRequestKeyInput {
  surface: string;
  appId: string;
  dashboardId: string;
  /** The page exactly as this run will read it (after the reader's view of it). */
  dashboard: unknown;
  /** The project snapshot the run is bound to. */
  snapshotId: string;
  /** Who the run is for: principal and App persona. */
  person: unknown;
  /** Page variables after defaults were applied. */
  variables: Record<string, unknown>;
  viewerFilters?: unknown;
  crossFilters?: unknown;
  datasetDrills?: unknown;
  tileId?: string;
  visibleTileIds?: unknown;
  affectedTileIds?: unknown;
  fullRun?: boolean;
  refresh?: boolean;
}

/**
 * The identity of what a run would compute. Two requests with the same key
 * return the same rows, story and trust, so one may answer for the other.
 */
export function dashboardRunRequestKey(input: DashboardRunRequestKeyInput): string {
  const { dashboard, variables, ...rest } = input;
  const pageRevision = createHash('sha256').update(JSON.stringify(canonical(dashboard))).digest('hex');
  return createHash('sha256').update(JSON.stringify(canonical({
    ...rest,
    pageRevision,
    variables: normalizeDashboardRunVariables(variables),
  }))).digest('hex');
}

/** A run's result, shared with requests that joined it. `null`: it ended without one. */
export interface SharedDashboardRunResponse {
  status: number;
  body: string;
}

/** A promise a joining request waits on, settled once by the run that owns it. */
export function sharedDashboardRunResponse(): {
  promise: Promise<SharedDashboardRunResponse | null>;
  settle: (response: SharedDashboardRunResponse | null) => void;
} {
  let resolve!: (response: SharedDashboardRunResponse | null) => void;
  let settled = false;
  const promise = new Promise<SharedDashboardRunResponse | null>((done) => { resolve = done; });
  return {
    promise,
    settle: (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    },
  };
}

/** What an older request is told: it was superseded, nothing ran, nothing was cancelled. */
export const DASHBOARD_RUN_SUPERSEDED_REASON = 'A newer dashboard interaction superseded this run. Results and story were invalidated; run the current dashboard again.';

export function supersededDashboardRunBody(appId: string, dashboardId: string): Record<string, unknown> {
  return {
    appId,
    dashboardId,
    tiles: [],
    facts: [],
    stale: true,
    staleCause: 'superseded',
    staleReason: DASHBOARD_RUN_SUPERSEDED_REASON,
  };
}
