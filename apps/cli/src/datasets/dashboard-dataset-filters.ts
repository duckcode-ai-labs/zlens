import {
  dashboardDateBoundsForColumn,
  datasetPhysicalField,
  isDashboardDateFilterType,
  resolveDashboardDateFilter,
  resolveRelativeDateRange,
  tileQueryOutputAliases,
  type DashboardDocument,
  type DashboardGridItem,
  type DatasetDescriptor,
  type DatasetPhysicalField,
  type TileQueryFilter,
} from '@zlens/core';

export interface DashboardDatasetCrossFilterInput {
  fromTileId: string;
  fromSourceId: string;
  fromSourceRevision: string;
  field: string;
  values: unknown[];
  /** Exclude these values instead of keeping only them (RFC 0009 step 6a). */
  exclude?: boolean;
}

export type DatasetFilterIssue = {
  filterId: string;
  code: 'DATASET_BINDING_MISSING' | 'FILTER_REQUIRED_VALUE_MISSING' | 'FILTER_MAPPING_MISSING' | 'DATASET_TILE_EXCLUDED' | 'FILTER_FIELD_UNAVAILABLE' | 'FILTER_VALUE_INVALID' | 'CROSS_FILTER_UNSUPPORTED' | 'CROSS_FILTER_SOURCE_INVALID';
  message: string;
};

export interface DatasetTileFilterResolution {
  filters: TileQueryFilter[];
  /** A visible badge can explain intentional partial filtering without hiding it. */
  unbound: DatasetFilterIssue[];
  /** Errors block only this tile; they never discard its saved query draft. */
  errors: DatasetFilterIssue[];
}

/**
 * Resolve field-bound dashboard filters for exactly one Dataset tile.  There
 * is no display-name fallback: a filter only travels across a source boundary
 * through `DashboardFilter.datasetBindings` or an authored cross-filter map.
 */
export function resolveDashboardDatasetFilters(input: {
  dashboard: DashboardDocument;
  item: DashboardGridItem;
  descriptor: DatasetDescriptor;
  values: Record<string, unknown>;
  crossFilters?: DashboardDatasetCrossFilterInput[];
  /** Reference instant for relative dates; the run's own clock by default. */
  now?: Date;
}): DatasetTileFilterResolution {
  const filters: TileQueryFilter[] = [];
  const unbound: DatasetFilterIssue[] = [];
  const errors: DatasetFilterIssue[] = [];
  if (!input.item.query || input.item.query.respectsGlobalFilters === false) return { filters, unbound, errors };
  const binding = input.dashboard.datasets?.find((candidate) => candidate.sourceId === input.item.sourceId
    && candidate.sourceRevision === input.item.sourceRevision);
  if (!binding) {
    errors.push({
      filterId: 'dataset',
      code: 'DATASET_BINDING_MISSING',
      message: 'This tile no longer has its exact Dataset binding. Refresh the selected dataset before running it.',
    });
    return { filters, unbound, errors };
  }
  for (const filter of input.dashboard.filters ?? []) {
    if (filter.scope?.page && filter.scope.page !== input.dashboard.id) continue;
    if (filter.scope?.tileIds && !filter.scope.tileIds.includes(input.item.i)) continue;
    const value = input.values[filter.id];
    if (isEmptyDashboardFilterValue(value)) {
      if (filter.required) {
        errors.push({
          filterId: filter.id,
          code: 'FILTER_REQUIRED_VALUE_MISSING',
          message: `${filter.label ?? filter.id} needs a value before this tile can run.`,
        });
      }
      continue;
    }
    const datasetBinding = filter.datasetBindings?.[binding.id];
    if (!datasetBinding) {
      unbound.push({
        filterId: filter.id,
        code: 'FILTER_MAPPING_MISSING',
        message: `${filter.label ?? filter.id} is not mapped to ${input.descriptor.label}.`,
      });
      continue;
    }
    if (datasetBinding.tileIds && !datasetBinding.tileIds.includes(input.item.i)) {
      unbound.push({
        filterId: filter.id,
        code: 'DATASET_TILE_EXCLUDED',
        message: `${filter.label ?? filter.id} is excluded from ${input.item.title ?? input.item.i} by this filter's linked-component selection.`,
      });
      continue;
    }
    const mapped = datasetBinding.field;
    const field = datasetPhysicalField(input.descriptor, mapped);
    if (!field) {
      errors.push({
        filterId: filter.id,
        code: 'FILTER_FIELD_UNAVAILABLE',
        message: `${filter.label ?? filter.id} maps to ${mapped}, which is no longer an approved physical field on ${input.descriptor.label}.`,
      });
      continue;
    }
    const compiled = dashboardFilterToTileFilter(filter.id, filter.type, filter.multiple === true, field, filter.timezone, value, input.now ?? new Date());
    if ('error' in compiled) {
      errors.push({ filterId: filter.id, code: 'FILTER_VALUE_INVALID', message: compiled.error });
      continue;
    }
    filters.push(...compiled.filters);
  }

  const crossFilterMappings = input.dashboard.interactions?.crossFilter;
  if (crossFilterMappings?.enabled !== false) {
    for (const crossFilter of input.crossFilters ?? []) {
      if (!crossFilter.values.length) continue;
      const sourceItem = input.dashboard.layout.items.find((candidate) => candidate.i === crossFilter.fromTileId);
      const sourceDataset = sourceItem?.sourceId && sourceItem.sourceRevision
        ? input.dashboard.datasets?.find((candidate) => candidate.sourceId === sourceItem.sourceId
          && candidate.sourceRevision === sourceItem.sourceRevision)
        : undefined;
      const sourceOutput = sourceItem?.query
        ? tileQueryOutputAliases(sourceItem.query).find((output) => output.alias === crossFilter.field)
        : undefined;
      if (!sourceItem || !sourceDataset || !sourceOutput
        || sourceItem.sourceId !== crossFilter.fromSourceId
        || sourceItem.sourceRevision !== crossFilter.fromSourceRevision) {
        errors.push({
          filterId: crossFilter.fromTileId,
          code: 'CROSS_FILTER_SOURCE_INVALID',
          message: `The cross-filter source ${crossFilter.fromTileId} no longer matches its declared Dataset field binding.`,
        });
        continue;
      }
      const mappings = (crossFilterMappings?.mappings ?? []).filter((mapping) =>
        mapping.toDataset === binding.id
        && mapping.fromField === crossFilter.field
        && mapping.fromTileId === crossFilter.fromTileId);
      // Keep only / Exclude on the tile's own Dataset needs no mapping: it is
      // the same Dataset and the same field, not a guess from a similar name.
      // A time grain's value names a period, not a date, so it never filters
      // this way.
      const ownDimension = sourceDataset.id === binding.id
        ? sourceItem.query?.dimensions.find((dimension) => !dimension.timeGrain
          && (dimension.alias ?? dimension.field) === crossFilter.field)
        : undefined;
      if (mappings.length === 0 && ownDimension) mappings.push({ fromTileId: crossFilter.fromTileId, fromField: crossFilter.field, toDataset: binding.id, toField: ownDimension.field });
      if (mappings.length === 0) {
        unbound.push({
          filterId: crossFilter.fromTileId,
          code: 'CROSS_FILTER_UNSUPPORTED',
          message: `The cross-filter from ${crossFilter.fromTileId} is not mapped to ${input.descriptor.label}.`,
        });
        continue;
      }
      for (const mapping of mappings) {
        const field = datasetPhysicalField(input.descriptor, mapping.toField);
        if (!field) {
          errors.push({
            filterId: crossFilter.fromTileId,
            code: 'FILTER_FIELD_UNAVAILABLE',
            message: `Cross-filter mapping ${mapping.toField} is not available on ${input.descriptor.label}.`,
          });
          continue;
        }
        filters.push({
          field: field.name,
          op: crossFilter.exclude
            ? (crossFilter.values.length > 1 ? 'not_in' : 'neq')
            : (crossFilter.values.length > 1 ? 'in' : 'eq'),
          values: [...crossFilter.values],
        });
      }
    }
  }
  return { filters: dedupeTileFilters(filters), unbound: dedupeIssues(unbound), errors: dedupeIssues(errors) };
}

function dashboardFilterToTileFilter(
  filterId: string,
  type: string,
  multiple: boolean,
  field: DatasetPhysicalField,
  timezone: string | undefined,
  value: unknown,
  now: Date,
): { filters: TileQueryFilter[] } | { error: string } {
  const values = Array.isArray(value) ? value : [value];
  // Dates follow the one App date rule (@zlens/core filter-dates): a range is
  // start-inclusive and end-exclusive at the next day, a single date is that
  // whole day, and a relative date resolves to a range first.
  if (isDashboardDateFilterType(type)) {
    if (type === 'relative_date' && field.type !== 'date' && field.type !== 'timestamp') {
      return { error: `${filterId} is a relative date, but ${field.name} is not a date or timestamp field.` };
    }
    const resolved = resolveDashboardDateFilter({ filterId, type, value, timezone, now });
    if (!resolved) return { error: `${filterId} requires a date value.` };
    if (resolved.kind === 'error') return { error: resolved.message };
    if (resolved.kind === 'explicit') {
      // Explicit timestamp boundaries are already precise. Preserve their
      // caller-declared semantics rather than guessing an extra calendar day.
      return { filters: [{ field: field.name, op: 'between', values: [resolved.start, resolved.end] }] };
    }
    const column = field.type === 'timestamp' ? 'timestamp' : field.type === 'date' ? 'date' : 'unknown';
    const bounds = dashboardDateBoundsForColumn(resolved.bounds, column, timezone);
    if ('error' in bounds) return { error: `${filterId} ${bounds.error}` };
    return { filters: [
      { field: field.name, op: 'gte', values: [bounds.start] },
      { field: field.name, op: 'lt', values: [bounds.endExclusive] },
    ] };
  }
  if (type === 'number_range') {
    if (values.length !== 2) return { error: `${filterId} requires exactly two values for a range.` };
    return { filters: [{ field: field.name, op: 'between', values }] };
  }
  if (type === 'search') {
    if (values.length !== 1) return { error: `${filterId} requires one search value.` };
    return { filters: [{ field: field.name, op: 'contains', values }] };
  }
  if (type === 'multiselect' || multiple || Array.isArray(value)) {
    if (values.length === 0) return { error: `${filterId} requires at least one selected value.` };
    return { filters: [{ field: field.name, op: 'in', values }] };
  }
  if (values.length !== 1) return { error: `${filterId} requires one value.` };
  return { filters: [{ field: field.name, op: 'eq', values }] };
}

/** Kept for existing callers; the rule itself lives in @zlens/core. */
export { resolveRelativeDateRange };

function isEmptyDashboardFilterValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function dedupeTileFilters(filters: TileQueryFilter[]): TileQueryFilter[] {
  const seen = new Set<string>();
  return filters.filter((filter) => {
    const key = JSON.stringify([filter.field, filter.op, filter.values]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeIssues(issues: DatasetFilterIssue[]): DatasetFilterIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.filterId}\u0000${issue.code}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
