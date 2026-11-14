import type { QueryResult, CellChartConfig, ResultColumnMeta } from '../../store/types';
import { formatChartValue } from '../../utils/value-format';

/**
 * Data-side chart helpers shared by the SVG charts in ChartOutput and the
 * ECharts renderer: which columns are measures, how categories and dates are
 * labelled, and how a missing value differs from zero.
 */

export type ChartType =
  | 'bar' | 'line' | 'area' | 'pie' | 'donut'
  | 'scatter' | 'heatmap' | 'funnel' | 'waterfall'
  | 'histogram' | 'gauge' | 'stacked-bar' | 'grouped-bar'
  | 'sankey' | 'kpi' | 'table';

export const DATE_NAME_RE = /date|time|at|day|month|year/i;
/** A column that names a period, whatever its type: a season, a year, a quarter, a month, a week. */
export const PERIOD_NAME_RE = /(^|_)(season|year|yr|fy|quarter|qtr|month|week|period)($|_)/i;
const LABEL_NAME_RE = /^(label|name|category|status|type|group)$/i;
const VALUE_NAME_RE = /^(value|count|total|revenue|amount|sum|avg|price|quantity|sales)$/i;

export function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number') return true;
  if (typeof v === 'string') return v.trim() !== '' && !isNaN(Number(v));
  return false;
}

function isStringLike(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number';
}

const IDENTIFIER_NAME_RE = /(^|_)(id|key|uuid|code)$/i;

/**
 * WHAT A CHART MAY PLOT AS A VALUE.
 *
 * A six-digit player id is a number at runtime and an identity in meaning: put
 * it on a value axis and it dwarfs the measure beside it, which is exactly how
 * a correct table became a misleading chart. The executed result carries its
 * own contract (`columnsMeta`: the kind, and the ref that owns the column), so
 * a key or a label is a dimension whatever its runtime type. Without a
 * contract, an identifier name and then the values decide, as before.
 */
export function isMeasureColumn(result: QueryResult, column: string): boolean {
  const meta = result.columnsMeta?.find((item) => item.name === column);
  if (meta) {
    if (meta.kind === 'text' || meta.kind === 'date' || meta.kind === 'boolean') return false;
    if (meta.ref?.startsWith('dimension:') || meta.ref?.startsWith('entity:')) return false;
    if (meta.ref?.startsWith('metric:') || meta.ref?.startsWith('measure:')) return true;
    return !IDENTIFIER_NAME_RE.test(column);
  }
  if (IDENTIFIER_NAME_RE.test(column)) return false;
  return result.rows.slice(0, 5).some((row) => isNumericValue(row[column]));
}

export function measureColumns(result: QueryResult): string[] {
  return result.columns.filter((column) => isMeasureColumn(result, column));
}

export function categoryColumns(result: QueryResult): string[] {
  return result.columns.filter((column) => !isMeasureColumn(result, column));
}

const VALID_CHART_TYPES = new Set<string>([
  'bar', 'line', 'area', 'pie', 'donut', 'scatter', 'heatmap',
  'funnel', 'waterfall', 'histogram', 'gauge', 'stacked-bar',
  'grouped-bar', 'sankey', 'kpi', 'table',
]);

/**
 * Resolve chart type: explicit config takes priority, heuristics as fallback.
 */
export function resolveChartType(result: QueryResult, chartConfig?: CellChartConfig): ChartType {
  if (chartConfig?.chart) {
    const c = chartConfig.chart.toLowerCase().replace(/_/g, '-');
    if (VALID_CHART_TYPES.has(c)) return c as ChartType;
  }
  return detectChartType(result);
}

/** Heuristic chart type detection from result columns and sample rows */
export function detectChartType(result: QueryResult): ChartType {
  const { columns, rows } = result;
  if (columns.length < 2 || rows.length === 0) return 'table';

  const col0 = columns[0];
  const col1 = columns[1];
  const sample = rows.slice(0, 5);

  // A chart needs something to measure; a table of identities is a table.
  if (measureColumns(result).length === 0) return 'table';
  const col1AllNumeric = isMeasureColumn(result, col1) && sample.every((r) => isNumericValue(r[col1]));
  const col0AllString = sample.every((r) => isStringLike(r[col0]));

  // Line chart: col[0] is date-like name and col[1] is numeric
  if (DATE_NAME_RE.test(col0) && col1AllNumeric && col0AllString) {
    return 'line';
  }

  // Bar chart: label/name/category col + value/count/total/revenue/amount col
  const labelCol = columns.find((c) => LABEL_NAME_RE.test(c));
  const valueCol = columns.find((c) => VALUE_NAME_RE.test(c) && isMeasureColumn(result, c));
  if (labelCol && valueCol) {
    const valueAllNumeric = sample.every((r) => isNumericValue(r[valueCol]));
    if (valueAllNumeric) return 'bar';
  }

  // Line chart: col[0] names a period stored as a number (SEASON 2012, YEAR, FISCAL_QUARTER) and
  // another column is the measure. A season is a time axis to read left to right, not a value to
  // scatter from 0 (new-user test B12: wins by season drew one column of dots at x = 2K).
  if (PERIOD_NAME_RE.test(col0) && sample.every((r) => isNumericValue(r[col0]) || isStringLike(r[col0]))
    && columns.some((column) => column !== col0 && isMeasureColumn(result, column) && sample.every((r) => isNumericValue(r[column])))) {
    return 'line';
  }

  // Scatter: two numeric columns
  const col0AllNumeric = isMeasureColumn(result, col0) && sample.every((r) => isNumericValue(r[col0]));
  if (col0AllNumeric && col1AllNumeric && columns.length >= 2) {
    return 'scatter';
  }

  // Bar chart: exactly 2 columns, col[0] string, col[1] numeric
  if (columns.length === 2 && col0AllString && col1AllNumeric) {
    return 'bar';
  }

  return 'table';
}

// ─── Shared Utils ─────────────────────────────────────────────────────────────

export function abbreviate(n: number, column = 'value', format?: CellChartConfig['format'], meta?: ResultColumnMeta): string {
  return formatChartValue(column, n, format, meta);
}

/** A chart must distinguish an unavailable measure from the real number zero. */
export function chartNumericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** The units contract for one column, when the result carries one. */
export function metaFor(result: QueryResult | undefined, column: string | undefined): ResultColumnMeta | undefined {
  return column ? result?.columnsMeta?.find((meta) => meta.name === column) : undefined;
}

export function formatDateLabel(val: string, maxLen = 8, monthBucket = false): string {
  // DATE values arrive as midnight-UTC ISO timestamps. Format in UTC so
  // "2026-01-01T00:00:00.000Z" doesn't render as "Dec 31" in western
  // timezones (and "2026-01-01" doesn't render as the previous day).
  if (/^\d{4}-\d{2}(-\d{2})?/.test(val)) {
    const monthOnly = /^\d{4}-\d{2}$/.test(val);
    const d = new Date(monthOnly ? `${val}-01T00:00:00Z` : val);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('en-US', monthOnly || monthBucket
        ? { year: 'numeric', month: 'short', timeZone: 'UTC' }
        : { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
  }
  return String(val).length > maxLen ? String(val).slice(0, maxLen) : String(val);
}

export function formatCategoryLabel(value: string, column: string, maxLen = 16): string {
  if (DATE_NAME_RE.test(column) || /^\d{4}-\d{2}(-\d{2})?(T|$)/.test(value)) {
    return formatDateLabel(value, maxLen, /month/i.test(column));
  }
  return value.length > maxLen ? `${value.slice(0, Math.max(1, maxLen - 1))}…` : value;
}

/** Charts drawn from one label and one value column. */
const LABEL_VALUE_CHARTS: ReadonlySet<ChartType> = new Set<ChartType>(['bar', 'line', 'area', 'stacked-bar', 'grouped-bar', 'pie', 'donut', 'funnel']);

/**
 * The fields a chart needs that its result does not have, by name; empty
 * when the chart can be drawn. A chart falls back to another column when the
 * one it names is missing, so this is only non-empty when nothing can stand
 * in: a bar of `lifetime_spend` over a result with only `customer_name`
 * crashed App Studio (V11, "prettyName" of undefined). `'a value'` stands
 * for a value column when the chart names none.
 */
export function chartMissingFields(result: QueryResult, chartType: ChartType, chartConfig?: CellChartConfig): string[] {
  if (!LABEL_VALUE_CHARTS.has(chartType) || result.rows.length === 0) return [];
  const { labelCol, valueCol } = pickColumns(result, chartConfig);
  if (labelCol !== undefined && valueCol !== undefined && result.columns.includes(labelCol) && result.columns.includes(valueCol)) return [];
  const named = [chartConfig?.x, chartConfig?.y, ...(chartConfig?.metrics ?? [])]
    .filter((name): name is string => typeof name === 'string' && name.length > 0 && !result.columns.includes(name));
  return named.length ? Array.from(new Set(named)) : ['a value'];
}

export function pickColumns(result: QueryResult, chartConfig?: CellChartConfig) {
  const categories = categoryColumns(result);
  const measures = measureColumns(result);
  const labelCol =
    (chartConfig?.x && result.columns.includes(chartConfig.x) ? chartConfig.x : undefined) ??
    result.columns.find((c) => LABEL_NAME_RE.test(c)) ??
    // A label beats the key it belongs to: names read, ids do not.
    categories.find((c) => /name|label|title/i.test(c)) ?? categories[0] ?? result.columns[0];
  const valueCol =
    (chartConfig?.y && result.columns.includes(chartConfig.y) ? chartConfig.y : undefined) ??
    result.columns.find((c) => VALUE_NAME_RE.test(c) && isMeasureColumn(result, c)) ??
    measures.find((c) => c !== labelCol) ?? result.columns[1];
  return { labelCol, valueCol };
}

