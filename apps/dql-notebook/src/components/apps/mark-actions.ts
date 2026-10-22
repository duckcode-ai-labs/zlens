/**
 * What a reader can do with one clicked mark (RFC 0009 step 6a): keep only
 * or exclude it, drill down or by another field, read the rows behind it,
 * open the details page, explain it, or ask AI about it.
 *
 * Everything here turns a settled result row into governed requests: filters
 * on approved fields and field queries on the same Dataset. The server
 * validates every one of them against the Dataset contract again, so this
 * module can only ask; it cannot widen what a reader may see. Pure: no I/O.
 */
import { tileQueryOutputAliases, type TileQuery } from '@zlens/core/apps/tile-query';
import type { DashboardDatasetHierarchyDrill, DashboardDocumentResponse, DashboardDriverDefinitionV1, DashboardRunResponse } from '../../api/client';

type LayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];
type Filter = NonNullable<TileQuery['filters']>[number];

export type ExploreField = { name: string; role: string; type: string; grains?: string[]; primary?: boolean };
export type Scalar = string | number | boolean;

const GRAINS = ['year', 'quarter', 'month', 'week', 'day'] as const;
type Grain = (typeof GRAINS)[number];

/** One dimension value of a clicked mark. */
export interface MarkValue {
  field: string;
  alias: string;
  value: Scalar;
  timeGrain?: Grain;
}

/** A clicked mark, read off its result row against the tile's query. */
export interface MarkContext {
  tileId: string;
  values: MarkValue[];
  measure?: { name: string; alias: string; value: unknown };
  row: Record<string, unknown>;
}

const isScalar = (value: unknown): value is Scalar => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
const grainOf = (value: string | undefined): Grain | undefined => {
  const lower = value?.toLowerCase();
  return (GRAINS as readonly string[]).includes(lower ?? '') ? lower as Grain : undefined;
};

export function markContextFor(item: LayoutItem, row: Record<string, unknown>): MarkContext | null {
  const query = item.query as TileQuery | undefined;
  if (!query || query.detail) return null;
  const outputs = tileQueryOutputAliases(query);
  const values: MarkValue[] = [];
  query.dimensions.forEach((dimension, index) => {
    const alias = outputs[index]?.alias;
    const value = alias ? row[alias] : undefined;
    if (!alias || !isScalar(value)) return;
    const grain = grainOf(dimension.timeGrain);
    values.push({ field: dimension.field, alias, value, ...(grain ? { timeGrain: grain } : {}) });
  });
  if (!values.length) return null;
  const measure = query.measures[0];
  const measureAlias = measure ? measure.alias ?? measure.measure : undefined;
  return {
    tileId: item.i,
    values,
    row,
    ...(measure && measureAlias ? { measure: { name: measure.measure, alias: measureAlias, value: row[measureAlias] } } : {}),
  };
}

const humanize = (name: string) => name.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

/** "January 2026", "Q1 2026", "Week of 5 Jan 2026" for a period value. */
export function periodLabel(value: Scalar, grain: Grain): string {
  const start = periodStart(calendarDate(value) ?? String(value), grain);
  const [year, month, day] = start.split('-').map(Number) as [number, number, number];
  if (!year) return String(value);
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  if (grain === 'year') return String(year);
  if (grain === 'quarter') return `Q${Math.floor(((month || 1) - 1) / 3) + 1} ${year}`;
  if (grain === 'month') return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const text = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return grain === 'week' ? `Week of ${text}` : text;
}

/** "Region US · January 2026": the mark as a reader names it. */
export function describeMark(mark: MarkContext, label: (field: string) => string = humanize): string {
  return mark.values.map((entry) => (entry.timeGrain ? periodLabel(entry.value, entry.timeGrain) : `${label(entry.field)} ${String(entry.value)}`)).join(' · ');
}

/** The filters a clicked mark stands for: a category is one value; a period is its start to the next start. */
export function markFilters(mark: MarkContext): Filter[] {
  return mark.values.flatMap((entry): Filter[] => {
    if (!entry.timeGrain) return [{ field: entry.field, op: 'eq', values: [entry.value] }];
    const date = calendarDate(entry.value);
    if (!date) return [];
    const start = periodStart(date, entry.timeGrain);
    return [
      { field: entry.field, op: 'gte', values: [start] },
      { field: entry.field, op: 'lt', values: [nextPeriod(start, entry.timeGrain)] },
    ];
  });
}

/** The filters a tile's active hierarchy drill already applies: each step holds its parent value. */
export function drillFilters(steps: DashboardDatasetHierarchyDrill['steps'] | undefined): Filter[] {
  return (steps ?? []).flatMap((step) => {
    const values = step.values.filter(isScalar);
    if (!values.length) return [];
    return [{ field: step.fromField, op: values.length > 1 ? 'in' as const : 'eq' as const, values }];
  });
}

/** One step of an Explore path: the field and value the reader went into. */
export interface ExploreStep {
  label: string;
  filters: Filter[];
}

/**
 * The drill view: the tile's measures by one approved field, inside every
 * step of the path. Categories come biggest first; time runs in order at a
 * grain the field offers.
 */
export function exploreByQuery(base: TileQuery, path: ExploreStep[], field: ExploreField): TileQuery {
  const time = field.role === 'time';
  const grains = field.grains ?? [];
  const grain = time ? (['month', 'week', 'day', 'quarter', 'year'].find((candidate) => grains.includes(candidate)) ?? grains[0] ?? 'month') : undefined;
  const measures = base.measures.length ? base.measures : [];
  // Calculated measures hold at any grouping; quick calculations belong to the tile's own layout.
  const calculations = (base.calculations ?? []).filter((calculation) => calculation.expr);
  const firstAlias = measures[0] ? measures[0].alias ?? measures[0].measure : calculations[0]?.id;
  return {
    dimensions: [{ field: field.name, ...(grain ? { timeGrain: grain } : {}) }],
    measures,
    ...(calculations.length ? { calculations } : {}),
    filters: [...(base.filters ?? []), ...path.flatMap((step) => step.filters)],
    ...(!time && firstAlias ? { orderBy: [{ alias: firstAlias, direction: 'desc' as const }], limit: 50 } : {}),
    ...(base.respectsGlobalFilters !== undefined ? { respectsGlobalFilters: base.respectsGlobalFilters } : {}),
  };
}

/** The rows behind the path: bounded, only the columns the author chose or the Dataset's approved fields. */
export function exploreRowsQuery(base: TileQuery, path: ExploreStep[], columns: string[], limit = 100): TileQuery {
  return {
    dimensions: [],
    measures: [],
    detail: true,
    detailColumns: columns,
    limit,
    filters: [...(base.filters ?? []), ...path.flatMap((step) => step.filters)],
    ...(base.respectsGlobalFilters !== undefined ? { respectsGlobalFilters: base.respectsGlobalFilters } : {}),
  };
}

/** Columns for "See the rows": the author's detail columns, else the fields in the path and the tile, then other approved fields. */
export function rowColumns(base: TileQuery, path: ExploreStep[], fields: ExploreField[], authored?: string[]): string[] {
  const approved = new Set(fields.map((field) => field.name));
  if (authored?.length) return authored.filter((name) => approved.has(name)).slice(0, 12);
  const first = [
    ...path.flatMap((step) => step.filters.map((filter) => filter.field)),
    ...base.dimensions.map((dimension) => dimension.field),
  ];
  const ordered = [...first, ...fields.filter((field) => field.role !== 'key').map((field) => field.name), ...fields.map((field) => field.name)];
  return Array.from(new Set(ordered.filter((name) => approved.has(name)))).slice(0, 8);
}

/** Fields a reader may drill by from here: approved, not already held to one value, time fields last. */
export function drillByFields(fields: ExploreField[], path: ExploreStep[], current?: string): ExploreField[] {
  const held = new Set(path.flatMap((step) => step.filters.filter((filter) => filter.op === 'eq').map((filter) => filter.field.toLowerCase())));
  return fields
    .filter((field) => field.role !== 'attribute' || field.type === 'string' || field.type === 'boolean')
    .filter((field) => !held.has(field.name.toLowerCase()) && field.name !== current)
    .sort((left, right) => Number(left.role === 'time') - Number(right.role === 'time') || Number(left.role === 'key') - Number(right.role === 'key'));
}

/**
 * The explanation of a mark: its measure, at the clicked period (or the tile's
 * latest when the mark is a category), against the period before, inside the
 * reader's drills, the Explore path and the clicked category. When the tile
 * has no time grain, the Dataset's primary time field is used and the caller
 * must first find the latest period (`needsPeriod`).
 */
export function explainDefinitionFor(input: {
  item: LayoutItem;
  mark?: MarkContext;
  tile?: RunTile;
  path?: ExploreStep[];
  drills?: DashboardDatasetHierarchyDrill['steps'];
  fields?: ExploreField[];
  comparison?: DashboardDriverDefinitionV1['comparison'];
  anchor?: string;
}): { definition: DashboardDriverDefinitionV1 } | { needsPeriod: { timeField: string; grain: Grain } } | { unavailable: string } {
  const query = input.item.query as TileQuery | undefined;
  if (!query || query.detail) return { unavailable: 'Only a tile built from fields can be explained.' };
  const measure = input.mark?.measure?.name ?? query.measures[0]?.measure;
  if (!measure) return { unavailable: 'This tile has no measure to explain.' };
  const markTime = input.mark?.values.find((entry) => entry.timeGrain);
  const tileTime = query.dimensions.find((dimension) => grainOf(dimension.timeGrain));
  const primary = (input.fields ?? []).find((field) => field.role === 'time' && field.primary) ?? (input.fields ?? []).find((field) => field.role === 'time');
  const timeField = markTime?.field ?? tileTime?.field ?? primary?.name;
  const grain = markTime?.timeGrain ?? grainOf(tileTime?.timeGrain) ?? (primary ? (grainOf(['month', 'week', 'quarter', 'day', 'year'].find((candidate) => (primary.grains ?? ['month']).includes(candidate))) ?? 'month') : undefined);
  if (!timeField || !grain) return { unavailable: 'This data has no time field, so there is no change to explain.' };
  // Categories the reader pointed at, drills and the Explore path narrow both periods alike.
  const categoryFilters = (input.mark?.values ?? []).filter((entry) => !entry.timeGrain).map((entry) => ({ field: entry.field, op: 'eq' as const, values: [entry.value] }));
  const pathFilters = (input.path ?? []).flatMap((step) => step.filters)
    .filter((filter): filter is Filter & { op: 'eq' | 'in' | 'neq' | 'not_in' } => ['eq', 'in', 'neq', 'not_in'].includes(filter.op))
    .map((filter) => ({ field: filter.field, op: filter.op, values: (filter.values ?? []).filter(isScalar) }));
  const filters = [...drillFilters(input.drills), ...pathFilters, ...categoryFilters]
    .filter((filter) => filter.values && filter.values.length > 0)
    .map((filter) => ({ field: filter.field, op: filter.op as 'eq' | 'in' | 'neq' | 'not_in', values: (filter.values ?? []).filter(isScalar) }));
  const clicked = markTime ? calendarDate(markTime.value) : null;
  let anchor = input.anchor ?? (clicked ? periodStart(clicked, grain) : undefined);
  if (!anchor && tileTime && input.tile?.status === 'ok' && input.tile.result?.rows?.length) {
    const alias = tileQueryOutputAliases(query)[query.dimensions.indexOf(tileTime)]?.alias;
    anchor = alias ? explainablePeriod(input.tile.result.rows.map((row) => row[alias]), grain) ?? undefined : undefined;
  }
  if (!anchor) return { needsPeriod: { timeField, grain } };
  return {
    definition: {
      version: 1,
      measure,
      timeField,
      grain,
      anchor,
      comparison: input.comparison ?? 'previous_period',
      dimensions: ['*'],
      ...(filters.length ? { filters: dedupeFilters(filters) } : {}),
    },
  };
}

function dedupeFilters<T extends { field: string; op: string; values: Scalar[] }>(filters: T[]): T[] {
  const seen = new Set<string>();
  return filters.filter((filter) => {
    const key = `${filter.field}|${filter.op}|${JSON.stringify(filter.values)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The latest period a result shows, or the one before it while the latest is still running. */
export function explainablePeriod(values: unknown[], grain: Grain, today: Date = new Date()): string | null {
  const periods = Array.from(new Set(values.map(calendarDate).filter((date): date is string => Boolean(date)).map((date) => periodStart(date, grain)))).sort();
  const latest = periods.at(-1);
  if (!latest) return null;
  const current = periodStart(today.toISOString().slice(0, 10), grain);
  return latest === current && periods.length > 1 ? periods.at(-2)! : latest;
}

/** The menu for one mark, in the order a reader reaches for them. Disabled items say why. */
export type MarkActionId = 'keep' | 'exclude' | 'drill-down' | 'drill-by' | 'rows' | 'details' | 'explain' | 'ask';
export interface MarkMenuItem {
  id: MarkActionId;
  label: string;
  hint?: string;
  disabled?: string;
}

export function markMenuItems(input: {
  mark: MarkContext;
  keepField?: string;
  drillDown?: { toField: string };
  canDrillBy: boolean;
  hasDetailsPage: boolean;
  canExplain: boolean;
  canAsk: boolean;
  label?: (field: string) => string;
}): MarkMenuItem[] {
  const label = input.label ?? humanize;
  const category = input.mark.values.find((entry) => !entry.timeGrain && entry.alias === input.keepField);
  const items: MarkMenuItem[] = [];
  if (category) {
    items.push({ id: 'keep', label: `Keep only ${String(category.value)}`, hint: 'Filter this page to it' });
    items.push({ id: 'exclude', label: `Exclude ${String(category.value)}`, hint: 'Leave it out of this page' });
  }
  if (input.drillDown) items.push({ id: 'drill-down', label: `Drill down to ${label(input.drillDown.toField)}`, hint: 'Next level, in this tile' });
  items.push({ id: 'drill-by', label: 'Drill by…', hint: 'Break it down by any field', ...(input.canDrillBy ? {} : { disabled: 'This tile does not list the fields it can be broken down by.' }) });
  items.push({ id: 'rows', label: 'See the rows', hint: 'The records behind this', ...(input.canDrillBy ? {} : { disabled: 'This tile does not list its fields.' }) });
  if (input.hasDetailsPage) items.push({ id: 'details', label: 'Open details page', hint: 'With this value carried over' });
  items.push({ id: 'explain', label: 'Explain this', hint: 'What changed and what drove it', ...(input.canExplain ? {} : { disabled: 'There is no time field to compare periods on.' }) });
  if (input.canAsk) items.push({ id: 'ask', label: 'Ask about this', hint: 'AI, with this value and its filters' });
  return items;
}

/**
 * A question for AI about one mark. It names what the reader clicked but
 * carries no figure: the governed answer path decides which result values a
 * model may see (only a model on this machine sees them), so the question
 * must not smuggle one in.
 */
export function askAboutMarkQuestion(mark: MarkContext, title: string): string {
  const measure = mark.measure ? humanize(mark.measure.name) : title;
  return `In "${title}", what explains ${measure} for ${describeMark(mark)}, and what should I look at next?`;
}

// ─── Calendar helpers (UTC calendar periods, as the driver runtime uses) ────

function calendarDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  if (/^\d{4}$/.test(text)) return `${text}-01-01`;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

export function periodStart(date: string, grain: Grain): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  if (grain === 'year') return `${year}-01-01`;
  if (grain === 'quarter') return `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  if (grain === 'month') return `${year}-${String(month).padStart(2, '0')}-01`;
  if (grain === 'week') {
    const value = new Date(Date.UTC(year, month - 1, day));
    const weekday = value.getUTCDay();
    value.setUTCDate(value.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
    return value.toISOString().slice(0, 10);
  }
  return date.slice(0, 10);
}

export function nextPeriod(start: string, grain: Grain): string {
  const [year, month, day] = start.split('-').map(Number) as [number, number, number];
  const value = new Date(Date.UTC(year, month - 1, day));
  if (grain === 'year') value.setUTCFullYear(value.getUTCFullYear() + 1);
  else if (grain === 'quarter') value.setUTCMonth(value.getUTCMonth() + 3);
  else if (grain === 'month') value.setUTCMonth(value.getUTCMonth() + 1);
  else if (grain === 'week') value.setUTCDate(value.getUTCDate() + 7);
  else value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}
