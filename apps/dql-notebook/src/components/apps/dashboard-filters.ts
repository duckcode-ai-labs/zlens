import type { DashboardDocumentResponse } from '../../api/client';

type DashboardFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number];
type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];

export function deriveDashboardFilters(dashboard: DashboardDocumentResponse['dashboard'] | null): DashboardFilter[] {
  // UI-001, E2E-001: only predicate/output bindings may drive distinct-value probes.
  if (!dashboard) return [];
  const filters = new Map<string, DashboardFilter>();
  for (const filter of dashboard.filters ?? []) {
    // Predicate bindings below can supply a source block and server-owned
    // distinct options. Keep the declaration until those bindings have been
    // inspected; filtering it here hides valid option-less select controls.
    filters.set(filter.id, { ...filter });
  }
  const blockIdOf = (item: DashboardLayoutItem): string | undefined =>
    item.block?.blockId ?? item.block?.ref;
  for (const item of dashboard.layout.items ?? []) {
    const bid = blockIdOf(item);
    for (const binding of item.filterBindings ?? []) {
      const mode = binding.mode ?? (binding.binding ? 'predicate' : undefined);
      if (!bid || mode !== 'predicate' || !binding.binding || binding.unsupportedReason) continue;
      const existing = filters.get(binding.filter);
      if (!existing) continue;
      if (!existing.bindsTo) existing.bindsTo = binding.binding;
      if (!(existing as { sourceBlockId?: string }).sourceBlockId) {
        (existing as { sourceBlockId?: string }).sourceBlockId = bid;
      }
    }
    for (const binding of item.parameterBindings ?? []) {
      const id = binding.filter || binding.field || binding.param;
      if (!id) continue;
      if (filters.has(id)) continue;
      if (isCoveredByExistingDashboardFilter(filters, binding)) continue;
      filters.set(id, filterFromParameterBinding(binding));
    }
  }
  return Array.from(filters.values()).filter(isUsefulDashboardFilter);
}

export type DashboardFilterCoverage = {
  filterId: string;
  /** Tiles the filter actually narrows. */
  applied: string[];
  /** Tiles it leaves showing everything, with the reason when one is recorded. */
  unaffected: Array<{ tileId: string; title?: string; reason?: string }>;
  /** Tiles that could be filtered at all — text and heading tiles are excluded. */
  filterable: number;
};

/**
 * Which tiles a global filter actually reaches.
 *
 * A filter that narrows two of five tiles looks identical on screen to one that
 * narrows all five: `unsupportedReason` was only ever used to drop a binding
 * from the derived list, never shown. That silence is the dangerous part — you
 * filter to one customer, half the tiles keep showing everyone, and the
 * dashboard reads as if it were all one scope.
 */
export function dashboardFilterCoverage(
  dashboard: DashboardDocumentResponse['dashboard'] | null,
  filterId: string,
  run?: {
    tiles?: Array<{ tileId?: string; filterableColumns?: Array<{ column: string }> }>;
  } | null,
): DashboardFilterCoverage {
  const items = (dashboard?.layout.items ?? []).filter((item) => !isNarrativeTile(item));
  // A filter the author never declared has no `filterBindings` anywhere, so its
  // reach has to come from the tiles that reported the column as filterable.
  // Reading only the document would report "reaches no tile" for every column a
  // viewer picks, immediately before the page filters correctly.
  const declaredFilter = (dashboard?.filters ?? []).find((filter) => filter.id === filterId);
  const declared = Boolean(declaredFilter);
  if (!declared && run) {
    const offering = new Set(
      (run.tiles ?? [])
        .filter((tile) => (tile.filterableColumns ?? []).some((candidate) => candidate.column === filterId))
        .map((tile) => tile.tileId)
        .filter((tileId): tileId is string => Boolean(tileId)),
    );
    // A control derived from a tile's parameter binding (Season Start → the
    // block's season_start parameter) narrows that tile even though no result
    // column carries its name. Without this, every parameter control read
    // "affects 0 of N tiles" while it was in fact driving the tile.
    for (const item of items) {
      if ((item.parameterBindings ?? []).some((binding) => (
        (binding.filter || binding.field || binding.param) === filterId && Boolean(binding.param)
      ))) offering.add(item.i);
    }
    return {
      filterId,
      applied: items.filter((item) => offering.has(item.i)).map((item) => item.i),
      unaffected: items.filter((item) => !offering.has(item.i)).map((item) => ({
        tileId: item.i,
        title: item.title,
        reason: 'This tile has no parameter bound to this filter and returns no column it can filter.',
      })),
      filterable: items.length,
    };
  }
  const applied: string[] = [];
  const unaffected: DashboardFilterCoverage['unaffected'] = [];
  for (const item of items) {
    // Field-query tiles use the exact Dataset binding rather than a matching
    // result-column name. A selected component subset is a durable authored
    // scope, so surface an exclusion instead of claiming page-wide coverage.
    // A driver tile's comparisons run on its Dataset with the same bindings.
    const dataset = (item.query || item.driver) && item.sourceId && item.sourceRevision
      ? dashboard?.datasets?.find((candidate) => (
        candidate.sourceId === item.sourceId && candidate.sourceRevision === item.sourceRevision
      ))
      : undefined;
    if (dataset) {
      const datasetBinding = declaredFilter?.datasetBindings?.[dataset.id];
      if (datasetBinding && (!datasetBinding.tileIds || datasetBinding.tileIds.includes(item.i))) {
        applied.push(item.i);
      } else {
        unaffected.push({
          tileId: item.i,
          title: item.title,
          reason: datasetBinding
            ? 'Excluded by this filter’s linked-component selection.'
            : 'This data is not mapped to this filter.',
        });
      }
      continue;
    }
    const binding = (item.filterBindings ?? []).find((candidate) => candidate.filter === filterId)
      ?? (item.parameterBindings ?? []).find((candidate) => (candidate.filter || candidate.field || candidate.param) === filterId);
    const bound = Boolean(binding)
      && !(binding as { unsupportedReason?: string }).unsupportedReason
      && Boolean((binding as { binding?: string; param?: string }).binding ?? (binding as { param?: string }).param);
    if (bound) applied.push(item.i);
    else {
      unaffected.push({
        tileId: item.i,
        title: item.title,
        reason: (binding as { unsupportedReason?: string } | undefined)?.unsupportedReason
          ?? (binding ? 'The tile declares this filter but nothing to bind it to.' : 'This tile has no column matching the filter.'),
      });
    }
  }
  return { filterId, applied, unaffected, filterable: items.length };
}

export type DashboardFilterCandidate = {
  column: string;
  /** How many tiles return this column — its reach if made a global filter. */
  tiles: number;
  sampleValues: string[];
};

type DashboardRunFilterEvidence = {
  tiles?: Array<{
    tileId?: string;
    filterableColumns?: Array<{ column: string; predicateTarget: string }>;
  }>;
};

/**
 * Promote a server-proven result column into a saved page filter and bind every
 * compatible tile in the same document write. Saving only the filter header
 * creates an attractive but inert control that immediately reports no reach.
 */
export function addDashboardFilterToDocument(
  dashboard: DashboardDocumentResponse['dashboard'],
  column: string,
  run: DashboardRunFilterEvidence | null,
): DashboardDocumentResponse['dashboard'] {
  if ((dashboard.filters ?? []).some((filter) => filter.id === column)) return dashboard;
  const targetByTile = new Map<string, string>();
  for (const tile of run?.tiles ?? []) {
    const candidate = tile.filterableColumns?.find((entry) => entry.column === column);
    if (tile.tileId && candidate?.predicateTarget) targetByTile.set(tile.tileId, candidate.predicateTarget);
  }
  const bindItems = (items: DashboardLayoutItem[]): DashboardLayoutItem[] => items.map((item) => {
    const target = targetByTile.get(item.i);
    if (!target) return item;
    const bindings = (item.filterBindings ?? []).filter((binding) => binding.filter !== column);
    return {
      ...item,
      filterBindings: [...bindings, { filter: column, binding: target, mode: 'predicate' as const }],
    };
  });
  return {
    ...dashboard,
    filters: [...(dashboard.filters ?? []), {
      id: column,
      type: dashboardFilterTypeForColumn(column),
      bindsTo: column,
    }],
    layout: {
      ...dashboard.layout,
      items: bindItems(dashboard.layout.items),
    },
  };
}

export function removeDashboardFilterFromDocument(
  dashboard: DashboardDocumentResponse['dashboard'],
  filterId: string,
): DashboardDocumentResponse['dashboard'] {
  const unbindItems = (items: DashboardLayoutItem[]): DashboardLayoutItem[] => items.map((item) => ({
    ...item,
    filterBindings: (item.filterBindings ?? []).filter((binding) => binding.filter !== filterId),
    parameterBindings: (item.parameterBindings ?? []).filter((binding) => binding.filter !== filterId),
  }));
  return {
    ...dashboard,
    filters: (dashboard.filters ?? []).filter((filter) => filter.id !== filterId),
    layout: {
      ...dashboard.layout,
      items: unbindItems(dashboard.layout.items),
    },
  };
}

function dashboardFilterTypeForColumn(column: string): DashboardFilter['type'] {
  if (/(_at$|_date$|_time$|_ts$|date|time|day|week|month|quarter|period)/i.test(column)) return 'daterange';
  if (/(top[_-]?n|limit|count|amount|number|year|score|rank)/i.test(column)) return 'number';
  if (/(_name$|_id$|^name$|search|email)/i.test(column)) return 'search';
  return 'select';
}

/**
 * Business columns a viewer may filter this page by.
 *
 * The candidates come from each tile's server-supplied `filterableColumns`,
 * which is decided from a real dialect parse of the SQL that ran — the same
 * rule Ask and the Notebook use for result filters. An earlier version of this
 * guessed from result column names with a measure-shaped regex; that is exactly
 * what `sql-result-filter.ts` warns against, because an aggregate output needs
 * HAVING and filtering it in WHERE silently changes the number.
 *
 * Ranked by reach so the most page-wide scope is offered first. A column only
 * one tile can honour is still offered — the coverage badge tells the truth
 * about its reach, which is a better trade than hiding a useful filter.
 */
export function dashboardFilterCandidates(
  dashboard: DashboardDocumentResponse['dashboard'] | null,
  run: {
    tiles?: Array<{
      filterableColumns?: Array<{ column: string; predicateTarget: string }>;
      result?: { columns?: string[]; rows?: Array<Record<string, unknown>> };
    }>;
  } | null,
): DashboardFilterCandidate[] {
  const existing = new Set((dashboard?.filters ?? []).map((filter) => filter.id));
  const byColumn = new Map<string, { tiles: number; values: Set<string> }>();
  for (const tile of run?.tiles ?? []) {
    for (const candidate of tile.filterableColumns ?? []) {
      if (existing.has(candidate.column)) continue;
      const entry = byColumn.get(candidate.column) ?? { tiles: 0, values: new Set<string>() };
      entry.tiles += 1;
      for (const row of (tile.result?.rows ?? []).slice(0, 24)) {
        const value = row?.[candidate.column];
        if ((typeof value === 'string' || typeof value === 'number') && String(value).trim() && entry.values.size < 24) {
          entry.values.add(String(value));
        }
      }
      byColumn.set(candidate.column, entry);
    }
  }
  return Array.from(byColumn.entries())
    .map(([column, entry]) => ({ column, tiles: entry.tiles, sampleValues: Array.from(entry.values).sort() }))
    .sort((a, b) => b.tiles - a.tiles || a.column.localeCompare(b.column));
}

/** Text and heading tiles carry no data, so they are not "missing" a filter. */
function isNarrativeTile(item: DashboardLayoutItem): boolean {
  const viz = String(item.viz?.type ?? '');
  return Boolean(item.text) || viz === 'text' || viz === 'heading';
}

function isUsefulDashboardFilter(filter: DashboardFilter): boolean {
  // A v3 Dataset field filter deliberately gets its options from the
  // server-owned distinct-value route. It therefore has neither static
  // `options` nor a legacy block predicate source. Dropping it here makes a
  // valid saved App control disappear in the published viewer, including an
  // explicit empty Dataset binding that truthfully leaves the current page
  // unfiltered. Keep the authored control; execution still validates its
  // exact Dataset binding and selected component ids on the server.
  const hasDatasetBindings = filter.datasetBindings !== undefined;
  const hasDistinctOptionSource = filter.optionSource?.mode === 'distinct_query';
  if (
    filter.type === 'select'
    && !filter.options?.length
    && filter.default === undefined
    && !(filter as { sourceBlockId?: string }).sourceBlockId
    && !hasDatasetBindings
    && !hasDistinctOptionSource
  ) return false;
  return true;
}

function filterFromParameterBinding(
  binding: NonNullable<DashboardLayoutItem['parameterBindings']>[number],
): DashboardFilter {
  const id = binding.filter || binding.field || binding.param;
  return {
    id,
    type: parameterFilterType(id, binding.parameterType),
    default: binding.default ?? defaultParameterFilterValue(id),
    bindsTo: binding.param,
  };
}

function isCoveredByExistingDashboardFilter(
  filters: Map<string, DashboardFilter>,
  binding: NonNullable<DashboardLayoutItem['parameterBindings']>[number],
): boolean {
  return Array.from(filters.values()).some((filter) => {
    if (binding.filter && filter.id === binding.filter) return true;
    if (binding.field && filter.bindsTo === binding.field) return true;
    return Boolean(binding.param && filter.bindsTo === binding.param);
  });
}

function parameterFilterType(id: string, parameterType?: string): DashboardFilter['type'] {
  if (parameterType === 'number' || parameterType === 'number[]') return 'number';
  if (parameterType === 'boolean') return 'boolean';
  if (parameterType === 'date' || parameterType === 'date[]') return 'date';
  // Time-ish columns get a date-RANGE picker (the runtime applies BETWEEN). Covers
  // the common dbt/warehouse naming (`ordered_at`, `_at`, `_date`, `_time`, `_ts`).
  if (/(_at$|_date$|_time$|_ts$|date|time|day|week|month|quarter|period)/i.test(id)) return 'daterange';
  if (/(top[_-]?n|limit|count|number|year|season)/i.test(id)) return 'number';
  return 'string';
}

export function defaultParameterFilterValue(id: string): unknown {
  const normalized = id.toLowerCase();
  if (/(top[_-]?n|limit)/.test(normalized)) return 5;
  if (/(season|year).*start|start.*(season|year)/.test(normalized)) return 2016;
  if (/(season|year).*end|end.*(season|year)/.test(normalized)) return 2017;
  return '';
}

/**
 * A viewer's own "Filter by…" choice, held for this session only.
 *
 * `tileIds` are the tiles the viewer was told it narrows ("Will narrow 1 of 4
 * tiles") when they applied it; the server re-proves each before binding.
 */
export type ViewerDashboardFilter = { column: string; value: string; tileIds: string[] };

/** Apply a choice: a new column is added, an existing one takes the new value. */
export function applyViewerFilterChoice(
  current: ViewerDashboardFilter[],
  next: ViewerDashboardFilter,
): ViewerDashboardFilter[] {
  const value = next.value.trim();
  if (!value) return current;
  const entry = { column: next.column, value, tileIds: [...new Set(next.tileIds)] };
  return current.some((filter) => filter.column === next.column)
    ? current.map((filter) => (filter.column === next.column ? entry : filter))
    : [...current, entry];
}

/**
 * The viewer filters a page run carries. A column the page has since declared
 * is the declared control's to set, so it is dropped here rather than sent
 * twice (the server refuses a viewer filter that shadows a declared one).
 */
export function viewerFiltersForRun(
  dashboard: DashboardDocumentResponse['dashboard'] | null,
  filters: ViewerDashboardFilter[],
): Array<{ column: string; values: string[]; tileIds: string[] }> {
  const declared = new Set([
    ...(dashboard?.filters ?? []).map((filter) => filter.id.toLowerCase()),
    ...(((dashboard as { params?: Array<{ id: string }> } | null)?.params) ?? []).map((param) => param.id.toLowerCase()),
  ]);
  return filters
    .filter((filter) => !declared.has(filter.column.toLowerCase()))
    .map((filter) => ({ column: filter.column, values: [filter.value], tileIds: filter.tileIds }));
}

/**
 * The page's values with the viewer's filters added, so the story, "Ask about
 * this App" and each tile's "Not filtered by…" notice read the filtered scope.
 */
export function viewerFilterPageVariables(
  declaredValues: Record<string, unknown>,
  runFilters: Array<{ column: string; values: string[] }>,
): Record<string, unknown> {
  if (runFilters.length === 0) return declaredValues;
  return {
    ...declaredValues,
    ...Object.fromEntries(runFilters.map((filter) => [filter.column, filter.values.length === 1 ? filter.values[0] : filter.values])),
  };
}

/**
 * Which tiles a viewer filter actually narrowed, from the server's own
 * `filters.applied` on the run on screen — not from what was promised before
 * it ran. Before that run settles, the promise is all there is.
 */
export function viewerFilterReach(
  dashboard: DashboardDocumentResponse['dashboard'] | null,
  run: { tiles?: Array<{ tileId?: string; status?: string; filters?: { applied?: Array<{ filter?: string }> } }> } | null,
  filter: ViewerDashboardFilter,
): { applied: string[]; unaffected: Array<{ tileId: string; title?: string }>; filterable: number; settled: boolean } {
  const items = (dashboard?.layout.items ?? []).filter((item) => !isNarrativeTile(item));
  const settled = Boolean(run?.tiles?.length);
  const narrowed = new Set(settled
    ? (run!.tiles ?? [])
      .filter((tile) => (tile.filters?.applied ?? []).some((entry) => entry.filter === filter.column))
      .map((tile) => tile.tileId)
      .filter((tileId): tileId is string => Boolean(tileId))
    : filter.tileIds);
  return {
    applied: items.filter((item) => narrowed.has(item.i)).map((item) => item.i),
    unaffected: items.filter((item) => !narrowed.has(item.i)).map((item) => ({ tileId: item.i, title: item.title })),
    filterable: items.length,
    settled,
  };
}
