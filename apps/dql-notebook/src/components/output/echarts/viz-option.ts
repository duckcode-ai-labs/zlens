import type { EChartsOption } from 'echarts';
import type { DashboardVizStyle } from '@zlens/core/apps/viz-style';
import type { CellChartConfig, QueryResult } from '../../../store/types';
import type { ThemeMode } from '../../../themes/notebook-theme';
import { formatChartValue } from '../../../utils/value-format';
import {
  abbreviate,
  categoryColumns,
  chartNumericValue,
  formatCategoryLabel,
  measureColumns,
  metaFor,
  pickColumns,
  type ChartType,
} from '../chart-helpers';
import { SEQUENTIAL_DARK, SEQUENTIAL_LIGHT, getPalette, isDarkThemeMode } from '../chart-palettes';

/** Chart types drawn by ECharts. KPI, table, sankey, waterfall, gauge and histogram keep their SVG renderers. */
export const ECHARTS_CHART_TYPES: ReadonlySet<ChartType> = new Set<ChartType>([
  'bar', 'grouped-bar', 'stacked-bar', 'line', 'area', 'scatter', 'pie', 'donut', 'heatmap', 'funnel',
]);

/** At most eight series: the validated palette has eight colours and never cycles. */
export const MAX_SERIES = 8;
const DEFAULT_MAX_CATEGORIES = 20;
const TIME_NAME_RE = /(^|_)(date|day|week|month|quarter|year|time|period)(_|$)/i;

export interface VizOptionInput {
  chartType: ChartType;
  result: QueryResult;
  themeMode: ThemeMode;
  config?: CellChartConfig;
  /** Server-side rendering has no animation. */
  animate?: boolean;
}

export interface VizOptionOutput {
  option: EChartsOption;
  /** The raw category values in drawing order, for click and keyboard selection. */
  categories: string[];
  /** The result row behind each category, for cross-filtering. */
  rowForCategory: Map<string, Record<string, unknown>>;
  /** Formatted category labels, used for accessible mark buttons. */
  categoryLabels: string[];
  /** Series left out because a chart shows at most eight. */
  droppedSeries: number;
  /**
   * The height the chart needs to label every category (horizontal bars). A
   * shorter tile scrolls the chart instead of skipping labels.
   */
  minHeight?: number;
  /**
   * The exact result row under a clicked mark: the series (a colour value)
   * as well as the category, a scatter point or a heatmap cell. Falls back to
   * the category's row when a chart has no finer mark.
   */
  rowAt?: (seriesIndex: number, dataIndex: number, data?: unknown) => Record<string, unknown> | undefined;
}

type Tokens = { text: string; muted: string; grid: string; axis: string; surface: string; tooltip: string; band: string };

const LIGHT: Tokens = { text: '#1a1a1a', muted: '#6b6e76', grid: '#f0eee9', axis: '#d9d5cc', surface: '#ffffff', tooltip: '#ffffff', band: 'rgba(0,137,123,0.08)' };
const DARK: Tokens = { text: '#e6e8ee', muted: '#9aa0ae', grid: '#1e2330', axis: '#2c3240', surface: '#161a23', tooltip: '#1c212d', band: 'rgba(43,179,169,0.12)' };
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const UNAVAILABLE = '—';

/**
 * The ECharts option for one chart, built only from the result, the chart
 * settings and the theme. Pure, so it is tested without a browser and the
 * same option renders interactively in the page and as SVG on the server.
 * Returns undefined for chart types ECharts does not draw here.
 */
export function buildVizOption({ chartType, result, themeMode, config, animate = true }: VizOptionInput): VizOptionOutput | undefined {
  if (!ECHARTS_CHART_TYPES.has(chartType) || result.rows.length === 0) return undefined;
  const style: DashboardVizStyle = config?.style ?? {};
  const tokens = isDarkThemeMode(themeMode) ? DARK : LIGHT;
  const palette = getPalette(style.palette ?? config?.colorPalette, themeMode).slice(0, MAX_SERIES);
  const { labelCol, valueCol } = pickColumns(result, config);
  const format = numberFormatter(result, valueCol, style, config);
  const base: EChartsOption = {
    animation: animate,
    animationDuration: 300,
    color: palette,
    textStyle: { fontFamily: FONT, color: tokens.text },
    aria: { enabled: true, decal: { show: false } },
    tooltip: {
      backgroundColor: tokens.tooltip,
      borderColor: tokens.axis,
      textStyle: { color: tokens.text, fontFamily: FONT, fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,.12); border-radius: 8px;',
    },
  };

  if (chartType === 'pie' || chartType === 'donut') return pieOption(base, result, labelCol, valueCol, chartType === 'donut', tokens, palette, format, config);
  if (chartType === 'funnel') return funnelOption(base, result, labelCol, valueCol, tokens, palette, format, config);
  if (chartType === 'scatter') return scatterOption(base, result, tokens, format, palette, config);
  if (chartType === 'heatmap') return heatmapOption(base, result, themeMode, tokens, format, config);
  return cartesianOption(base, chartType, result, labelCol, valueCol, style, tokens, format, config);
}

// ─── Bars, lines and areas ────────────────────────────────────────────────────

function cartesianOption(
  base: EChartsOption,
  chartType: ChartType,
  result: QueryResult,
  labelCol: string,
  valueCol: string,
  style: DashboardVizStyle,
  tokens: Tokens,
  format: (value: number) => string,
  config?: CellChartConfig,
): VizOptionOutput {
  const isLine = chartType === 'line' || chartType === 'area';
  const stacked = chartType === 'stacked-bar' || Boolean(style.stack);
  const colorCol = config?.color && result.columns.includes(config.color) && config.color !== labelCol ? config.color : undefined;
  const measures = seriesMeasures(result, labelCol, valueCol, chartType, config);

  // Categories in query order, one row kept per category for selection.
  const rowForCategory = new Map<string, Record<string, unknown>>();
  for (const row of result.rows) {
    const key = String(row[labelCol] ?? '');
    if (!rowForCategory.has(key)) rowForCategory.set(key, row);
  }
  let categories = Array.from(rowForCategory.keys());

  // Series: one per measure, or one per value of the colour field.
  let series: Array<{ name: string; values: Map<string, number | null> }>;
  // The row behind each point of each colour series: a tooltip or a click
  // on US in January reads US's January row, not the first row of January.
  const rowsByColour = new Map<string, Map<string, Record<string, unknown>>>();
  if (colorCol) {
    const byColour = new Map<string, Map<string, number | null>>();
    for (const row of result.rows) {
      const name = String(row[colorCol] ?? '');
      const values = byColour.get(name) ?? new Map<string, number | null>();
      values.set(String(row[labelCol] ?? ''), chartNumericValue(row[valueCol]));
      byColour.set(name, values);
      const rows = rowsByColour.get(name) ?? new Map<string, Record<string, unknown>>();
      if (!rows.has(String(row[labelCol] ?? ''))) rows.set(String(row[labelCol] ?? ''), row);
      rowsByColour.set(name, rows);
    }
    series = Array.from(byColour, ([name, values]) => ({ name, values }));
  } else {
    series = measures.map((measure) => ({
      name: measure,
      values: new Map(result.rows.map((row) => [String(row[labelCol] ?? ''), chartNumericValue(row[measure])])),
    }));
  }
  const droppedSeries = Math.max(0, series.length - MAX_SERIES);
  series = series.slice(0, MAX_SERIES);

  if (style.sort && style.sort !== 'none' && series[0]) {
    const first = series[0].values;
    const direction = style.sort === 'asc' ? 1 : -1;
    categories = [...categories].sort((a, b) => direction * ((first.get(a) ?? -Infinity) - (first.get(b) ?? -Infinity)));
  }
  // A time axis runs left to right. The shared DATE_NAME_RE also matches
  // words like "category", so the orientation uses whole name parts or the
  // values themselves.
  const timeLabels = TIME_NAME_RE.test(labelCol) || categories.every((value) => /^\d{4}-\d{2}(-\d{2})?(T|$)/.test(value));
  const timeAxis = isLine || timeLabels;
  // Queries need not return periods in order; a time axis is drawn oldest
  // to newest unless the author chose a sort.
  if (timeLabels && (!style.sort || style.sort === 'none')) categories = chronological(categories);
  if (!isLine) categories = categories.slice(0, config?.maxItems ?? DEFAULT_MAX_CATEGORIES);
  // Long category lists read better as horizontal bars; dates stay on x.
  // Shelves (RFC 0009) set the orientation: a dimension on Rows lists
  // down (horizontal bars). Lines always run along x.
  const horizontal = config?.orientation && !isLine ? config.orientation === 'horizontal' : !isLine && !timeAxis;
  const categoryLabels = categories.map((value) => formatCategoryLabel(value, labelCol, 16));

  const labelsMode = style.labels ?? 'none';
  const lastIndex = categories.length - 1;
  const labelColumns = new Set(config?.labelColumns ?? []);
  const seriesOptions = series.map((entry, seriesIndex) => {
    const topOfStack = !stacked || seriesIndex === series.length - 1;
    // A measure on the Label shelf shows every value of its own series.
    const shelfLabels = labelColumns.has(colorCol ? valueCol : entry.name);
    const seriesFormat = colorCol ? format : numberFormatter(result, entry.name, style, config);
    const data = categories.map((category, index) => {
      const value = entry.values.get(category) ?? null;
      const showLabel = shelfLabels || labelsMode === 'all' || (labelsMode === 'last' && index === lastIndex && topOfStack);
      if (value === null) {
        // Unavailable is not zero: no mark, a dash where the value would be.
        return isLine
          ? null
          : { value: 0, unavailable: true, itemStyle: { opacity: 0 }, label: { show: true, formatter: UNAVAILABLE, color: tokens.muted } };
      }
      if (isLine && index === lastIndex) {
        return { value, symbol: 'circle', symbolSize: 8, itemStyle: { borderColor: tokens.surface, borderWidth: 2 }, ...(showLabel ? { label: { show: true } } : {}) };
      }
      // A point with no neighbour on either side draws no line segment, so it
      // is drawn as a dot (a customer with sales in one month only).
      if (isLine) {
        const before = index > 0 ? entry.values.get(categories[index - 1]!) ?? null : null;
        const after = index < lastIndex ? entry.values.get(categories[index + 1]!) ?? null : null;
        if (before === null && after === null) {
          return { value, symbol: 'circle', symbolSize: 7, ...(showLabel ? { label: { show: true } } : {}) };
        }
      }
      return showLabel ? { value, label: { show: true } } : value;
    });
    const common = {
      name: colorCol ? entry.name : columnName(result, entry.name),
      data,
      emphasis: { focus: 'series' as const },
      // Each measure keeps its own format in the tooltip: a share next to a price reads 41% and $60.
      ...(colorCol ? {} : { tooltip: { valueFormatter: (value: unknown) => (value === null || value === undefined ? 'Unavailable' : seriesFormat(Number(value))) } }),
      label: {
        show: false,
        color: tokens.text,
        fontSize: 11,
        position: (isLine ? 'top' : horizontal ? 'right' : 'top') as 'top' | 'right',
        formatter: (params: { value: unknown }) => seriesFormat(Number(params.value)),
      },
    };
    if (isLine) {
      return {
        ...common,
        type: 'line' as const,
        showSymbol: true,
        symbol: 'none',
        lineStyle: { width: 2 },
        connectNulls: false,
        ...(stacked ? { stack: 'total' } : {}),
        ...(chartType === 'area' ? { areaStyle: { opacity: stacked ? 0.85 : 0.12 } } : {}),
      };
    }
    return {
      ...common,
      type: 'bar' as const,
      barMaxWidth: 28,
      ...(stacked ? { stack: 'total' } : {}),
      itemStyle: {
        // 4px rounded data end, square at the baseline; a surface-coloured
        // edge keeps stacked segments apart.
        borderRadius: topOfStack ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0,
        ...(stacked ? { borderColor: tokens.surface, borderWidth: 1 } : {}),
      },
    };
  });
  // Measures of different units on one axis: the axis names no unit rather
  // than one measure's (a price read as 6,000%). Each series' tooltip and
  // labels keep their own.
  const units = colorCol ? [] : unique(series.map((entry) => { const meta = metaFor(result, entry.name); return meta ? `${meta.kind}:${meta.unit ?? ''}` : ''; }));
  const axisFormat = units.length > 1 && !style.format
    ? (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
    : format;
  const marks = markLayers(style, categories, labelCol, horizontal, tokens, axisFormat);
  if (seriesOptions[0]) Object.assign(seriesOptions[0], marks);

  // Every bar is named: skipping every other label made a top-25 list look
  // as if it skipped ranks 2 and 4. Bar categories show all their labels,
  // truncated (the tooltip has the full name) and, on a crowded vertical axis,
  // rotated. A time axis may still thin its labels; its order says the rest.
  const labelEveryBar = !isLine && !timeAxis;
  const categoryAxis = {
    type: 'category' as const,
    data: labelEveryBar ? categories.map((value) => formatCategoryLabel(value, labelCol, 80)) : categoryLabels,
    ...(horizontal ? { inverse: true } : {}),
    axisLine: { lineStyle: { color: tokens.axis } },
    axisTick: { show: false },
    axisLabel: labelEveryBar
      ? {
          color: tokens.muted,
          fontSize: 11,
          interval: 0,
          hideOverlap: false,
          formatter: (value: string) => formatCategoryLabel(value, labelCol, horizontal ? 18 : 14),
          ...(!horizontal && categories.length > 6 ? { rotate: 35 } : {}),
        }
      : { color: tokens.muted, fontSize: 11, hideOverlap: true },
  };
  // Value ticks never run into each other ("$500.0$1.0K$1.5K" on a narrow
  // bar tile): ECharts drops a label that would overlap, and round ticks drop
  // their ".0" ("$500", "$1K", "$1.5K").
  const valueAxis = {
    type: 'value' as const,
    axisLabel: { color: tokens.muted, fontSize: 11, hideOverlap: true, formatter: (value: number) => axisTickLabel(axisFormat(value)) },
    splitLine: { lineStyle: { color: tokens.grid } },
  };
  const showLegend = series.length > 1 && style.legend !== 'none';
  const option: EChartsOption = {
    ...base,
    grid: { left: 8, right: 24, top: showLegend && (style.legend ?? 'top') === 'top' ? 36 : 16, bottom: 8, containLabel: true },
    legend: showLegend ? legendOption(style.legend ?? 'top', tokens) : { show: false },
    tooltip: {
      ...(base.tooltip as object),
      trigger: 'axis',
      axisPointer: { type: isLine ? 'line' : 'shadow', lineStyle: { color: tokens.axis } },
      valueFormatter: (value: unknown) => (value === null || value === undefined ? 'Unavailable' : format(Number(value))),
      // The Tooltip shelf adds measures the chart does not draw.
      ...(config?.tooltipColumns?.length ? {
        formatter: (params: unknown) => axisTooltip(params, categories, rowForCategory, series.map((entry) => entry.name), colorCol, result, style, config, rowsByColour, stacked),
      } : stacked || config?.tooltipFooter ? {
        formatter: (params: unknown) => axisTooltip(params, categories, rowForCategory, series.map((entry) => entry.name), colorCol, result, style, config, rowsByColour, stacked),
      } : {}),
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series: seriesOptions as EChartsOption['series'],
  };
  const rowAt = (seriesIndex: number, dataIndex: number) => {
    const category = categories[dataIndex];
    if (category === undefined) return undefined;
    const entry = series[seriesIndex];
    return colorCol && entry ? rowsByColour.get(entry.name)?.get(category) : rowForCategory.get(category);
  };
  // Horizontal bars need room for one readable row per category.
  const minHeight = horizontal && labelEveryBar ? categories.length * BAR_ROW_PX + 32 : undefined;
  return { option, categories, rowForCategory, categoryLabels, droppedSeries, rowAt, ...(minHeight ? { minHeight } : {}) };
}

/** The height one labelled horizontal bar needs. */
const BAR_ROW_PX = 18;

/** Reference lines, target bands and dated notes, drawn on the first series. */
function markLayers(
  style: DashboardVizStyle,
  categories: string[],
  labelCol: string,
  horizontal: boolean,
  tokens: Tokens,
  format: (value: number) => string,
): Record<string, unknown> {
  const valueKey = horizontal ? 'xAxis' : 'yAxis';
  const categoryKey = horizontal ? 'yAxis' : 'xAxis';
  const lines: Array<Record<string, unknown>> = (style.referenceLines ?? []).map((line) => ({
    [valueKey]: line.value,
    name: line.label ?? format(line.value),
    lineStyle: { type: 'dashed', color: tokens.muted, width: 1 },
    label: { formatter: line.label ? `${line.label} · ${format(line.value)}` : format(line.value), color: tokens.muted, fontSize: 11, position: 'insideEndTop' },
  }));
  for (const note of style.annotations ?? []) {
    const index = categories.findIndex((category) => category === note.at || category.startsWith(note.at)
      || formatCategoryLabel(category, labelCol, 32) === note.at);
    if (index < 0) continue;
    lines.push({
      [categoryKey]: index,
      name: note.text,
      lineStyle: { type: 'dotted', color: tokens.text, width: 1 },
      // ECharts sets text along a vertical mark line; it reads bottom to top
      // beside the line, near its top.
      label: { formatter: note.text, color: tokens.text, fontSize: 11, position: 'insideEndTop' },
    });
  }
  const bands = (style.bands ?? []).map((band) => ([
    { [valueKey]: band.from, name: band.label ?? '', itemStyle: { color: tokens.band }, label: { color: tokens.muted, fontSize: 11, position: 'insideTopLeft' } },
    { [valueKey]: band.to },
  ]));
  return {
    ...(lines.length ? { markLine: { symbol: 'none', silent: true, data: lines } } : {}),
    ...(bands.length ? { markArea: { silent: true, data: bands } } : {}),
  };
}

// ─── Parts of a whole ─────────────────────────────────────────────────────────

function pieOption(
  base: EChartsOption,
  result: QueryResult,
  labelCol: string,
  valueCol: string,
  donut: boolean,
  tokens: Tokens,
  palette: string[],
  format: (value: number) => string,
  config?: CellChartConfig,
): VizOptionOutput {
  const rowForCategory = new Map<string, Record<string, unknown>>();
  const slices = result.rows.flatMap((row) => {
    const value = chartNumericValue(row[valueCol]);
    const name = String(row[labelCol] ?? '');
    if (value === null || value <= 0) return [];
    if (!rowForCategory.has(name)) rowForCategory.set(name, row);
    return [{ name, value }];
  }).sort((a, b) => b.value - a.value);
  // Eight colours never cycle: a ninth slice onwards folds into "Other".
  const limit = Math.min(config?.maxItems ?? MAX_SERIES, MAX_SERIES);
  const kept = slices.length > limit ? slices.slice(0, limit - 1) : slices;
  const other = slices.slice(kept.length).reduce((sum, slice) => sum + slice.value, 0);
  const data = [
    ...kept.map((slice) => ({ name: slice.name, value: slice.value })),
    ...(other > 0 ? [{ name: 'Other', value: other }] : []),
  ];
  const categories = data.map((slice) => slice.name);
  const whole = data.reduce((sum, slice) => sum + slice.value, 0);
  const option: EChartsOption = {
    ...base,
    color: palette,
    tooltip: {
      ...(base.tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const { name, value } = params as { name: string; value: number };
        const share = whole > 0 ? `${Math.round((Number(value) / whole) * 100)}% of the total` : '';
        return itemTooltip(name, columnName(result, valueCol), Number(value), format, share, rowForCategory.get(name), result, config);
      },
    },
    legend: { show: false },
    series: [{
      type: 'pie',
      radius: donut ? ['52%', '76%'] : ['0%', '76%'],
      center: ['50%', '52%'],
      padAngle: 1,
      itemStyle: { borderColor: tokens.surface, borderWidth: 2 },
      label: { color: tokens.text, fontSize: 11, formatter: '{b}  {d}%' },
      labelLine: { lineStyle: { color: tokens.axis } },
      data,
    }],
  };
  return { option, categories, rowForCategory, categoryLabels: categories.map((value) => formatCategoryLabel(value, labelCol, 32)), droppedSeries: 0, rowAt: (_series, index) => rowForCategory.get(categories[index] ?? '') };
}

function funnelOption(
  base: EChartsOption,
  result: QueryResult,
  labelCol: string,
  valueCol: string,
  tokens: Tokens,
  palette: string[],
  format: (value: number) => string,
  config?: CellChartConfig,
): VizOptionOutput {
  const rowForCategory = new Map<string, Record<string, unknown>>();
  const stages = result.rows.flatMap((row) => {
    const value = chartNumericValue(row[valueCol]);
    const name = String(row[labelCol] ?? '');
    if (value === null) return [];
    if (!rowForCategory.has(name)) rowForCategory.set(name, row);
    return [{ name, value }];
  }).slice(0, config?.maxItems ?? DEFAULT_MAX_CATEGORIES);
  const top = stages[0]?.value || 1;
  const option: EChartsOption = {
    ...base,
    tooltip: {
      ...(base.tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const { name, value } = params as { name: string; value: number };
        return itemTooltip(name, columnName(result, valueCol), Number(value), format, `${Math.round((Number(value) / top) * 100)}% of the first step`, rowForCategory.get(name), result, config);
      },
    },
    series: [{
      type: 'funnel',
      sort: 'none',
      left: 0, width: '62%', top: 8, bottom: 8,
      gap: 2,
      // Stages are one thing measured at each step: one colour. Labels sit
      // beside the shape in text colour, readable in both themes.
      itemStyle: { color: palette[0], borderColor: tokens.surface, borderWidth: 1 },
      labelLine: { lineStyle: { color: tokens.axis } },
      label: {
        position: 'right',
        color: tokens.text,
        fontSize: 11,
        formatter: (params: { name: string; value: unknown }) => `${params.name}  ${Math.round((Number(params.value) / top) * 100)}%`,
      },
      data: stages,
    }],
  };
  const categories = stages.map((stage) => stage.name);
  return { option, categories, rowForCategory, categoryLabels: categories, droppedSeries: 0, rowAt: (_series, index) => rowForCategory.get(categories[index] ?? '') };
}

// ─── Two measures, and magnitude over two categories ─────────────────────────

function scatterOption(
  base: EChartsOption,
  result: QueryResult,
  tokens: Tokens,
  format: (value: number) => string,
  palette: string[],
  config?: CellChartConfig,
): VizOptionOutput | undefined {
  const measures = measureColumns(result);
  // Shelves name the axes; otherwise the first two measures.
  const xCol = config?.x && measures.includes(config.x) ? config.x : measures[0];
  const yCol = config?.y && measures.includes(config.y) && config.y !== xCol ? config.y : measures.find((measure) => measure !== xCol);
  if (!xCol || !yCol) return undefined;
  const sizeCol = config?.size && result.columns.includes(config.size) ? config.size : undefined;
  const colorCol = config?.color && result.columns.includes(config.color) ? config.color : undefined;
  const labelCol = categoryColumns(result).find((column) => column !== colorCol);
  const sizes = sizeCol ? result.rows.map((row) => chartNumericValue(row[sizeCol])).filter((value): value is number => value !== null && value > 0) : [];
  const maxSize = sizes.length ? Math.max(...sizes) : 0;
  // Bubble area follows the size measure: radius grows with its square root.
  const symbolSize = (value: number | null) => (sizeCol && maxSize > 0 && value !== null && value > 0 ? 6 + 26 * Math.sqrt(value / maxSize) : 8);
  const groups = new Map<string, Array<{ value: [number, number]; name: string; symbolSize: number; row: Record<string, unknown> }>>();
  for (const row of result.rows) {
    const x = chartNumericValue(row[xCol]);
    const y = chartNumericValue(row[yCol]);
    if (x === null || y === null) continue;
    const group = colorCol ? String(row[colorCol] ?? '') : '';
    const points = groups.get(group) ?? [];
    points.push({ value: [x, y], name: labelCol ? String(row[labelCol] ?? '') : '', symbolSize: symbolSize(sizeCol ? chartNumericValue(row[sizeCol]) : null), row });
    groups.set(group, points);
  }
  const xFormat = numberFormatter(result, xCol, {}, config);
  const yFormat = numberFormatter(result, yCol, {}, config);
  const axis = (name: string, formatValue: (value: number) => string) => ({
    type: 'value' as const,
    name: columnName(result, name),
    nameTextStyle: { color: tokens.muted, fontSize: 11 },
    axisLabel: { color: tokens.muted, fontSize: 11, formatter: (value: number) => formatValue(value) },
    splitLine: { lineStyle: { color: tokens.grid } },
  });
  const tooltipLines = (point: { name: string; row: Record<string, unknown> }) => [
    point.name ? `<strong>${escapeHtmlText(formatCategoryLabel(point.name, labelCol ?? '', 40))}</strong>` : '',
    `${escapeHtmlText(columnName(result, xCol))}: ${escapeHtmlText(xFormat(Number(point.row[xCol])))}`,
    `${escapeHtmlText(columnName(result, yCol))}: ${escapeHtmlText(yFormat(Number(point.row[yCol])))}`,
    ...(sizeCol ? [`${escapeHtmlText(columnName(result, sizeCol))}: ${escapeHtmlText(numberFormatter(result, sizeCol, {}, config)(Number(point.row[sizeCol])))}`] : []),
    ...(config?.tooltipColumns ?? []).filter((column) => result.columns.includes(column)).map((column) => `${escapeHtmlText(columnName(result, column))}: ${escapeHtmlText(numberFormatter(result, column, {}, config)(Number(point.row[column])))}`),
  ].filter(Boolean).join('<br/>');
  const showLegend = colorCol !== undefined && groups.size > 1;
  const option: EChartsOption = {
    ...base,
    grid: { left: 8, right: 24, top: showLegend ? 36 : 24, bottom: 8, containLabel: true },
    legend: showLegend ? legendOption('top', tokens) : { show: false },
    tooltip: {
      ...(base.tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const data = (params as { data?: { name: string; row: Record<string, unknown> } }).data;
        return data ? tooltipLines(data) + tooltipFooterHtml(config) : '';
      },
    },
    xAxis: axis(xCol, xFormat),
    yAxis: axis(yCol, yFormat),
    series: Array.from(groups).slice(0, MAX_SERIES).map(([name, points], index) => ({
      type: 'scatter' as const,
      name: name || columnName(result, yCol),
      itemStyle: { color: palette[index % palette.length], opacity: 0.85, borderColor: tokens.surface, borderWidth: 1 },
      data: points,
    })),
  };
  return {
    option, categories: [], rowForCategory: new Map(), categoryLabels: [], droppedSeries: Math.max(0, groups.size - MAX_SERIES),
    rowAt: (_series, _index, data) => (data as { row?: Record<string, unknown> } | undefined)?.row,
  };
}

function heatmapOption(base: EChartsOption, result: QueryResult, themeMode: ThemeMode, tokens: Tokens, format: (value: number) => string, config?: CellChartConfig): VizOptionOutput | undefined {
  const categories = categoryColumns(result);
  const measures = measureColumns(result);
  const rowCol = categories[0] ?? result.columns[0]!;
  let xLabels: string[];
  let yLabels: string[];
  const cells: Array<[number, number, number | null]> = [];
  // The row behind each cell, for its tooltip and a click on it.
  const cellRows: Array<Record<string, unknown>> = [];
  let valueLabel = measures[0] ?? '';
  if (categories.length >= 2 && measures.length >= 1) {
    // Long form: two categories and one measure.
    const colCol = categories[1]!;
    const measure = measures[0]!;
    xLabels = unique(result.rows.map((row) => String(row[colCol] ?? '')));
    yLabels = unique(result.rows.map((row) => String(row[rowCol] ?? '')));
    for (const row of result.rows) {
      cells.push([xLabels.indexOf(String(row[colCol] ?? '')), yLabels.indexOf(String(row[rowCol] ?? '')), chartNumericValue(row[measure])]);
      cellRows.push(row);
    }
  } else {
    // Wide form: one row label, each measure a column.
    if (measures.length === 0) return undefined;
    xLabels = measures;
    yLabels = result.rows.map((row) => String(row[rowCol] ?? ''));
    result.rows.forEach((row, y) => measures.forEach((measure, x) => { cells.push([x, y, chartNumericValue(row[measure])]); cellRows.push(row); }));
    valueLabel = '';
  }
  const values = cells.map((cell) => cell[2]).filter((value): value is number => value !== null);
  const ramp = (isDarkThemeMode(themeMode) ? SEQUENTIAL_DARK : SEQUENTIAL_LIGHT).map((step) => step.fill);
  const option: EChartsOption = {
    ...base,
    grid: { left: 8, right: 16, top: 8, bottom: 40, containLabel: true },
    tooltip: {
      ...(base.tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const { dataIndex, value } = params as { dataIndex: number; value: [number, number, number | null] };
        const [x, y, cellValue] = value;
        const name = `${formatCategoryLabel(yLabels[y] ?? '', rowCol, 40)} · ${valueLabel ? formatCategoryLabel(xLabels[x] ?? '', '', 40) : prettyName(xLabels[x] ?? '')}`;
        return itemTooltip(name, valueLabel ? columnName(result, valueLabel) : prettyName(xLabels[x] ?? ''), cellValue, format, '', cellRows[dataIndex], result, config);
      },
    },
    xAxis: { type: 'category', data: xLabels.map(prettyName), axisLabel: { color: tokens.muted, fontSize: 11 }, axisTick: { show: false }, axisLine: { show: false } },
    yAxis: { type: 'category', data: yLabels, inverse: true, axisLabel: { color: tokens.muted, fontSize: 11 }, axisTick: { show: false }, axisLine: { show: false } },
    visualMap: {
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 1,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 120,
      textStyle: { color: tokens.muted, fontSize: 11 },
      inRange: { color: ramp },
      formatter: (value: unknown) => format(Number(value)),
    },
    series: [{ type: 'heatmap', data: cells, itemStyle: { borderColor: tokens.surface, borderWidth: 2, borderRadius: 3 } }],
  };
  return { option, categories: [], rowForCategory: new Map(), categoryLabels: [], droppedSeries: 0, rowAt: (_series, index) => cellRows[index] };
}

// ─── Shared ──────────────────────────────────────────────────────────────────

const SINGLE_VALUE_CHARTS: ReadonlySet<ChartType> = new Set<ChartType>(['bar', 'line', 'area']);

function seriesMeasures(result: QueryResult, labelCol: string, valueCol: string, chartType: ChartType, config?: CellChartConfig): string[] {
  // Measures on the value shelf are the series, in shelf order.
  if (config?.orientation && config.metrics?.length) {
    const onShelf = config.metrics.filter((metric) => result.columns.includes(metric));
    if (onShelf.length) return onShelf;
  }
  // A chosen "Y / value" field is the one series of a bar, line or area
  // chart: the author picked one value, so other number columns stay off the
  // axis. Stacked and grouped bars exist to show several measures together.
  if (config?.y && result.columns.includes(config.y) && config.y !== labelCol && SINGLE_VALUE_CHARTS.has(chartType)) return [config.y];
  const measures = measureColumns(result).filter((column) => column !== labelCol);
  if (chartType === 'bar' && !config?.style?.stack) return [valueCol];
  const ordered = config?.metrics?.filter((metric) => measures.includes(metric)) ?? [];
  return ordered.length ? ordered : measures.length ? measures : [valueCol];
}

function numberFormatter(result: QueryResult, valueCol: string, style: DashboardVizStyle, config?: CellChartConfig): (value: number) => string {
  const meta = metaFor(result, valueCol);
  return (value: number) => {
    if (!Number.isFinite(value)) return UNAVAILABLE;
    switch (style.format) {
      case 'compact':
        return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
      case 'currency':
      case 'percent':
      case 'number':
        return formatChartValue(valueCol, value, style.format, meta);
      default:
        return abbreviate(value, valueCol, config?.format, meta);
    }
  };
}

function legendOption(position: 'top' | 'right' | 'bottom' | 'none', tokens: Tokens): EChartsOption['legend'] {
  const common = { show: true, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: tokens.muted, fontSize: 11 } };
  if (position === 'right') return { ...common, orient: 'vertical', right: 0, top: 'middle' };
  if (position === 'bottom') return { ...common, bottom: 0, left: 'center' };
  return { ...common, top: 0, left: 0 };
}

function prettyName(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Order period labels by time when every label reads as a date or a number; otherwise keep them. */
export function chronological(categories: string[]): string[] {
  const numeric = categories.every((value) => value.trim() !== '' && Number.isFinite(Number(value)));
  const keys = categories.map((value) => (numeric ? Number(value) : Date.parse(value)));
  if (keys.some((key) => !Number.isFinite(key))) return categories;
  return categories
    .map((value, index) => ({ value, key: keys[index]!, index }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((entry) => entry.value);
}

/** A result column's name for readers: the author's label, or the column tidied. */
function columnName(result: QueryResult, column: string): string {
  return metaFor(result, column)?.label ?? prettyName(column);
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** An axis tooltip with the drawn series and the Tooltip shelf's extra measures. */
function axisTooltip(
  params: unknown,
  categories: string[],
  rowForCategory: Map<string, Record<string, unknown>>,
  seriesNames: string[],
  colorCol: string | undefined,
  result: QueryResult,
  style: DashboardVizStyle,
  config: CellChartConfig | undefined,
  rowsByColour: Map<string, Map<string, Record<string, unknown>>> = new Map(),
  stacked = false,
): string {
  const all = (Array.isArray(params) ? params : [params]) as Array<{ dataIndex: number; seriesIndex: number; value: unknown; data?: unknown; marker?: string; seriesName?: string }>;
  // A series with no value at this point is drawn as an invisible zero; it has nothing to say here.
  const list = all.filter((entry) => !(entry.data && typeof entry.data === 'object' && (entry.data as { unavailable?: boolean }).unavailable));
  const index = all[0]?.dataIndex ?? 0;
  const category = categories[index];
  if (category === undefined) return '';
  const row = rowForCategory.get(category) ?? {};
  const extras = (config?.tooltipColumns ?? []).filter((column) => result.columns.includes(column) && !seriesNames.includes(column));
  const extraText = (source: Record<string, unknown>) => extras.map((column) => {
    const value = chartNumericValue(source[column]);
    return `${columnName(result, column)} ${value === null ? 'Unavailable' : numberFormatter(result, column, style, config)(value)}`;
  });
  const valueOf = (entry: { value: unknown }) => {
    const raw = typeof entry.value === 'object' && entry.value !== null ? (entry.value as { value?: unknown }).value : entry.value;
    return raw === null || raw === undefined ? null : Number(raw);
  };
  // A stack's parts add up to the bar: each part shows its share, and the total closes the list.
  const total = stacked ? list.reduce((sum, entry) => sum + (valueOf(entry) ?? 0), 0) : 0;
  const lines = [`<strong>${escapeHtmlText(formatCategoryLabel(category, '', 40))}</strong>`];
  for (const entry of list) {
    const name = seriesNames[entry.seriesIndex] ?? entry.seriesName ?? '';
    const value = valueOf(entry);
    const formatValue = numberFormatter(result, colorCol ? (config?.y ?? name) : name, style, config);
    const text = value === null ? 'Unavailable' : formatValue(value);
    const share = stacked && total > 0 && value !== null && value >= 0 ? ` (${Math.round((value / total) * 100)}%)` : '';
    // Under a colour split, the Tooltip shelf's measures belong to each series' own row.
    const own = colorCol && extras.length ? rowsByColour.get(name)?.get(category) : undefined;
    const ownExtras = own ? extraText(own) : [];
    lines.push(`${entry.marker ?? ''}${escapeHtmlText(colorCol ? name : columnName(result, name))}: ${escapeHtmlText(text + share)}${ownExtras.length ? ` <span style="opacity:.75">· ${escapeHtmlText(ownExtras.join(' · '))}</span>` : ''}`);
  }
  if (stacked && list.length > 1) {
    const formatValue = numberFormatter(result, colorCol ? (config?.y ?? seriesNames[0] ?? '') : seriesNames[0] ?? '', style, config);
    lines.push(`<strong>Total: ${escapeHtmlText(formatValue(total))}</strong>`);
  }
  if (!colorCol) {
    for (const column of extras) {
      const value = chartNumericValue(row[column]);
      lines.push(`${escapeHtmlText(columnName(result, column))}: ${escapeHtmlText(value === null ? 'Unavailable' : numberFormatter(result, column, style, config)(value))}`);
    }
  }
  return lines.join('<br/>') + tooltipFooterHtml(config);
}

/** The tooltip's quiet last line: where the numbers come from and how far to trust them. */
export function tooltipFooterHtml(config: CellChartConfig | undefined): string {
  return config?.tooltipFooter ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(128,128,128,.25);font-size:11px;opacity:.8">${escapeHtmlText(config.tooltipFooter)}</div>` : '';
}

/** A tooltip for one mark: its name, its value (with its share when parts make a whole), the Tooltip shelf, the footer. */
function itemTooltip(
  name: string,
  valueLabel: string,
  value: number | null,
  format: (value: number) => string,
  share: string,
  row: Record<string, unknown> | undefined,
  result: QueryResult,
  config: CellChartConfig | undefined,
): string {
  const lines = [`<strong>${escapeHtmlText(name)}</strong>`, `${escapeHtmlText(valueLabel)}: ${escapeHtmlText(value === null ? 'Unavailable' : format(value))}${share ? ` (${escapeHtmlText(share)})` : ''}`];
  for (const column of config?.tooltipColumns ?? []) {
    if (!row || !result.columns.includes(column) || column === valueLabel) continue;
    const extra = chartNumericValue(row[column]);
    lines.push(`${escapeHtmlText(columnName(result, column))}: ${escapeHtmlText(extra === null ? 'Unavailable' : numberFormatter(result, column, {}, config)(extra))}`);
  }
  return lines.join('<br/>') + tooltipFooterHtml(config);
}


/** An axis tick without a trailing ".0": "$500.0" → "$500", "$1.0K" → "$1K"; "$1.5K" is kept. */
export function axisTickLabel(label: string): string {
  return label.replace(/(\d)\.0+(?=[^\d.]*$)/, '$1');
}
