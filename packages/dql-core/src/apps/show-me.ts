/**
 * Show Me (RFC 0009 step 2).
 *
 * Ranks the charts a set of fields can draw, the way Tableau's Show Me does,
 * but says why: every chart comes back with a reason it fits or a reason it
 * does not. The ranking reads field roles (date or category), how many
 * measures and dimensions there are, how many values a dimension has when a
 * result is at hand, whether a measure adds up (a distinct count does not,
 * so it is never stacked or cut into slices), and the measures' units (two
 * units never share an axis quietly; there is no dual axis).
 *
 * The Studio shows the ranking next to the shelves, picking a chart
 * rearranges the shelves, and the AI planner takes the first choice for the
 * tiles it proposes. Pure: no I/O.
 */
import type { DatasetDescriptor } from '../datasets/descriptor.js';
import type { TileQuery } from './tile-query-types.js';
import { isMeasureRef, refName, type DashboardVizEncoding, type ShelfFieldRef } from './viz-encoding.js';
import { checkTileCalculations } from './tile-calcs.js';

export type ShowMeChart =
  | 'kpi' | 'line' | 'area' | 'bar' | 'column' | 'grouped_bar' | 'stacked_bar'
  | 'donut' | 'pie' | 'funnel' | 'scatter' | 'heatmap' | 'table' | 'pivot';

/** The `viz.type` a chart is stored as. Horizontal and vertical bars are both `bar`; the shelves set the direction. */
export type ShowMeVizType =
  | 'single_value' | 'line' | 'area' | 'bar' | 'grouped_bar' | 'stacked_bar'
  | 'donut' | 'pie' | 'funnel' | 'scatter' | 'heatmap' | 'table' | 'pivot';

/** Display order when charts tie, and for charts that do not fit. */
export const SHOW_ME_CHARTS: readonly ShowMeChart[] = [
  'kpi', 'line', 'area', 'bar', 'column', 'grouped_bar', 'stacked_bar', 'donut', 'pie', 'funnel', 'scatter', 'heatmap', 'table', 'pivot',
];

export const SHOW_ME_LABELS: Record<ShowMeChart, string> = {
  kpi: 'KPI',
  line: 'Line',
  area: 'Area',
  bar: 'Horizontal bars',
  column: 'Vertical bars',
  grouped_bar: 'Side-by-side bars',
  stacked_bar: 'Stacked bars',
  donut: 'Donut',
  pie: 'Pie',
  funnel: 'Funnel',
  scatter: 'Scatter',
  heatmap: 'Heatmap',
  table: 'Table',
  pivot: 'Pivot',
};

const VIZ: Record<ShowMeChart, ShowMeVizType> = {
  kpi: 'single_value',
  line: 'line',
  area: 'area',
  bar: 'bar',
  column: 'bar',
  grouped_bar: 'grouped_bar',
  stacked_bar: 'stacked_bar',
  donut: 'donut',
  pie: 'pie',
  funnel: 'funnel',
  scatter: 'scatter',
  heatmap: 'heatmap',
  table: 'table',
  pivot: 'pivot',
};

/** Lines or bar colours beyond this cannot be told apart. */
export const SHOW_ME_MAX_SERIES = 8;
/** Slices beyond this cannot be compared. */
export const SHOW_ME_MAX_SLICES = 6;

export interface ShowMeDimension {
  name: string;
  label?: string;
  time?: boolean;
  /** Distinct values in the current result, when there is one. */
  cardinality?: number;
}

export interface ShowMeMeasure {
  name: string;
  label?: string;
  /** Adds up across categories: parts of a stack or a pie sum to the whole. */
  additive?: boolean;
  /** Adds up across periods: a filled area reads as volume. */
  additiveOverTime?: boolean;
  /** Unit family, such as `currency:USD`, `percent`, `count`. Two units never share an axis quietly. */
  unit?: string;
  /** False when the current result holds a negative value. */
  nonNegative?: boolean;
}

export interface ShowMeInput {
  dimensions: ShowMeDimension[];
  measures: ShowMeMeasure[];
  /** Row details: individual rows, not totals. */
  rowDetail?: boolean;
  /** A period comparison: current, prior and change come back together. */
  comparison?: boolean;
}

export interface ShowMeSuggestion {
  chart: ShowMeChart;
  label: string;
  viz: ShowMeVizType;
  available: boolean;
  /** The first available chart. */
  recommended: boolean;
  /** Higher reads better. Zero when the chart does not fit. */
  score: number;
  /** Why the chart fits, or why it does not. */
  reason: string;
  /** Where the fields go for this chart. Absent for a table, which shows the shelves as they are. */
  encoding?: DashboardVizEncoding;
}

type Fit = { score: number; reason: string; encoding?: DashboardVizEncoding } | { unavailable: string };

interface Context {
  dims: ShowMeDimension[];
  measures: ShowMeMeasure[];
  time?: ShowMeDimension;
  cats: ShowMeDimension[];
  mixedUnits: boolean;
  comparison: boolean;
}

const titleCase = (name: string) => name.replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
const named = (field: { name: string; label?: string }) => field.label?.trim() || titleCase(field.name);
const list = (fields: Array<{ name: string; label?: string }>) => {
  const names = fields.map(named);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};
const dim = (field: ShowMeDimension): ShelfFieldRef => ({ dimension: field.name });
const measure = (field: ShowMeMeasure): { measure: string } => ({ measure: field.name });
const encoding = (parts: Omit<DashboardVizEncoding, 'version'>): DashboardVizEncoding => ({ version: 1, ...parts });
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const STAGE_NAME = /(^|[_\s-])(stage|step|funnel|phase)s?($|[_\s-])/i;

/** The two dimensions of a crossed chart: time runs along the axis; otherwise the one with more values does. */
function axisAndSplit(context: Context): { axis: ShowMeDimension; split: ShowMeDimension } {
  const [first, second] = context.dims as [ShowMeDimension, ShowMeDimension];
  if (context.time) return { axis: context.time, split: context.cats[0]! };
  if (first.cardinality !== undefined && second.cardinality !== undefined && second.cardinality > first.cardinality) {
    return { axis: second, split: first };
  }
  return { axis: first, split: second };
}

function unitClash(measures: ShowMeMeasure[]): string {
  const [a, b] = measures;
  return `${named(a!)} and ${named(b!)} use different units but would share one axis, so the smaller one flattens.`;
}

function kpi(c: Context): Fit {
  // A date alone is the KPI's trend: the latest period, its change and a sparkline.
  const trend = c.dims.length === 1 && c.time ? c.time : undefined;
  if (c.dims.length && !trend) return { unavailable: `A KPI shows one number. Remove ${list(c.cats.length ? c.cats : c.dims)} to show one.` };
  if (c.measures.length !== 1) return { unavailable: `A KPI shows one number, and the shelves hold ${plural(c.measures.length, 'measure')}. Add one KPI tile for each.` };
  if (c.comparison) return { unavailable: 'A period comparison returns current, prior and change; a table or chart shows them together.' };
  const [only] = c.measures as [ShowMeMeasure];
  if (trend) {
    return { score: 50, reason: `${named(only)} for the latest ${named(trend).toLowerCase()}, its change from the one before, and the trend.`, encoding: encoding({ columns: [dim(trend)], rows: [measure(only)] }) };
  }
  return { score: 100, reason: `${named(only)} as one number.`, encoding: encoding({ columns: [], rows: [measure(only)] }) };
}

function line(c: Context): Fit {
  if (!c.time) {
    return { unavailable: c.cats.length
      ? `A line joins points in time order, and ${named(c.cats[0]!)} is not a date. Bars compare categories.`
      : 'A line needs a date on Columns.' };
  }
  if (c.cats.length > 1) return { unavailable: `A line has room for one split by colour; ${list(c.cats.slice(1))} would merge points into one. Use a table.` };
  const split = c.cats[0];
  if (split?.time) return { unavailable: `${named(split)} is a date too. A heatmap crosses two dates.` };
  if (split && c.measures.length > 1) return { unavailable: `A split by colour draws one measure, and the shelves hold ${c.measures.length}.` };
  if (split && (split.cardinality ?? 0) > SHOW_ME_MAX_SERIES) {
    return { unavailable: `${named(split)} has ${split.cardinality} values; more than ${SHOW_ME_MAX_SERIES} lines cannot be told apart by colour. A heatmap shows them all.` };
  }
  if (c.measures.length > SHOW_ME_MAX_SERIES) return { unavailable: `More than ${SHOW_ME_MAX_SERIES} lines cannot be told apart by colour.` };
  const drawn = encoding({ columns: [dim(c.time)], rows: c.measures.map(measure), ...(split ? { color: dim(split) } : {}) });
  if (c.mixedUnits) return { score: 70, reason: `${unitClash(c.measures)} One tile for each reads better.`, encoding: drawn };
  const over = `${list(c.measures)} over ${named(c.time)}`;
  if (split) {
    return { score: split.cardinality === undefined ? 95 : 100, reason: `${over}, one line for each ${named(split)}: trends compare side by side.`, encoding: drawn };
  }
  return { score: 100, reason: `${over}: the trend reads left to right.`, encoding: drawn };
}

function area(c: Context): Fit {
  if (!c.time) return { unavailable: 'An area needs a date on Columns.' };
  if (c.cats.length || c.measures.length > 1) return { unavailable: 'An area draws one measure over time; overlapping areas hide each other. Use a line.' };
  const [only] = c.measures as [ShowMeMeasure];
  if (!only.additiveOverTime) return { unavailable: `${named(only)} does not add up across periods, so a filled area would suggest a total that is not there. Use a line.` };
  return { score: 80, reason: `${named(only)} over ${named(c.time)}, filled in: stresses the volume in each period.`, encoding: encoding({ columns: [dim(c.time)], rows: [measure(only)] }) };
}

function oneDimensionBars(c: Context): string | undefined {
  if (!c.dims.length) return 'Bars need a dimension to compare.';
  if (c.dims.length > 1) return `Bars compare one dimension. For ${named(c.dims[1]!)} as well, use stacked or side-by-side bars.`;
  if (c.measures.length > 1) return 'One bar for each value needs one measure; side-by-side bars show several.';
  return undefined;
}

function bar(c: Context): Fit {
  const refused = oneDimensionBars(c);
  if (refused) return { unavailable: refused };
  if (c.time) return { unavailable: `${named(c.time)} is a date, and dates run left to right. Use a line or vertical bars.` };
  const [category] = c.cats as [ShowMeDimension];
  const [only] = c.measures as [ShowMeMeasure];
  return { score: 100, reason: `Compares ${named(only)} across ${named(category)}; names read easily down the side.`, encoding: encoding({ columns: [measure(only)], rows: [dim(category)] }) };
}

function column(c: Context): Fit {
  const refused = oneDimensionBars(c);
  if (refused) return { unavailable: refused };
  const [axis] = c.dims as [ShowMeDimension];
  const [only] = c.measures as [ShowMeMeasure];
  const drawn = encoding({ columns: [dim(axis)], rows: [measure(only)] });
  if (c.time) return { score: 75, reason: `One bar for each period: compares ${named(only)} period by period.`, encoding: drawn };
  return { score: 80, reason: `${named(only)} by ${named(axis)} as upright bars; long names fit better on horizontal bars.`, encoding: drawn };
}

function groupedBar(c: Context): Fit {
  if (!c.dims.length) return { unavailable: 'Side-by-side bars need a dimension to compare.' };
  if (c.dims.length > 2) return { unavailable: `Three dimensions read best as a table.` };
  if (c.dims.length === 2) {
    if (c.measures.length > 1) return { unavailable: `Side-by-side bars split one measure by a second dimension, and the shelves hold ${c.measures.length} measures.` };
    const { axis, split } = axisAndSplit(c);
    const values = split.cardinality;
    if ((values ?? 0) > SHOW_ME_MAX_SERIES) return { unavailable: `${named(split)} has ${values} values; that many bars side by side cannot be read.` };
    const [only] = c.measures as [ShowMeMeasure];
    const drawn = c.time
      ? encoding({ columns: [dim(axis)], rows: [measure(only)], color: dim(split) })
      : encoding({ columns: [measure(only)], rows: [dim(axis)], color: dim(split) });
    const score = values === undefined ? 60 : values <= 4 ? 65 : 50;
    return { score, reason: `${named(only)} for each ${named(axis)}, one bar for each ${named(split)} side by side.`, encoding: drawn };
  }
  if (c.measures.length < 2) return { unavailable: 'Side-by-side bars need a second measure, or a second dimension on Colour.' };
  if (c.measures.length > SHOW_ME_MAX_SERIES) return { unavailable: `More than ${SHOW_ME_MAX_SERIES} measures side by side cannot be told apart.` };
  const [axis] = c.dims as [ShowMeDimension];
  const drawn = c.time
    ? encoding({ columns: [dim(axis)], rows: c.measures.map(measure) })
    : encoding({ columns: c.measures.map(measure), rows: [dim(axis)] });
  if (c.mixedUnits) return { score: c.time ? 45 : 55, reason: `${unitClash(c.measures)} A scatter gives each its own axis.`, encoding: drawn };
  const score = (c.time ? 60 : 90) - 5 * (c.measures.length - 2);
  return { score, reason: `${list(c.measures)} side by side for each ${named(axis)}.`, encoding: drawn };
}

function stackedBar(c: Context): Fit {
  if (c.dims.length < 2) return { unavailable: 'Stacked bars split each bar by a second dimension. Add one to Colour.' };
  if (c.dims.length > 2) return { unavailable: 'Three dimensions read best as a table.' };
  if (c.measures.length > 1) return { unavailable: 'Stacking adds values together, so it takes one measure split by a dimension.' };
  const [only] = c.measures as [ShowMeMeasure];
  const { axis, split } = axisAndSplit(c);
  if (!only.additive) return { unavailable: `${named(only)} does not add up across ${named(split)}, so the stacked parts would not match the bar's total.` };
  if (only.nonNegative === false) return { unavailable: `${named(only)} has negative values, which a stack cannot show.` };
  if ((split.cardinality ?? 0) > SHOW_ME_MAX_SERIES) return { unavailable: `${named(split)} has ${split.cardinality} values; more than ${SHOW_ME_MAX_SERIES} colours in a stack cannot be told apart.` };
  const drawn = c.time
    ? encoding({ columns: [dim(axis)], rows: [measure(only)], color: dim(split) })
    : encoding({ columns: [measure(only)], rows: [dim(axis)], color: dim(split) });
  const score = c.time ? 78 : split.cardinality === undefined ? 85 : 90;
  return { score, reason: `Each ${named(axis)} bar splits into ${named(split)}; the parts add up to its ${named(only)}.`, encoding: drawn };
}

function partsOfWhole(c: Context, what: string): { category: ShowMeDimension; only: ShowMeMeasure } | { unavailable: string } {
  if (c.time && c.dims.length === 1) return { unavailable: `${what} needs categories, not dates.` };
  if (c.dims.length !== 1) return { unavailable: `${what} shows one dimension.` };
  if (c.measures.length !== 1) return { unavailable: `${what} shows one measure.` };
  const [only] = c.measures as [ShowMeMeasure];
  if (only.nonNegative === false) return { unavailable: `${named(only)} has negative values, which ${what.toLowerCase()} cannot show.` };
  return { category: c.cats[0]!, only };
}

function slices(c: Context, chart: 'donut' | 'pie'): Fit {
  const what = chart === 'donut' ? 'A donut' : 'A pie';
  const parts = partsOfWhole(c, what);
  if ('unavailable' in parts) return parts;
  const { category, only } = parts;
  if (!only.additive) return { unavailable: `${named(only)} does not add up across ${named(category)}, so the slices would not make a whole.` };
  const values = category.cardinality;
  if ((values ?? 0) > SHOW_ME_MAX_SLICES) return { unavailable: `${named(category)} has ${values} values; more than ${SHOW_ME_MAX_SLICES} slices cannot be compared. Use bars.` };
  const base = chart === 'donut' ? 60 : 55;
  const score = values === undefined ? base - 15 : values <= 3 ? base + 10 : base;
  const caveat = values === undefined ? ` Reads well up to ${SHOW_ME_MAX_SLICES} slices.` : '';
  return { score, reason: `Each ${named(category)}'s share of the total ${named(only)}.${caveat}`, encoding: encoding({ columns: [measure(only)], rows: [dim(category)] }) };
}

function funnel(c: Context): Fit {
  const parts = partsOfWhole(c, 'A funnel');
  if ('unavailable' in parts) return parts;
  const { category, only } = parts;
  if ((category.cardinality ?? 0) > SHOW_ME_MAX_SERIES) return { unavailable: `${named(category)} has ${category.cardinality} values; a funnel reads well with a few ordered steps.` };
  const drawn = encoding({ columns: [measure(only)], rows: [dim(category)] });
  if (STAGE_NAME.test(category.name) || STAGE_NAME.test(category.label ?? '')) {
    return { score: 105, reason: `${named(category)} reads as ordered steps: the funnel shows how ${named(only)} narrows from one to the next.`, encoding: drawn };
  }
  return { score: 30, reason: 'For ordered steps, such as the stages of a pipeline.', encoding: drawn };
}

function scatter(c: Context): Fit {
  if (c.measures.length < 2) return { unavailable: 'A scatter compares two measures. Add a second.' };
  if (c.measures.length > 3) return { unavailable: `A scatter puts two measures on the axes and a third on Size, and the shelves hold ${c.measures.length}.` };
  if (!c.dims.length) return { unavailable: 'A scatter needs a dimension, one point for each value. Add one to Detail.' };
  if (c.time) return { unavailable: `${named(c.time)} is a date and belongs on an axis. Use a line.` };
  const [x, y, size] = c.measures as [ShowMeMeasure, ShowMeMeasure, ShowMeMeasure?];
  // The dimension with the fewest values colours the points; the rest are Detail.
  const ranked = [...c.cats].sort((left, right) => (left.cardinality ?? Infinity) - (right.cardinality ?? Infinity));
  const colour = c.cats.length > 1 && (ranked[0]!.cardinality ?? 0) <= SHOW_ME_MAX_SERIES ? ranked[0] : undefined;
  const detail = c.cats.filter((field) => field !== colour);
  const points = Math.max(...c.cats.map((field) => field.cardinality ?? -1));
  let score = points >= 12 ? 95 : points >= 0 && points < 6 ? 40 : 70;
  // Two units on one axis flatten one of them; a scatter gives each its own, given enough points.
  if (c.mixedUnits && c.dims.length === 1 && !(points >= 0 && points < 6)) score = Math.max(score, 92);
  if (c.dims.length > 1) score = Math.min(score, 50);
  const few = points >= 0 && points < 6 ? ' With so few points, bars compare them better.' : '';
  return {
    score,
    reason: `Each ${named(detail[0] ?? colour!)} is a point: ${named(y)} against ${named(x)}${size ? `, sized by ${named(size)}` : ''}. Shows how they move together and picks out outliers.${few}`,
    encoding: encoding({
      columns: [measure(x)],
      rows: [measure(y)],
      ...(size ? { size: measure(size) } : {}),
      ...(colour ? { color: dim(colour) } : {}),
      ...(detail.length ? { detail: detail.map((field) => ({ dimension: field.name })) } : {}),
    }),
  };
}

function heatmap(c: Context): Fit {
  if (c.dims.length !== 2) return { unavailable: c.dims.length < 2 ? 'A heatmap crosses two dimensions. Add a second.' : `A heatmap crosses two dimensions, and the shelves hold ${c.dims.length}.` };
  if (c.measures.length !== 1) return { unavailable: 'A heatmap shades cells by one measure.' };
  const [only] = c.measures as [ShowMeMeasure];
  const { axis, split } = axisAndSplit(c);
  // Time runs across; otherwise the dimension with more values lists down the side.
  const across = c.time ? axis : split;
  const down = c.time ? split : axis;
  const crowded = (split.cardinality ?? 0) > SHOW_ME_MAX_SERIES;
  const score = crowded ? 96 : split.time ? 90 : c.time ? 70 : 80;
  const why = crowded ? ` ${named(split)} has ${split.cardinality} values, too many colours for lines or stacks.` : '';
  return {
    score,
    reason: `${named(only)} for each ${named(across)} and ${named(down)}, as shaded cells: patterns across both stand out.${why}`,
    encoding: encoding({ columns: [dim(across)], rows: [dim(down)], color: measure(only) }),
  };
}

/**
 * A pivot: rows down the side, one dimension across, measures in the cells,
 * with totals the warehouse recomputes. It reads well when two or more
 * dimensions cross; a date runs across.
 */
function pivot(c: Context): Fit {
  if (c.comparison) return { unavailable: 'A period comparison already lays out current, prior and change.' };
  if (!c.dims.length) return { unavailable: 'A pivot needs a dimension to list down the side.' };
  const across = c.time ?? (c.dims.length > 1 ? c.dims[c.dims.length - 1]! : undefined);
  const down = c.dims.filter((field) => field !== across);
  const why = c.dims.length === 1
    ? `${named(c.dims[0]!)} down the side with a total row.`
    : `${list(down)} down the side and ${named(across!)} across, with subtotals and totals recomputed from the rows.`;
  return {
    score: c.dims.length >= 2 ? 58 : 15,
    reason: why,
    encoding: encoding({ columns: across ? [dim(across)] : [], rows: [...down.map(dim), ...c.measures.map(measure)] }),
  };
}

function table(c: Context, rowDetail: boolean): Fit {
  if (rowDetail) return { score: 100, reason: 'Row details are individual rows, not totals; only a table shows them one by one.' };
  if (!c.measures.length) return { score: 100, reason: c.dims.length ? `Lists the values of ${list(c.dims)}. Add a measure to draw a chart.` : 'Add fields to the shelves.' };
  if (c.dims.length >= 3) return { score: 100, reason: `${c.dims.length} dimensions: a table keeps every combination readable.` };
  if (!c.dims.length && c.measures.length > 1) return { score: 90, reason: `${list(c.measures)} as totals side by side.` };
  if (c.dims.length === 2 && c.measures.length > 1) return { score: c.time ? 90 : 85, reason: `${c.measures.length} measures by two dimensions: a table keeps them all readable.` };
  if (c.measures.length >= 4) return { score: 80, reason: `${c.measures.length} measures read best as columns of numbers.` };
  if (c.mixedUnits && c.dims.length === 1) return { score: 60, reason: `${list(c.measures)} use different units; a table shows each in its own column.` };
  return { score: 20, reason: 'Every value as a number, for reading exact figures.' };
}

/**
 * Every chart for these fields, best first: the ones that fit ranked by how
 * well they read, then the ones that do not, each with its reason.
 */
export function showMe(input: ShowMeInput): ShowMeSuggestion[] {
  const time = input.dimensions.find((field) => field.time);
  const units = new Set(input.measures.map((field) => field.unit).filter(Boolean));
  const context: Context = {
    dims: input.dimensions,
    measures: input.measures,
    ...(time ? { time } : {}),
    cats: input.dimensions.filter((field) => field !== time),
    mixedUnits: units.size > 1,
    comparison: Boolean(input.comparison),
  };
  const fits: Record<ShowMeChart, () => Fit> = {
    kpi: () => kpi(context),
    line: () => line(context),
    area: () => area(context),
    bar: () => bar(context),
    column: () => column(context),
    grouped_bar: () => groupedBar(context),
    stacked_bar: () => stackedBar(context),
    donut: () => slices(context, 'donut'),
    pie: () => slices(context, 'pie'),
    funnel: () => funnel(context),
    scatter: () => scatter(context),
    heatmap: () => heatmap(context),
    table: () => table(context, Boolean(input.rowDetail)),
    pivot: () => pivot(context),
  };
  const blocked = input.rowDetail
    ? 'Row details are individual rows, not totals; only a table shows them.'
    : !input.measures.length ? 'Add a measure to draw a chart.' : undefined;
  const ranked = SHOW_ME_CHARTS.map((chart, order) => {
    const fit: Fit = blocked && chart !== 'table' ? { unavailable: blocked } : fits[chart]();
    const suggestion: ShowMeSuggestion = 'unavailable' in fit
      ? { chart, label: SHOW_ME_LABELS[chart], viz: VIZ[chart], available: false, recommended: false, score: 0, reason: fit.unavailable }
      : { chart, label: SHOW_ME_LABELS[chart], viz: VIZ[chart], available: true, recommended: false, score: fit.score, reason: fit.reason, ...(fit.encoding ? { encoding: fit.encoding } : {}) };
    return { suggestion, order };
  });
  ranked.sort((left, right) => (right.suggestion.score - left.suggestion.score) || (left.order - right.order));
  const suggestions = ranked.map((entry) => entry.suggestion);
  if (suggestions[0]?.available) suggestions[0] = { ...suggestions[0], recommended: true };
  return suggestions;
}

/** The chart Show Me puts first. There is always one: a table fits anything. */
export function showMeFirstChoice(input: ShowMeInput): ShowMeSuggestion {
  return showMe(input)[0]!;
}

/** What Show Me needs to know about a field beyond its name. */
export interface ShowMeFacts {
  dimension: (name: string) => Omit<ShowMeDimension, 'name'>;
  measure: (name: string) => Omit<ShowMeMeasure, 'name'>;
}

/**
 * The fields the shelves draw: dimensions on the axes, Colour and Detail, in
 * that order, and measures on the axes, Colour and Size. Label and Tooltip
 * measures ride along without being drawn, so they stay where they are.
 */
export function showMeInputFromEncoding(encoding: DashboardVizEncoding, facts: ShowMeFacts): ShowMeInput {
  const refs: ShelfFieldRef[] = [
    ...encoding.columns,
    ...encoding.rows,
    ...(encoding.color ? [encoding.color] : []),
    ...(encoding.size ? [encoding.size] : []),
    ...(encoding.detail ?? []),
  ];
  const seen = new Set<string>();
  const dimensions: ShowMeDimension[] = [];
  const measures: ShowMeMeasure[] = [];
  for (const ref of refs) {
    const key = `${isMeasureRef(ref) ? 'm' : 'd'}:${refName(ref).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isMeasureRef(ref)) measures.push({ ...facts.measure(ref.measure), name: ref.measure });
    else dimensions.push({ ...facts.dimension(ref.dimension), name: ref.dimension });
  }
  return { dimensions, measures };
}

/** The fields a tile query selects, in its order. */
export function showMeInputFromQuery(query: TileQuery, facts: ShowMeFacts): ShowMeInput {
  return {
    dimensions: query.dimensions.map((entry) => ({ ...facts.dimension(entry.field), name: entry.field })),
    measures: [
      ...query.measures.map((entry) => ({ ...facts.measure(entry.measure), name: entry.measure })),
      ...(query.calculations ?? []).map((calculation) => ({ ...facts.measure(calculation.id), name: calculation.id })),
    ],
    ...(query.detail ? { rowDetail: true } : {}),
    ...(query.comparison ? { comparison: true } : {}),
  };
}

/**
 * Field facts from a Dataset contract: which dimensions are dates, which
 * measures add up, and their units. A result, when there is one, adds how
 * many values a dimension has and whether a measure goes negative.
 */
export function showMeFactsFromDescriptor(
  descriptor: DatasetDescriptor,
  observed: { cardinality?: (dimension: string) => number | undefined; nonNegative?: (measure: string) => boolean | undefined } = {},
  /** The tile's query, so its calculations are known by their output names. */
  query?: TileQuery,
): ShowMeFacts {
  // A table's measure usually shares its column's name (`lifetime_spend` is
  // both a number column and the sum of it): a measure is looked up among
  // measures, a dimension among fields, or the column hides the measure and
  // a summed amount reads as one that "does not add up" (new-user round 3).
  const findField = (name: string) => descriptor.fields.find((field) => field.kind === 'physical' && field.name.toLowerCase() === name.toLowerCase())
    ?? descriptor.fields.find((field) => field.name.toLowerCase() === name.toLowerCase());
  const findMeasure = (name: string) => descriptor.fields.find((field) => field.kind === 'measure' && field.name.toLowerCase() === name.toLowerCase())
    ?? descriptor.fields.find((field) => field.name.toLowerCase() === name.toLowerCase());
  const calculations = new Map((query?.calculations?.length ? checkTileCalculations(descriptor, query).outputs : [])
    .map((output) => [output.id.toLowerCase(), output]));
  return {
    dimension: (name) => {
      const field = findField(name);
      const time = Boolean(field && field.kind === 'physical' && (field.role === 'time' || field.type === 'date' || field.type === 'timestamp'));
      const cardinality = observed.cardinality?.(name);
      return { time, ...(cardinality !== undefined ? { cardinality } : {}) };
    },
    measure: (name) => {
      const field = findMeasure(name);
      const nonNegative = observed.nonNegative?.(name);
      const calculation = calculations.get(name.toLowerCase());
      if (calculation && (!field || field.kind !== 'measure')) {
        const unit = calculation.facts.unit;
        return {
          additive: calculation.facts.additive.entities,
          additiveOverTime: calculation.facts.additive.time,
          unit: unit.kind === 'currency' ? `currency:${unit.currency ?? ''}` : unit.kind === 'ratio' ? 'percent' : unit.kind,
          ...(nonNegative !== undefined ? { nonNegative } : {}),
        };
      }
      if (!field || field.kind !== 'measure') return nonNegative !== undefined ? { nonNegative } : {};
      const unit = field.format?.kind === 'currency'
        ? `currency:${field.format.currency ?? ''}`
        : field.format?.kind === 'percent' || field.aggregation === 'ratio'
          ? 'percent'
          : field.aggregation === 'count' || field.aggregation === 'count_distinct' ? 'count' : 'number';
      return {
        additive: field.additivity.entities === 'additive',
        additiveOverTime: field.additivity.time === 'additive',
        unit,
        ...(nonNegative !== undefined ? { nonNegative } : {}),
      };
    },
  };
}

/**
 * Put a Show Me choice on the shelves: the axes, Colour, Size and Detail
 * come from the choice; Label and Tooltip measures and the author's names
 * and formats stay.
 */
export function applyShowMe(current: DashboardVizEncoding, suggestion: ShowMeSuggestion): DashboardVizEncoding {
  if (!suggestion.encoding) return current;
  return {
    ...suggestion.encoding,
    ...(current.label?.length ? { label: current.label } : {}),
    ...(current.tooltip?.length ? { tooltip: current.tooltip } : {}),
    ...(current.fields && Object.keys(current.fields).length ? { fields: current.fields } : {}),
  };
}
