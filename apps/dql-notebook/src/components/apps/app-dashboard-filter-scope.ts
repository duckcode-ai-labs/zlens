/**
 * Browser-pure App filter scope helpers.
 *
 * A dashboard filter id is only meaningful inside its declaring page unless
 * both pages explicitly declare it with `scope.app`.  Keeping that decision
 * here prevents a convenient shared state object from turning two unrelated
 * page controls with the same id into an implicit cross-page binding.
 */

export type ScopedDashboardFilter = {
  id: string;
  scope?: { app?: boolean; page?: string; tileIds?: string[] };
};

export type ScopedDashboardPage<TFilter extends ScopedDashboardFilter = ScopedDashboardFilter> = {
  id: string;
  filters?: TFilter[];
};

export type PersistedAppFilterValues = {
  draft: Record<string, unknown>;
  applied: Record<string, unknown>;
  /**
   * The definition of each filter at the moment its value was chosen
   * (`dashboardFilterFingerprint`). A remembered value is only ever applied to
   * the same filter: same id, type and field. An entry without one (written
   * before fingerprints existed) is never applied.
   */
  fingerprints: Record<string, string>;
};

/** The parts of a filter definition a remembered value depends on. */
export type FingerprintableDashboardFilter = ScopedDashboardFilter & {
  type: string;
  multiple?: boolean;
  field?: { name: string; relation?: string; semanticModel?: string; provider?: string };
  datasetBindings?: Record<string, { field: string; tileIds?: string[] }>;
};

export function isAppScopedDashboardFilter(filter: ScopedDashboardFilter | undefined | null): boolean {
  return filter?.scope?.app === true;
}

/**
 * Pages that may receive a value change from this exact control. Page-local
 * controls remain on their declared page, even where another page reused the
 * same id for a different governed field.
 */
export function pagesForDashboardFilterValue<TFilter extends ScopedDashboardFilter>(
  pages: Array<ScopedDashboardPage<TFilter>>,
  sourcePageId: string,
  filter: TFilter,
): string[] {
  if (!isAppScopedDashboardFilter(filter)) return [sourcePageId];
  return pages
    .filter((page) => page.filters?.some((candidate) => (
      candidate.id === filter.id && isAppScopedDashboardFilter(candidate)
    )))
    .map((page) => page.id);
}

/**
 * Hydrate only the controls declared on a page. An App-scoped value wins for
 * an App-scoped control; a same-named page-local control never receives it.
 */
export function valuesForDashboardPage<TFilter extends ScopedDashboardFilter>(input: {
  filters: TFilter[];
  pageValues: Record<string, unknown>;
  appValues: Record<string, unknown>;
  defaultValue: (filter: TFilter) => unknown;
}): Record<string, unknown> {
  const hydrated = hydrateAppScopedDashboardFilterValues(input);
  return Object.fromEntries(input.filters.map((filter) => [
    filter.id,
    hydrated[filter.id] ?? input.defaultValue(filter),
  ]));
}

/**
 * Project current App-scoped selections onto one declared page. Keeping the
 * shared values separate from the page map lets a page added after selection
 * receive its App control without making a same-id page-local control global.
 */
export function hydrateAppScopedDashboardFilterValues<TFilter extends ScopedDashboardFilter>(input: {
  filters: TFilter[];
  pageValues: Record<string, unknown>;
  appValues: Record<string, unknown>;
}): Record<string, unknown> {
  const hydrated = { ...input.pageValues };
  for (const filter of input.filters) {
    if (!isAppScopedDashboardFilter(filter) || !Object.prototype.hasOwnProperty.call(input.appValues, filter.id)) continue;
    hydrated[filter.id] = input.appValues[filter.id];
  }
  return hydrated;
}

/**
 * A stable description of what a filter filters: its id, control type and
 * field (including each Dataset's mapped field). Labels, options and tile
 * reach are left out, so renaming a filter or adding a tile keeps a reader's
 * remembered choice; changing the field or the control drops it.
 */
export function dashboardFilterFingerprint(filter: FingerprintableDashboardFilter): string {
  const datasetFields = Object.entries(filter.datasetBindings ?? {})
    .map(([datasetId, binding]) => [datasetId, binding?.field ?? ''] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    filter.id,
    filter.type,
    filter.multiple === true,
    filter.field ? [filter.field.name, filter.field.relation ?? '', filter.field.semanticModel ?? ''] : null,
    datasetFields,
  ]);
}

/**
 * Whether a value has the shape its control shows. A value the control cannot
 * display (one name for a multi-select, a word for a date range) would narrow
 * tiles while the control reads "All", so it is never applied.
 */
export function dashboardFilterValueFits(filter: FingerprintableDashboardFilter, value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null) return true;
  switch (filter.type) {
    case 'multiselect':
      return Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number');
    case 'daterange':
      // '' is the cleared range (the control's default).
      return value === '' || isRecord(value)
        && Object.keys(value).every((key) => key === 'start' || key === 'end')
        && (value.start === undefined || typeof value.start === 'string')
        && (value.end === undefined || typeof value.end === 'string');
    case 'number_range':
      return value === '' || isRecord(value)
        && Object.keys(value).every((key) => key === 'min' || key === 'max')
        && (value.min === undefined || value.min === null || typeof value.min === 'number')
        && (value.max === undefined || value.max === null || typeof value.max === 'number');
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' || value === '';
    default:
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  }
}

/**
 * The remembered App-scoped values this page may apply. A value is kept only
 * when the page declares an App-scoped filter with that id, the fingerprint
 * saved with the value matches the filter today, and the value fits the
 * control. Everything else is reported as `rejected` so the caller can forget
 * it; a value for a filter this page does not declare is left untouched for
 * the page that does.
 */
export function acceptRememberedAppFilterValues<TFilter extends FingerprintableDashboardFilter>(input: {
  filters: TFilter[];
  values: Record<string, unknown>;
  fingerprints: Record<string, string>;
  /**
   * Values that came back from browser storage. Only these are also checked
   * for shape: a value being typed now (a "-" on its way to "-5") is the
   * control's own and is never thrown away. Omitted, every value is checked.
   */
  remembered?: ReadonlySet<string>;
}): { values: Record<string, unknown>; rejected: string[] } {
  const accepted: Record<string, unknown> = { ...input.values };
  const rejected: string[] = [];
  for (const filter of input.filters) {
    if (!isAppScopedDashboardFilter(filter) || !Object.prototype.hasOwnProperty.call(input.values, filter.id)) continue;
    const value = input.values[filter.id];
    const shapeChecked = !input.remembered || input.remembered.has(filter.id);
    if (input.fingerprints[filter.id] === dashboardFilterFingerprint(filter)
      && (!shapeChecked || dashboardFilterValueFits(filter, value))) continue;
    delete accepted[filter.id];
    rejected.push(filter.id);
  }
  return { values: accepted, rejected };
}

export function readPersistedAppFilterValues(storage: Pick<Storage, 'getItem'>, key: string): PersistedAppFilterValues {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { draft: {}, applied: {}, fingerprints: {} };
    const value = JSON.parse(raw) as Partial<PersistedAppFilterValues>;
    const fingerprints = isRecord(value.fingerprints)
      ? Object.fromEntries(Object.entries(value.fingerprints).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {};
    return {
      draft: isRecord(value.draft) ? value.draft : {},
      applied: isRecord(value.applied) ? value.applied : {},
      fingerprints,
    };
  } catch {
    return { draft: {}, applied: {}, fingerprints: {} };
  }
}

export function writePersistedAppFilterValues(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  value: PersistedAppFilterValues,
): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Filter state is a convenience. The current in-memory page remains usable
    // when local storage is unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
