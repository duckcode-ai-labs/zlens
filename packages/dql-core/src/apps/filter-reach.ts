/**
 * Whether a page filter applies to one tile, as the author decided it.
 *
 * Every data tile has one of three states for each page filter:
 * - `applies`        — linked: a Dataset field mapping that includes the
 *                      tile, a tile filter binding, or a parameter binding.
 * - `does_not_apply` — an explicit author choice, stored in the page file:
 *                      a tile `filterBindings` entry with
 *                      `capability: 'unsupported'` (or an older entry with
 *                      only `unsupportedReason`), a Dataset binding whose
 *                      `tileIds` leaves the tile out, or a filter `scope.tileIds`
 *                      that leaves it out.
 * - `unlinked`       — neither. Publishing asks the author to choose.
 *
 * Text and heading tiles carry no data and are `not_applicable`.
 *
 * Browser-safe: no Node imports. The shapes are structural so the notebook's
 * client types and the core document types both fit.
 */

/** The stored reason Studio writes when an author marks a tile "Does not apply". */
export const DASHBOARD_FILTER_DOES_NOT_APPLY_REASON = 'Author: does not apply';

export type DashboardTileFilterChoice = 'applies' | 'does_not_apply' | 'unlinked' | 'not_applicable';

type ReachFilterBinding = {
  filter: string;
  binding?: string;
  mode?: string;
  paramNames?: string[];
  capability?: string;
  unsupportedReason?: string;
};

type ReachParameterBinding = { param: string; source: string; filter?: string; field?: string };

export type DashboardFilterReachItem = {
  i: string;
  text?: unknown;
  viz?: { type?: string };
  query?: unknown;
  driver?: unknown;
  block?: unknown;
  semantic?: unknown;
  draftAnalysis?: unknown;
  aiPin?: unknown;
  sourceId?: string;
  sourceRevision?: string;
  filterBindings?: ReachFilterBinding[];
  parameterBindings?: ReachParameterBinding[];
};

export type DashboardFilterReachFilter = {
  id: string;
  scope?: { tileIds?: string[] };
  datasetBindings?: Record<string, { field: string; tileIds?: string[] }>;
};

export type DashboardFilterReachPage = {
  datasets?: Array<{ id: string; sourceId: string; sourceRevision: string }>;
};

/** Text and heading tiles never take a filter. */
export function isDashboardNarrativeTile(item: Pick<DashboardFilterReachItem, 'text' | 'viz'>): boolean {
  const viz = String(item.viz?.type ?? '');
  return Boolean(item.text) || viz === 'text' || viz === 'heading';
}

/** The tile's explicit "Does not apply" entry for a filter, if any. */
export function dashboardFilterDoesNotApplyBinding(
  item: Pick<DashboardFilterReachItem, 'filterBindings'>,
  filterId: string,
): ReachFilterBinding | undefined {
  // `unsupportedReason` alone is the older spelling of the same choice.
  return (item.filterBindings ?? []).find((binding) => binding.filter === filterId
    && (binding.capability === 'unsupported' || Boolean(binding.unsupportedReason?.trim())));
}

export function dashboardTileFilterChoice(
  page: DashboardFilterReachPage,
  item: DashboardFilterReachItem,
  filter: DashboardFilterReachFilter,
): { choice: DashboardTileFilterChoice; reason?: string } {
  if (isDashboardNarrativeTile(item)) return { choice: 'not_applicable' };
  if (filter.scope?.tileIds && !filter.scope.tileIds.includes(item.i)) {
    return { choice: 'does_not_apply', reason: 'This tile is outside the filter’s chosen tiles.' };
  }
  const explicit = dashboardFilterDoesNotApplyBinding(item, filter.id);
  if (explicit) return { choice: 'does_not_apply', reason: explicit.unsupportedReason?.trim() || DASHBOARD_FILTER_DOES_NOT_APPLY_REASON };
  if ((item.query || item.driver) && item.sourceId && item.sourceRevision) {
    const dataset = page.datasets?.find((candidate) => candidate.sourceId === item.sourceId && candidate.sourceRevision === item.sourceRevision);
    const binding = dataset ? filter.datasetBindings?.[dataset.id] : undefined;
    if (binding && (!binding.tileIds || binding.tileIds.includes(item.i))) return { choice: 'applies' };
    if (binding) return { choice: 'does_not_apply', reason: 'Excluded by this filter’s chosen tiles.' };
    return { choice: 'unlinked', reason: 'This Dataset is not mapped to this filter.' };
  }
  const linked = (item.filterBindings ?? []).find((binding) => binding.filter === filter.id
    && !binding.unsupportedReason
    && Boolean(binding.binding || binding.mode === 'parameter' || binding.paramNames?.length));
  if (linked) return { choice: 'applies' };
  const parameter = (item.parameterBindings ?? []).find((binding) => binding.source === 'dashboard_filter'
    && (binding.filter ?? binding.field ?? binding.param) === filter.id);
  if (parameter) return { choice: 'applies' };
  return { choice: 'unlinked' };
}
