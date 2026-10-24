import type { DatasetDescriptor, DatasetField, DatasetJoin, DatasetPhysicalField } from '@zlens/core/datasets/descriptor';
import { datasetTileVisualizationCompatibility, type TileQuery } from '@zlens/core/apps/tile-query';
import { chartFromEncoding, refName, type DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';

/**
 * Click-a-field tile building. A measure click adds or removes a value; a
 * dimension or time click adds or removes a grouping. The result is always an
 * ordinary TileQuery — the Dataset contract still validates it on every run.
 */

export type TileView = 'kpi' | 'chart' | 'table';

export const EMPTY_TILE_QUERY: TileQuery = { dimensions: [], measures: [], respectsGlobalFilters: true };

/**
 * The fields of one related table a Dataset reaches through a checked
 * many-to-one join (design D2): "Orders → Customer". `review` is a join
 * nobody certified yet (drafted in setup): its fields can be used, and a
 * tile that uses them needs review.
 */
export type RelatedFieldGroup = {
  join: DatasetJoin;
  /** The join path in words: "Customer", "Customer → Region". */
  path: string;
  review: boolean;
  fields: DatasetPhysicalField[];
};

export type FieldGroups = {
  measures: DatasetField[];
  time: DatasetPhysicalField[];
  dimensions: DatasetPhysicalField[];
  review: DatasetField[];
  related: RelatedFieldGroup[];
};

/** A join's path from the Dataset in words, and whether any join on it needs review. */
export function datasetJoinPath(descriptor: Pick<DatasetDescriptor, 'joins'>, joinId: string): { path: string; review: boolean } {
  const chain: DatasetJoin[] = [];
  let join = descriptor.joins?.find((candidate) => candidate.id === joinId);
  while (join && !chain.includes(join)) {
    chain.unshift(join);
    join = join.parent ? descriptor.joins?.find((candidate) => candidate.id === join!.parent) : undefined;
  }
  return { path: chain.map((step) => step.label).join(' → '), review: chain.some((step) => step.trust !== 'certified') };
}

/** Fields in the order the Data panel lists them. Suggested fields are shown but cannot be used. */
export function groupDatasetFields(descriptor: DatasetDescriptor, search = ''): FieldGroups {
  const needle = search.trim().toLowerCase().replace(/[\s_]+/g, ' ');
  const words = (value: string) => value.replace(/_/g, ' ').toLowerCase();
  const matches = (field: DatasetField) => !needle
    || field.name.toLowerCase().includes(needle)
    || words(field.name).includes(needle)
    || Boolean(field.kind === 'physical' && field.related && (
      words(field.related.column).includes(needle)
      || `${datasetJoinPath(descriptor, field.related.join).path.toLowerCase()} ${words(field.related.column)}`.includes(needle)
    ));
  const groups: FieldGroups = { measures: [], time: [], dimensions: [], review: [], related: [] };
  // A number column that a measure adds up is shown once, as that measure.
  const measureInputs = new Set(descriptor.fields.flatMap((field) => (field.kind === 'measure' ? field.dependsOn.map((name) => name.toLowerCase()) : [])));
  for (const field of descriptor.fields) {
    if (!matches(field)) continue;
    if (field.kind === 'physical' && field.related) {
      const join = descriptor.joins?.find((candidate) => candidate.id === field.related!.join);
      if (!join) continue;
      let group = groups.related.find((candidate) => candidate.join.id === join.id);
      if (!group) {
        group = { join, ...datasetJoinPath(descriptor, join.id), fields: [] };
        groups.related.push(group);
      }
      group.fields.push(field);
      continue;
    }
    if (field.status !== 'approved') groups.review.push(field);
    else if (field.kind === 'measure') groups.measures.push(field);
    else if (field.role === 'time' || field.type === 'date' || field.type === 'timestamp') groups.time.push(field);
    else if (field.role === 'attribute' && field.type === 'number' && measureInputs.has(field.name.toLowerCase())) continue;
    else groups.dimensions.push(field);
  }
  // Never two groups that read the same (new-user round 2, problem 5): a
  // descriptor stored before joins were deduplicated may still carry two
  // joins to one table; each is named by its keys then ("Product (by product id)").
  const paths = new Map<string, number>();
  for (const group of groups.related) paths.set(group.path, (paths.get(group.path) ?? 0) + 1);
  for (const group of groups.related) {
    if ((paths.get(group.path) ?? 0) < 2) continue;
    group.path = `${group.path} (by ${group.join.keys.map((pair) => pair.from.replace(/_/g, ' ').toLowerCase()).join(' and ')})`;
  }
  return groups;
}

/** The grain a time field is grouped by when picked: month when offered, else its base grain. */
export function defaultTimeGrain(field: DatasetPhysicalField): string | undefined {
  const grains = field.time?.grains ?? [];
  if (grains.includes('month')) return 'month';
  return field.time?.baseGrain ?? grains[0];
}

export function isTimeField(field: DatasetField): field is DatasetPhysicalField {
  return field.kind === 'physical' && (field.role === 'time' || field.type === 'date' || field.type === 'timestamp');
}

/** Field names a query already uses, for check marks in the field list. */
export function queryFieldNames(query: TileQuery | undefined): Set<string> {
  const names = new Set<string>();
  for (const measure of query?.measures ?? []) names.add(measure.measure.toLowerCase());
  for (const dimension of query?.dimensions ?? []) names.add(dimension.field.toLowerCase());
  return names;
}

export function toggleFieldInQuery(query: TileQuery, field: DatasetField): TileQuery {
  const name = field.name;
  const lower = name.toLowerCase();
  let measures = query.measures;
  let dimensions = query.dimensions;
  if (field.kind === 'measure') {
    measures = measures.some((measure) => measure.measure.toLowerCase() === lower)
      ? measures.filter((measure) => measure.measure.toLowerCase() !== lower)
      : [...measures, { measure: name }];
  } else if (dimensions.some((dimension) => dimension.field.toLowerCase() === lower)) {
    dimensions = dimensions.filter((dimension) => dimension.field.toLowerCase() !== lower);
  } else {
    const grain = isTimeField(field) ? defaultTimeGrain(field) : undefined;
    dimensions = [...dimensions, { field: name, ...(grain ? { timeGrain: grain } : {}) }];
  }
  // Order follows the fields: biggest first for a category, time runs in
  // order on its own. Stale sort/limit keys never survive a field change.
  const { orderBy: _orderBy, limit: _limit, detail: _detail, detailColumns: _detailColumns, ...rest } = query;
  const categorical = dimensions.length > 0 && !dimensions.some((dimension) => dimension.timeGrain);
  // A name has many values (930 customers): its bar chart starts as an
  // explicit Top 10 the pill shows, not a silent cut (new-user round 3,
  // problem 9). A Top N the author already chose for the same grouping stays.
  const names = categorical && measures[0] && dimensions.length === 1 && isNameFieldName(dimensions[0]!.field);
  const sameGrouping = query.dimensions.length === 1 && dimensions.length === 1 && query.dimensions[0]!.field.toLowerCase() === dimensions[0]!.field.toLowerCase();
  const topN = names ? (sameGrouping && typeof query.limit === 'number' ? query.limit : DEFAULT_NAME_TOP_N) : undefined;
  return {
    ...rest,
    measures,
    dimensions,
    ...(categorical && measures[0] ? { orderBy: [{ alias: measures[0].alias ?? measures[0].measure, direction: 'desc' as const }] } : {}),
    ...(topN ? { limit: topN } : {}),
  };
}

/** How many names a new bar chart of names shows: "Top 10". */
export const DEFAULT_NAME_TOP_N = 10;

/** "customer_name", "customer__customer_name", "name": a field of names a person reads. */
export function isNameFieldName(name: string): boolean {
  const column = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return /^(?:.+_)?name$/i.test(column);
}

/** The view a picked set of fields reads best as; shelves decide when there are any. */
export function autoTileView(query: TileQuery, encoding?: DashboardVizEncoding, isTime: (field: string) => boolean = () => false): TileView {
  if (query.detail) return 'table';
  if (encoding) {
    const chart = chartFromEncoding(encoding, isTime);
    if (chart.kind === 'kpi') return 'kpi';
    return chart.kind === 'table' ? 'table' : 'chart';
  }
  if (query.dimensions.length === 0) return query.measures.length === 1 ? 'kpi' : 'table';
  const compatibility = datasetTileVisualizationCompatibility(query, 'bar');
  return compatibility.compatible ? 'chart' : 'table';
}

/** The concrete visualization a view renders as for this query. */
export function tileVisualization(query: TileQuery, view: TileView): 'single_value' | 'bar' | 'line' | 'table' {
  if (view === 'kpi') return 'single_value';
  if (view === 'table') return 'table';
  return query.dimensions.some((dimension) => dimension.timeGrain) ? 'line' : 'bar';
}

export function defaultTileTitle(query: TileQuery, label: (name: string) => string): string {
  if (!query.measures.length) return 'Untitled tile';
  const values = query.measures.map((measure) => label(measure.measure));
  const head = values.length > 2 ? `${values[0]} and ${values.length - 1} more` : values.join(' and ');
  if (!query.dimensions.length) return head;
  const groups = query.dimensions.map((dimension) => dimension.timeGrain ? label(dimension.timeGrain) : label(dimension.field));
  return `${head} by ${groups.join(' and ').toLowerCase()}`;
}

/** Whether a Dataset dimension is a time field. */
export function descriptorTimeField(descriptor: DatasetDescriptor): (name: string) => boolean {
  return (name) => {
    const field = descriptor.fields.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    return Boolean(field && isTimeField(field));
  };
}

/** The grain a newly placed time field groups by. */
export function descriptorTimeGrain(descriptor: DatasetDescriptor): (name: string) => string | undefined {
  return (name) => {
    const field = descriptor.fields.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    return field && isTimeField(field) ? defaultTimeGrain(field) : undefined;
  };
}

const BAR_TYPES = new Set(['bar', 'grouped_bar', 'stacked_bar']);
const LINE_TYPES = new Set(['line', 'area']);
const ONE_MEASURE_TYPES = new Set(['pie', 'donut', 'funnel']);

/**
 * The chart type shelves draw as. The author's chart type stays when it still
 * reads the same shelves (stacked bars stay stacked, an area stays an area).
 */
export function vizTypeForEncoding(encoding: DashboardVizEncoding, isTime: (field: string) => boolean, current?: string): string {
  const chart = chartFromEncoding(encoding, isTime);
  const type = (current ?? '').replace(/-/g, '_');
  // A pivot stays a pivot while it has a dimension to list.
  if (type === 'pivot' && [...encoding.rows, ...encoding.columns, ...(encoding.color ? [encoding.color] : []), ...(encoding.detail ?? [])].some((ref) => 'dimension' in ref)) return 'pivot';
  if (chart.kind === 'kpi') return 'single_value';
  // A KPI keeps its date as a trend: one measure and one date, nothing else.
  if ((type === 'single_value' || type === 'kpi') && !encoding.color && !encoding.detail?.length) {
    const refs = [...encoding.columns, ...encoding.rows];
    const dims = refs.filter((ref) => 'dimension' in ref);
    if (refs.length - dims.length === 1 && dims.length === 1 && isTime(refName(dims[0]!))) return 'single_value';
  }
  if (chart.kind === 'table') return 'table';
  if (chart.kind === 'scatter') return 'scatter';
  if (chart.kind === 'heatmap') return 'heatmap';
  if (BAR_TYPES.has(type) || LINE_TYPES.has(type)) return type;
  if (ONE_MEASURE_TYPES.has(type) && chart.measures.length === 1 && !encoding.color) return type;
  return chart.line ? 'line' : 'bar';
}
