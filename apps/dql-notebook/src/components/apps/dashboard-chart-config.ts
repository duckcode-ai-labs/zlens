import { encodingChartColumns, type DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';
import { isNonAdditiveColumnName } from '@zlens/core/datasets/result-fields';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import type { CellChartConfig, QueryResult, ResultColumnMeta } from '../../store/types';
import { CHART_TYPE_OPTIONS } from '../output/ChartOutput';

type DashboardTileChartInput = {
  title?: string;
  query?: TileQuery;
  viz: { type?: string; options?: Record<string, unknown>; style?: CellChartConfig['style']; encoding?: DashboardVizEncoding };
};

const timeDimension = (query: TileQuery) => (dimension: string) => query.dimensions.some((entry) => entry.field.toLowerCase() === dimension.toLowerCase() && Boolean(entry.timeGrain));

/**
 * What a tile's shelves (RFC 0009) tell the renderer, in result columns: the
 * axes, orientation, colour and size, label and tooltip measures. Empty for a
 * tile without shelves, which keeps drawing exactly as before.
 */
export function encodedChartConfig(item: DashboardTileChartInput): Partial<CellChartConfig> {
  const encoding = item.viz.encoding;
  // A pivot lays out its own rows and columns from the shelves.
  if (!encoding || !item.query || item.viz.type === 'pivot') return {};
  const columns = encodingChartColumns(encoding, item.query, timeDimension(item.query));
  // Shelves that read as a table are drawn as a table, whatever chart type
  // the page stores: a chart would have to merge rows into one mark.
  if (columns.chart.kind === 'table' && (item.viz.type ?? 'table') !== 'table') return { chart: 'table' };
  return {
    ...(columns.x ? { x: columns.x } : {}),
    ...(columns.y ? { y: columns.y } : {}),
    ...(columns.metrics?.length ? { metrics: columns.metrics } : {}),
    ...(columns.color ? { color: columns.color } : {}),
    ...(columns.size ? { size: columns.size } : {}),
    ...(columns.orientation ? { orientation: columns.orientation } : {}),
    ...(columns.labelColumns.length ? { labelColumns: columns.labelColumns } : {}),
    ...(columns.tooltipColumns.length ? { tooltipColumns: columns.tooltipColumns } : {}),
  };
}

/**
 * A tile's result with the author's per-field names and formats from its
 * shelves written into the column metadata, so the table, the chart, the
 * tooltip and exports all show them.
 */
export function encodedTileResult<T extends QueryResult | undefined>(item: DashboardTileChartInput, result: T): T {
  const encoding = item.viz.encoding;
  if (!result || !encoding?.fields || !item.query) return result;
  const { columnSettings } = encodingChartColumns(encoding, item.query, timeDimension(item.query));
  if (!Object.keys(columnSettings).length) return result;
  const existing = new Map((result.columnsMeta ?? []).map((meta) => [meta.name, meta]));
  const columnsMeta: ResultColumnMeta[] = result.columns.map((name) => {
    const meta: ResultColumnMeta = existing.get(name) ?? { name, kind: 'text' };
    const settings = columnSettings[name];
    if (!settings) return meta;
    const format = settings.format;
    return {
      ...meta,
      ...(settings.label ? { label: settings.label } : {}),
      ...(format && format.kind !== 'compact' ? { kind: format.kind } : {}),
      ...(format?.kind === 'compact' ? { notation: 'compact' as const, ...(meta.kind === 'text' ? { kind: 'number' as const } : {}) } : {}),
      ...(format?.kind === 'percent' && meta.kind !== 'percent' ? { unit: 'fraction' } : {}),
      ...(format?.decimals !== undefined ? { fixedDecimals: format.decimals } : {}),
    };
  }).filter((meta) => meta.kind !== 'text' || meta.label || existing.has(meta.name));
  return { ...result, columnsMeta };
}

/**
 * The chart types the client can actually render, derived from the chart engine
 * rather than restated. A dashboard `viz.type` outside this set (the server also
 * accepts `pivot`, `map`, `text` and `heading`) falls back to `table`, because
 * there is no renderer for it here.
 */
const CHART_TYPES = new Set<string>(['table', ...CHART_TYPE_OPTIONS.map((option) => option.value)]);

export function normalizeDashboardChartType(value: unknown): string {
  const normalized = String(value ?? 'table').toLowerCase().replace(/_/g, '-');
  if (normalized === 'single-value') return 'kpi';
  return CHART_TYPES.has(normalized) ? normalized : 'table';
}

export function mergeDashboardTileChartConfig(
  item: DashboardTileChartInput,
  base?: CellChartConfig,
): CellChartConfig {
  const rawOptions = item.viz.options ?? {};
  const options = rawOptions as Partial<CellChartConfig>;
  // Dashboard documents historically used `field` and the documented format
  // uses `valueField`; ChartOutput uses `y`. Normalize all three here so KPI
  // cards display the metric the author selected instead of the first numeric
  // column returned by a multi-measure block.
  const valueField = typeof rawOptions.valueField === 'string'
    ? rawOptions.valueField
    : typeof rawOptions.field === 'string'
      ? rawOptions.field
      : undefined;
  return {
    ...(base ?? {}),
    ...options,
    ...encodedChartConfig(item),
    // The dashboard document owns the tile presentation. A reusable block may
    // carry a default chart, but that must not turn an explicitly-authored KPI
    // tile back into the block's bar/line/table visualization.
    chart: normalizeDashboardChartType(encodedChartConfig(item).chart ?? options.chart ?? item.viz.type ?? base?.chart),
    y: encodedChartConfig(item).y ?? options.y ?? valueField ?? base?.y,
    title: options.title ?? base?.title ?? item.title,
    colorPalette: options.colorPalette ?? item.viz.style?.palette ?? base?.colorPalette ?? 'dql',
    ...(item.viz.style ? { style: item.viz.style } : {}),
    // Values on the bars of an App chart with few bars (V12), unless its style says otherwise.
    valueLabels: 'auto',
  };
}

/**
 * A KPI over several rows of an average or a per-unit value (points per
 * game, a rate): adding the rows up is wrong (115.89 + 119.29 is not points
 * per game), so the rows are shown as they are instead of one summed number.
 */
export function kpiRowsAreAverages(result: QueryResult, valueField?: string): boolean {
  return Boolean(valueField) && result.rows.length > 1 && result.columns.includes(valueField!) && isNonAdditiveColumnName(valueField!);
}

export function summarizeDashboardKpiResult(result: QueryResult, valueField?: string): QueryResult {
  if (!valueField || result.rows.length <= 1 || !result.columns.includes(valueField)) return result;
  if (kpiRowsAreAverages(result, valueField)) return result;

  const values = result.rows
    .map((row) => row[valueField])
    .filter((value): value is number | string => (
      typeof value === 'number'
      || (typeof value === 'string' && value.trim() !== '')
    ))
    .map(Number)
    .filter(Number.isFinite);
  if (values.length === 0) return result;

  // Dashboard facts and Business Story already summarize repeated numeric rows
  // as totals. Feed the KPI renderer the same settled value so the visible card
  // cannot disagree with its evidence summary.
  const total = Number(values.reduce((sum, value) => sum + value, 0).toPrecision(15));
  return {
    ...result,
    columns: [valueField],
    rows: [{ [valueField]: total }],
    rowCount: 1,
  };
}
