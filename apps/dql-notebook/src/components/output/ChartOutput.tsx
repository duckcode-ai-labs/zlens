import React, { useState } from 'react';
import { themes } from '../../themes/notebook-theme';
import type { ThemeMode } from '../../themes/notebook-theme';
import { TableOutput } from './TableOutput';
import type { QueryResult, CellChartConfig, ResultColumnMeta } from '../../store/types';
import { formatChartValue, formatDisplayValue } from '../../utils/value-format';
import { CHART_PALETTE_OPTIONS, getPalette, selectedPaletteOption, sequentialStep } from './chart-palettes';
import { EChartsChart, type MarkPointer } from './echarts/EChartsChart';
import { ECHARTS_CHART_TYPES } from './echarts/viz-option';
import {
  DATE_NAME_RE,
  abbreviate,
  isNumericValue,
  categoryColumns,
  chartNumericValue,
  formatCategoryLabel,
  formatDateLabel,
  isMeasureColumn,
  measureColumns,
  metaFor,
  pickColumns,
  resolveChartType,
  type ChartType,
} from './chart-helpers';

interface ChartOutputProps {
  result: QueryResult;
  themeMode: ThemeMode;
  chartConfig?: CellChartConfig;  // Explicit config from DQL visualization block
  /** Measured App-tile body height. Notebook charts may omit it. */
  availableHeight?: number;
  /** Measured App-tile body width. Keeps SVG text legible in narrow containers. */
  availableWidth?: number;
  /**
   * Optional interaction hook for App tiles. It receives the original typed
   * result row, never a formatted axis label, so consumers can keep governed
   * field identities and values intact when applying a cross-filter.
   */
  onMarkSelect?: (row: Record<string, unknown>, pointer?: MarkPointer) => void;
}

export type { ChartType } from './chart-helpers';
export { categoryColumns, detectChartType, isMeasureColumn, measureColumns, resolveChartType } from './chart-helpers';

export const CHART_TYPE_OPTIONS: { value: ChartType; label: string }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'grouped-bar', label: 'Grouped Bar' },
  { value: 'stacked-bar', label: 'Stacked Bar' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'scatter', label: 'Scatter' },
  { value: 'pie', label: 'Pie' },
  { value: 'donut', label: 'Donut' },
  { value: 'heatmap', label: 'Heatmap' },
  { value: 'histogram', label: 'Histogram' },
  { value: 'funnel', label: 'Funnel' },
  { value: 'sankey', label: 'Sankey' },
  { value: 'waterfall', label: 'Waterfall' },
  { value: 'gauge', label: 'Gauge' },
  { value: 'kpi', label: 'KPI' },
];

type ThemeRef = ReturnType<typeof themes['dark'] extends infer T ? () => T : never>;

// ─── Bar Chart ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITEMS = 20;

function BarChart({ result, themeMode, chartConfig, availableHeight, availableWidth, onMarkSelect }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig; availableHeight?: number; availableWidth?: number; onMarkSelect?: (row: Record<string, unknown>) => void }) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const { labelCol, valueCol } = pickColumns(result, chartConfig);
  const maxItems = chartConfig?.maxItems ?? DEFAULT_MAX_ITEMS;
  const palette = getPalette(chartConfig?.colorPalette, themeMode);

  const data = result.rows.slice(0, maxItems).map((row) => ({
    label: String(row[labelCol] ?? ''),
    value: chartNumericValue(row[valueCol]),
    row,
  }));

  const truncated = result.rows.length > maxItems;
  const maxVal = Math.max(...data.flatMap((d) => d.value === null ? [] : [d.value]), 1);

  const WIDTH = availableWidth && availableWidth > 0 ? Math.max(240, Math.min(720, availableWidth)) : 600;
  const LABEL_W = Math.min(132, Math.max(82, WIDTH * 0.32));
  const PADDING = 10;
  const preferredSlot = 34;
  const fittedHeight = availableHeight && availableHeight > 0
    ? Math.max(96, availableHeight - 4)
    : data.length * preferredSlot + PADDING * 2;
  const slot = Math.max(15, Math.min(preferredSlot, (fittedHeight - PADDING * 2) / Math.max(1, data.length)));
  const BAR_H = Math.max(10, slot - 4);
  const svgH = Math.max(80, PADDING * 2 + data.length * slot);

  return (
    <div style={{ padding: '8px 0' }}>
      <svg width="100%" height={svgH} viewBox={`0 0 ${WIDTH} ${svgH}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
        {data.map((item, i) => {
          const y = PADDING + i * slot;
          const barMaxW = WIDTH - LABEL_W - Math.min(84, WIDTH * 0.22);
          const barW = item.value === null ? 0 : Math.max((item.value / maxVal) * barMaxW, 2);
          const isHovered = hoveredIdx === i;
          // A two-field bar result is one series. Cycling colors per row implied
          // unrelated categories and made governed business charts look noisy.
          const color = palette[0] ?? t.accent;
          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              onClick={onMarkSelect ? () => onMarkSelect(item.row) : undefined}
              onKeyDown={onMarkSelect ? (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onMarkSelect(item.row);
              } : undefined}
              role={onMarkSelect ? 'button' : undefined}
              tabIndex={onMarkSelect ? 0 : undefined}
              aria-label={onMarkSelect ? `Select ${item.label}` : undefined}
              style={{ cursor: onMarkSelect ? 'pointer' : 'default', outline: 'none' }}
            >
              <text x={LABEL_W - 8} y={y + BAR_H / 2 + 4} textAnchor="end" fontSize={11} fontFamily={t.font} fill={t.textSecondary}>
                {formatCategoryLabel(item.label, labelCol)}
              </text>
              {item.value === null ? null : <rect x={LABEL_W} y={y} width={barW} height={BAR_H} rx={3} fill={color} opacity={isHovered ? 1 : 0.88} style={{ transition: 'opacity 0.15s' }} />}
              <text x={LABEL_W + barW + 6} y={y + BAR_H / 2 + 4} textAnchor="start" fontSize={11} fontFamily={t.fontMono} fill={t.textMuted}>
                {item.value === null ? '—' : abbreviate(item.value, valueCol, chartConfig?.format, metaFor(result, valueCol))}
              </text>
            </g>
          );
        })}
      </svg>
      {truncated && (
        <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, fontStyle: 'italic', padding: '4px 12px' }}>
          Showing {DEFAULT_MAX_ITEMS} of {result.rows.length} rows
        </div>
      )}
    </div>
  );
}

// ─── Grouped Bar Chart ───────────────────────────────────────────────────────

function GroupedBarChart({ result, themeMode, chartConfig }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig }) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<string | null>(null);
  const palette = getPalette(chartConfig?.colorPalette, themeMode);

  const labelCol = chartConfig?.x && result.columns.includes(chartConfig.x) ? chartConfig.x : result.columns[0];
  // All numeric columns except the label column become groups
  const sample = result.rows.slice(0, 5);
  const valueCols = result.columns.filter((c) => c !== labelCol && isMeasureColumn(result, c) && sample.some((r) => isNumericValue(r[c])));
  if (valueCols.length === 0) return <BarChart result={result} themeMode={themeMode} chartConfig={chartConfig} />;

  const labels = result.rows.slice(0, DEFAULT_MAX_ITEMS).map((r) => String(r[labelCol] ?? ''));
  const maxVal = Math.max(...result.rows.slice(0, DEFAULT_MAX_ITEMS).flatMap((r) => valueCols.map((c) => Math.abs(Number(r[c] ?? 0)))), 1);

  const GROUP_H = 24, BAR_H = GROUP_H / valueCols.length, LABEL_W = 120, PAD = 12, GAP = 8;
  const svgH = labels.length * (GROUP_H + GAP) + PAD * 2;

  return (
    <div style={{ padding: '8px 0' }}>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, padding: '0 12px 6px', flexWrap: 'wrap' }}>
        {valueCols.map((col, ci) => (
          <div key={col} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: palette[ci % palette.length] }} />
            <span style={{ fontSize: 11, fontFamily: t.font, color: t.textSecondary }}>{col}</span>
          </div>
        ))}
      </div>
      <svg width="100%" height={svgH} viewBox={`0 0 600 ${svgH}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
        {labels.map((label, i) => {
          const y = PAD + i * (GROUP_H + GAP);
          const row = result.rows[i];
          return (
            <g key={i}>
              <text x={LABEL_W - 8} y={y + GROUP_H / 2 + 4} textAnchor="end" fontSize={11} fontFamily={t.font} fill={t.textSecondary}>
                {label.length > 16 ? label.slice(0, 15) + '…' : label}
              </text>
              {valueCols.map((col, ci) => {
                const val = Number(row[col] ?? 0);
                const barMaxW = 600 - LABEL_W - 60;
                const barW = Math.max((Math.abs(val) / maxVal) * barMaxW, 1);
                const by = y + ci * BAR_H;
                const key = `${i}-${ci}`;
                return (
                  <g key={ci} onMouseEnter={() => setHoveredIdx(key)} onMouseLeave={() => setHoveredIdx(null)}>
                    <rect x={LABEL_W} y={by} width={barW} height={BAR_H - 1} rx={2}
                      fill={palette[ci % palette.length]}
                      opacity={hoveredIdx === key ? 1 : 0.85}
                      style={{ transition: 'opacity 0.15s' }} />
                    {hoveredIdx === key && (
                      <text x={LABEL_W + barW + 4} y={by + BAR_H / 2 + 3} fontSize={10} fontFamily={t.fontMono} fill={t.textMuted}>
                        {abbreviate(val, col, chartConfig?.format, metaFor(result, col))}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Stacked Bar Chart ───────────────────────────────────────────────────────

function StackedBarChart({ result, themeMode, chartConfig }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig }) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<string | null>(null);
  const palette = getPalette(chartConfig?.colorPalette, themeMode);

  const labelCol = chartConfig?.x && result.columns.includes(chartConfig.x) ? chartConfig.x : result.columns[0];
  const sample = result.rows.slice(0, 5);
  const valueCols = result.columns.filter((c) => c !== labelCol && isMeasureColumn(result, c) && sample.some((r) => isNumericValue(r[c])));
  if (valueCols.length === 0) return <BarChart result={result} themeMode={themeMode} chartConfig={chartConfig} />;

  const rows = result.rows.slice(0, DEFAULT_MAX_ITEMS);
  const labels = rows.map((r) => String(r[labelCol] ?? ''));
  const maxTotal = Math.max(...rows.map((r) => valueCols.reduce((s, c) => s + Math.abs(Number(r[c] ?? 0)), 0)), 1);

  const BAR_H = 28, LABEL_W = 120, PAD = 12, GAP = 6;
  const svgH = labels.length * (BAR_H + GAP) + PAD * 2;

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', gap: 12, padding: '0 12px 6px', flexWrap: 'wrap' }}>
        {valueCols.map((col, ci) => (
          <div key={col} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: palette[ci % palette.length] }} />
            <span style={{ fontSize: 11, fontFamily: t.font, color: t.textSecondary }}>{col}</span>
          </div>
        ))}
      </div>
      <svg width="100%" height={svgH} viewBox={`0 0 600 ${svgH}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
        {labels.map((label, i) => {
          const y = PAD + i * (BAR_H + GAP);
          const row = rows[i];
          const barMaxW = 600 - LABEL_W - 60;
          let xOff = LABEL_W;
          return (
            <g key={i}>
              <text x={LABEL_W - 8} y={y + BAR_H / 2 + 4} textAnchor="end" fontSize={11} fontFamily={t.font} fill={t.textSecondary}>
                {label.length > 16 ? label.slice(0, 15) + '…' : label}
              </text>
              {valueCols.map((col, ci) => {
                const val = Math.abs(Number(row[col] ?? 0));
                const w = Math.max((val / maxTotal) * barMaxW, 0);
                const x = xOff;
                xOff += w;
                const key = `${i}-${ci}`;
                return (
                  <g key={ci} onMouseEnter={() => setHoveredIdx(key)} onMouseLeave={() => setHoveredIdx(null)}>
                    <rect x={x} y={y} width={w} height={BAR_H} rx={ci === 0 ? 3 : 0}
                      fill={palette[ci % palette.length]}
                      opacity={hoveredIdx === key ? 1 : 0.85}
                      style={{ transition: 'opacity 0.15s' }} />
                    {hoveredIdx === key && w > 30 && (
                      <text x={x + w / 2} y={y + BAR_H / 2 + 4} textAnchor="middle" fontSize={10} fontFamily={t.fontMono} fill="#fff" fontWeight={600}>
                        {abbreviate(val, col, chartConfig?.format, metaFor(result, col))}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Line Chart ───────────────────────────────────────────────────────────────

function LineChart({ result, themeMode, showArea, chartConfig, availableHeight, availableWidth }: { result: QueryResult; themeMode: ThemeMode; showArea?: boolean; chartConfig?: CellChartConfig; availableHeight?: number; availableWidth?: number }) {
  const t = themes[themeMode];
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: number } | null>(null);
  const palette = getPalette(chartConfig?.colorPalette, themeMode);
  const lineColor = palette[0] ?? t.accent;

  const { labelCol: xCol, valueCol: yCol } = pickColumns(result, chartConfig);
  const data = result.rows.map((row) => ({ label: String(row[xCol] ?? ''), value: Number(row[yCol] ?? 0) }));
  if (data.length < 2) return null;

  const WIDTH = availableWidth && availableWidth > 0 ? Math.max(240, Math.min(720, availableWidth)) : 560;
  const HEIGHT = availableHeight && availableHeight > 0
    ? Math.max(150, Math.min(320, availableHeight - 4))
    : 212;
  const compact = WIDTH < 360;
  const PAD_L = compact ? 44 : 56, PAD_R = compact ? 8 : 16, PAD_T = 16, PAD_B = 48;
  const chartW = WIDTH - PAD_L - PAD_R, chartH = HEIGHT - PAD_T - PAD_B;

  const minVal = Math.min(...data.map((d) => d.value));
  const maxVal = Math.max(...data.map((d) => d.value));
  const valRange = maxVal - minVal || 1;
  const xStep = chartW / (data.length - 1);

  const toX = (i: number) => PAD_L + i * xStep;
  const toY = (v: number) => PAD_T + chartH - ((v - minVal) / valRange) * chartH;

  const points = data.map((d, i) => ({ x: toX(i), y: toY(d.value) }));
  const pathD = points.reduce((acc, pt, i) => {
    if (i === 0) return `M ${pt.x},${pt.y}`;
    const prev = points[i - 1];
    const cx1 = prev.x + (pt.x - prev.x) / 2;
    return `${acc} C ${cx1},${prev.y} ${cx1},${pt.y} ${pt.x},${pt.y}`;
  }, '');

  const areaD = `${pathD} L ${points[points.length - 1].x},${PAD_T + chartH} L ${PAD_L},${PAD_T + chartH} Z`;

  const TICKS = compact ? 4 : 5;
  const yTicks = Array.from({ length: TICKS + 1 }, (_, i) => {
    const val = minVal + (valRange * i) / TICKS;
    return { val, y: toY(val) };
  });

  const labelStep = Math.ceil(data.length / 8);
  const xLabelIndexes = compact
    ? [...new Set(WIDTH < 300
      ? [0, data.length - 1]
      : [0, Math.floor((data.length - 1) / 2), data.length - 1])]
    : data.map((_, index) => index).filter((index) => index % labelStep === 0 || index === data.length - 1);

  return (
    <div style={{ position: 'relative', padding: '8px 0' }}>
      <svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }} onMouseLeave={() => setTooltip(null)}>
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={tick.y} x2={PAD_L + chartW} y2={tick.y} stroke={t.tableBorder} strokeWidth={0.5} />
            <text x={PAD_L - 6} y={tick.y + 4} textAnchor="end" fontSize={10} fontFamily={t.fontMono} fill={t.textMuted}>{abbreviate(tick.val, yCol, chartConfig?.format, metaFor(result, yCol))}</text>
          </g>
        ))}
        <path d={areaD} fill={lineColor} opacity={showArea ? 0.3 : 0.15} />
        <path d={pathD} fill="none" stroke={lineColor} strokeWidth={2} strokeLinejoin="round" />
        {points.map((pt, i) => (
          <circle key={i} cx={pt.x} cy={pt.y} r={3} fill={lineColor} style={{ cursor: 'crosshair' }}
            onMouseEnter={() => setTooltip({ x: pt.x, y: pt.y, label: data[i].label, value: data[i].value })} />
        ))}
        {xLabelIndexes.map((idx) => {
          const item = data[idx];
          return (
            <text key={idx} x={toX(idx)} y={PAD_T + chartH + 16} textAnchor={idx === 0 ? 'start' : idx === data.length - 1 ? 'end' : 'middle'} fontSize={10} fontFamily={t.font} fill={t.textMuted}>
              {formatDateLabel(item.label)}
            </text>
          );
        })}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />
        <line x1={PAD_L} y1={PAD_T + chartH} x2={PAD_L + chartW} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />
        {/* Axis titles — muted column names so the chart reads standalone. */}
        <text x={PAD_L + chartW / 2} y={HEIGHT - 4} textAnchor="middle" fontSize={10} fontWeight={600} fontFamily={t.font} fill={t.textMuted} letterSpacing="0.04em">
          {xCol}
        </text>
        {!compact ? <text x={12} y={PAD_T + chartH / 2} textAnchor="middle" fontSize={10} fontWeight={600} fontFamily={t.font} fill={t.textMuted} letterSpacing="0.04em" transform={`rotate(-90, 12, ${PAD_T + chartH / 2})`}>
          {yCol}
        </text> : null}
        {tooltip && (
          <g>
            <rect x={tooltip.x + 8} y={tooltip.y - 20} width={90} height={32} rx={4} fill={t.cellBg} stroke={t.cellBorder} strokeWidth={1} />
            <text x={tooltip.x + 13} y={tooltip.y - 8} fontSize={10} fontFamily={t.font} fill={t.textSecondary}>
              {formatDateLabel(tooltip.label, 12)}
            </text>
            <text x={tooltip.x + 13} y={tooltip.y + 6} fontSize={11} fontFamily={t.fontMono} fill={t.textPrimary} fontWeight={600}>
              {abbreviate(tooltip.value, yCol, chartConfig?.format, metaFor(result, yCol))}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ─── Scatter Plot ─────────────────────────────────────────────────────────────

function ScatterChart({ result, themeMode, chartConfig }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig }) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const palette = getPalette(chartConfig?.colorPalette, themeMode);

  const xCol = chartConfig?.x && result.columns.includes(chartConfig.x) ? chartConfig.x : result.columns[0];
  const yCol = chartConfig?.y && result.columns.includes(chartConfig.y) ? chartConfig.y : result.columns[1];
  const colorCol = chartConfig?.color && result.columns.includes(chartConfig.color) ? chartConfig.color : undefined;

  const data = result.rows.slice(0, 200).map((row) => ({
    x: Number(row[xCol] ?? 0),
    y: Number(row[yCol] ?? 0),
    color: colorCol ? String(row[colorCol] ?? '') : undefined,
  }));

  const WIDTH = 560, HEIGHT = 300;
  const PAD_L = 52, PAD_R = 16, PAD_T = 16, PAD_B = 36;
  const chartW = WIDTH - PAD_L - PAD_R, chartH = HEIGHT - PAD_T - PAD_B;

  const xMin = Math.min(...data.map((d) => d.x));
  const xMax = Math.max(...data.map((d) => d.x));
  const yMin = Math.min(...data.map((d) => d.y));
  const yMax = Math.max(...data.map((d) => d.y));
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const toSX = (v: number) => PAD_L + ((v - xMin) / xRange) * chartW;
  const toSY = (v: number) => PAD_T + chartH - ((v - yMin) / yRange) * chartH;

  // Color categories
  const categories = colorCol ? [...new Set(data.map((d) => d.color!))] : [];

  return (
    <div style={{ padding: '8px 0' }}>
      {colorCol && categories.length > 0 && (
        <div style={{ display: 'flex', gap: 12, padding: '0 12px 6px', flexWrap: 'wrap' }}>
          {categories.slice(0, 12).map((cat, ci) => (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: palette[ci % palette.length] }} />
              <span style={{ fontSize: 11, fontFamily: t.font, color: t.textSecondary }}>{cat}</span>
            </div>
          ))}
        </div>
      )}
      <svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
        {/* Grid */}
        {Array.from({ length: 6 }, (_, i) => {
          const val = yMin + (yRange * i) / 5;
          const y = toSY(val);
          return (
            <g key={i}>
              <line x1={PAD_L} y1={y} x2={PAD_L + chartW} y2={y} stroke={t.tableBorder} strokeWidth={0.5} />
              <text x={PAD_L - 6} y={y + 4} textAnchor="end" fontSize={10} fontFamily={t.fontMono} fill={t.textMuted}>{abbreviate(val, yCol, chartConfig?.format, metaFor(result, yCol))}</text>
            </g>
          );
        })}
        {/* X labels */}
        {Array.from({ length: 6 }, (_, i) => {
          const val = xMin + (xRange * i) / 5;
          const x = toSX(val);
          return (
            <text key={i} x={x} y={PAD_T + chartH + 16} textAnchor="middle" fontSize={10} fontFamily={t.fontMono} fill={t.textMuted}>{abbreviate(val, xCol, undefined, metaFor(result, xCol))}</text>
          );
        })}
        {/* Axes */}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />
        <line x1={PAD_L} y1={PAD_T + chartH} x2={PAD_L + chartW} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />
        {/* Axis labels */}
        <text x={PAD_L + chartW / 2} y={HEIGHT - 2} textAnchor="middle" fontSize={10} fontFamily={t.font} fill={t.textMuted}>{xCol}</text>
        <text x={10} y={PAD_T + chartH / 2} textAnchor="middle" fontSize={10} fontFamily={t.font} fill={t.textMuted} transform={`rotate(-90, 10, ${PAD_T + chartH / 2})`}>{yCol}</text>
        {/* Points */}
        {data.map((d, i) => {
          const ci = colorCol ? categories.indexOf(d.color!) : 0;
          return (
            <circle key={i} cx={toSX(d.x)} cy={toSY(d.y)} r={hoveredIdx === i ? 5 : 3.5}
              fill={palette[ci % palette.length]} opacity={hoveredIdx === i ? 1 : 0.7}
              style={{ cursor: 'crosshair', transition: 'r 0.1s, opacity 0.1s' }}
              onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)} />
          );
        })}
        {hoveredIdx !== null && (
          <g>
            <rect x={toSX(data[hoveredIdx].x) + 8} y={toSY(data[hoveredIdx].y) - 24} width={100} height={28} rx={4} fill={t.cellBg} stroke={t.cellBorder} strokeWidth={1} />
            <text x={toSX(data[hoveredIdx].x) + 13} y={toSY(data[hoveredIdx].y) - 8} fontSize={10} fontFamily={t.fontMono} fill={t.textPrimary}>
              ({abbreviate(data[hoveredIdx].x, xCol, undefined, metaFor(result, xCol))}, {abbreviate(data[hoveredIdx].y, yCol, chartConfig?.format, metaFor(result, yCol))})
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ─── Pie / Donut Chart ───────────────────────────────────────────────────────

const MAX_PIE_SLICES = 12;

function PieDonutChart({ result, themeMode, chartConfig, isDonut }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig; isDonut: boolean }) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const { labelCol, valueCol } = pickColumns(result, chartConfig);
  const palette = getPalette(chartConfig?.colorPalette, themeMode);

  const rawData = result.rows.slice(0, MAX_PIE_SLICES).map((row) => ({
    label: String(row[labelCol] ?? ''),
    value: Math.abs(Number(row[valueCol] ?? 0)),
  }));

  const total = rawData.reduce((s, d) => s + d.value, 0) || 1;
  const CX = 90, CY = 90, R = 70, IR = isDonut ? 40 : 0;
  const slices: Array<{ path: string; color: string; label: string; value: number; pct: number }> = [];
  let angle = -Math.PI / 2;

  rawData.forEach((d, i) => {
    const sweep = (d.value / total) * 2 * Math.PI;
    const a1 = angle, a2 = angle + sweep;
    const lx1 = CX + R * Math.cos(a1), ly1 = CY + R * Math.sin(a1);
    const lx2 = CX + R * Math.cos(a2), ly2 = CY + R * Math.sin(a2);
    const large = sweep > Math.PI ? 1 : 0;
    let path: string;
    if (IR > 0) {
      const ix1 = CX + IR * Math.cos(a1), iy1 = CY + IR * Math.sin(a1);
      const ix2 = CX + IR * Math.cos(a2), iy2 = CY + IR * Math.sin(a2);
      path = `M ${lx1} ${ly1} A ${R} ${R} 0 ${large} 1 ${lx2} ${ly2} L ${ix2} ${iy2} A ${IR} ${IR} 0 ${large} 0 ${ix1} ${iy1} Z`;
    } else {
      path = `M ${CX} ${CY} L ${lx1} ${ly1} A ${R} ${R} 0 ${large} 1 ${lx2} ${ly2} Z`;
    }
    slices.push({ path, color: palette[i % palette.length], label: d.label, value: d.value, pct: (d.value / total) * 100 });
    angle = a2;
  });

  const hovered = hoveredIdx !== null ? slices[hoveredIdx] : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 12px', flexWrap: 'wrap' }}>
      <svg width={180} height={180} style={{ flexShrink: 0 }} onMouseLeave={() => setHoveredIdx(null)}>
        {slices.map((s, i) => (
          <path key={i} d={s.path} fill={s.color} opacity={hoveredIdx === null || hoveredIdx === i ? 1 : 0.55}
            style={{ cursor: 'pointer', transition: 'opacity 0.15s' }} onMouseEnter={() => setHoveredIdx(i)} />
        ))}
        {isDonut && (
          <>
            <text x={CX} y={CY - 5} textAnchor="middle" fontSize={11} fontFamily={t.fontMono} fill={t.textSecondary}>
              {hovered ? abbreviate(hovered.value, valueCol, chartConfig?.format, metaFor(result, valueCol)) : abbreviate(total, valueCol, chartConfig?.format, metaFor(result, valueCol))}
            </text>
            <text x={CX} y={CY + 9} textAnchor="middle" fontSize={9} fontFamily={t.font} fill={t.textMuted}>
              {hovered ? `${hovered.pct.toFixed(1)}%` : 'total'}
            </text>
          </>
        )}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto', flex: 1 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'default', opacity: hoveredIdx === null || hoveredIdx === i ? 1 : 0.5 }}
            onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: t.font, color: t.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{s.label}</span>
            <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textMuted, marginLeft: 'auto', flexShrink: 0 }}>{s.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Heatmap ──────────────────────────────────────────────────────────────────

function HeatmapChart({ result, themeMode }: { result: QueryResult; themeMode: ThemeMode }) {
  const t = themes[themeMode];
  const [hovered, setHovered] = useState<{ r: number; c: number } | null>(null);

  // First column = row labels, remaining columns = heatmap cells
  const rowLabelCol = result.columns[0];
  const valueCols = result.columns.slice(1);
  const rows = result.rows.slice(0, 30);

  const allValues = rows.flatMap((r) => valueCols.map((c) => Number(r[c] ?? 0)));
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const range = maxVal - minVal || 1;

  const CELL_W = Math.min(50, 480 / valueCols.length);
  const CELL_H = 24;
  const LABEL_W = 100;

  // Magnitude is one hue, light to dark; each step names its readable text colour.
  const heatStep = (val: number) => sequentialStep((val - minVal) / range, themeMode);

  return (
    <div style={{ padding: '8px 0', overflowX: 'auto' }}>
      <svg width={LABEL_W + valueCols.length * CELL_W + 20} height={rows.length * CELL_H + CELL_H + 16}
        style={{ display: 'block', overflow: 'visible' }}>
        {/* Column headers */}
        {valueCols.map((col, ci) => (
          <text key={ci} x={LABEL_W + ci * CELL_W + CELL_W / 2} y={14} textAnchor="middle" fontSize={9} fontFamily={t.font} fill={t.textMuted}
            transform={`rotate(-30, ${LABEL_W + ci * CELL_W + CELL_W / 2}, 14)`}>
            {col.length > 8 ? col.slice(0, 7) + '…' : col}
          </text>
        ))}
        {/* Rows */}
        {rows.map((row, ri) => {
          const label = String(row[rowLabelCol] ?? '');
          const y = CELL_H + ri * CELL_H;
          return (
            <g key={ri}>
              <text x={LABEL_W - 6} y={y + CELL_H / 2 + 4} textAnchor="end" fontSize={10} fontFamily={t.font} fill={t.textSecondary}>
                {label.length > 14 ? label.slice(0, 13) + '…' : label}
              </text>
              {valueCols.map((col, ci) => {
                const val = Number(row[col] ?? 0);
                const isH = hovered?.r === ri && hovered?.c === ci;
                return (
                  <g key={ci} onMouseEnter={() => setHovered({ r: ri, c: ci })} onMouseLeave={() => setHovered(null)}>
                    <rect x={LABEL_W + ci * CELL_W} y={y} width={CELL_W - 1} height={CELL_H - 1} rx={2}
                      fill={heatStep(val).fill} opacity={isH ? 1 : 0.85} stroke={isH ? t.accent : 'none'} strokeWidth={isH ? 1.5 : 0} />
                    {isH && (
                      <text x={LABEL_W + ci * CELL_W + CELL_W / 2} y={y + CELL_H / 2 + 4} textAnchor="middle"
                        fontSize={10} fontFamily={t.fontMono} fill={heatStep(val).text} fontWeight={600}>
                        {abbreviate(val, col, undefined, metaFor(result, col))}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Histogram ────────────────────────────────────────────────────────────────

function HistogramChart({ result, themeMode, chartConfig }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig }) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const palette = getPalette(chartConfig?.colorPalette, themeMode);
  const barColor = palette[0] ?? t.accent;

  // Use first numeric column
  const numCol = (chartConfig?.x && result.columns.includes(chartConfig.x) ? chartConfig.x : undefined) ??
    measureColumns(result)[0] ?? result.columns[0];

  const values = result.rows.map((r) => Number(r[numCol] ?? 0)).filter((v) => !isNaN(v));
  if (values.length === 0) return null;

  const BINS = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const binWidth = range / BINS;

  const bins = Array.from({ length: BINS }, (_, i) => ({
    low: min + i * binWidth,
    high: min + (i + 1) * binWidth,
    count: 0,
  }));
  values.forEach((v) => {
    const idx = Math.min(Math.floor((v - min) / binWidth), BINS - 1);
    bins[idx].count++;
  });

  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const WIDTH = 560, HEIGHT = 200;
  const PAD_L = 52, PAD_R = 16, PAD_T = 16, PAD_B = 36;
  const chartW = WIDTH - PAD_L - PAD_R, chartH = HEIGHT - PAD_T - PAD_B;
  const barW = chartW / BINS;

  return (
    <div style={{ padding: '8px 0' }}>
      <svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
        {/* Y grid */}
        {Array.from({ length: 5 }, (_, i) => {
          const val = (maxCount * (i + 1)) / 5;
          const y = PAD_T + chartH - (val / maxCount) * chartH;
          return (
            <g key={i}>
              <line x1={PAD_L} y1={y} x2={PAD_L + chartW} y2={y} stroke={t.tableBorder} strokeWidth={0.5} />
              <text x={PAD_L - 6} y={y + 4} textAnchor="end" fontSize={10} fontFamily={t.fontMono} fill={t.textMuted}>{Math.round(val)}</text>
            </g>
          );
        })}
        {/* Bars */}
        {bins.map((bin, i) => {
          const barH = (bin.count / maxCount) * chartH;
          const x = PAD_L + i * barW;
          const y = PAD_T + chartH - barH;
          const isH = hoveredIdx === i;
          return (
            <g key={i} onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)}>
              <rect x={x + 1} y={y} width={barW - 2} height={barH} rx={1}
                fill={barColor} opacity={isH ? 1 : 0.85} style={{ transition: 'opacity 0.1s' }} />
              {isH && (
                <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize={10} fontFamily={t.fontMono} fill={t.textPrimary}>
                  {bin.count}
                </text>
              )}
            </g>
          );
        })}
        {/* X labels */}
        {bins.filter((_, i) => i % Math.ceil(BINS / 6) === 0).map((bin, i) => {
          const idx = bins.indexOf(bin);
          return (
            <text key={i} x={PAD_L + idx * barW + barW / 2} y={PAD_T + chartH + 16} textAnchor="middle" fontSize={10} fontFamily={t.fontMono} fill={t.textMuted}>
              {abbreviate(bin.low, numCol, chartConfig?.format, metaFor(result, numCol))}
            </text>
          );
        })}
        {/* Axes */}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />
        <line x1={PAD_L} y1={PAD_T + chartH} x2={PAD_L + chartW} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />
        {/* Label */}
        <text x={PAD_L + chartW / 2} y={HEIGHT - 2} textAnchor="middle" fontSize={10} fontFamily={t.font} fill={t.textMuted}>{numCol}</text>
      </svg>
    </div>
  );
}

// ─── Funnel Chart ─────────────────────────────────────────────────────────────

function FunnelChart({ result, themeMode, chartConfig }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig }) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const { labelCol, valueCol } = pickColumns(result, chartConfig);
  const palette = getPalette(chartConfig?.colorPalette, themeMode);

  const data = result.rows.slice(0, 10).map((row) => ({
    label: String(row[labelCol] ?? ''),
    value: Math.abs(Number(row[valueCol] ?? 0)),
  }));

  if (data.length === 0) return null;
  const maxVal = data[0].value || 1;

  const WIDTH = 400, ROW_H = 36, GAP = 4, PAD = 16;
  const HEIGHT = data.length * (ROW_H + GAP) + PAD * 2;
  const CENTER = WIDTH / 2;

  return (
    <div style={{ padding: '8px 0', display: 'flex', justifyContent: 'center' }}>
      <svg width={WIDTH} height={HEIGHT} style={{ display: 'block' }}>
        {data.map((d, i) => {
          const y = PAD + i * (ROW_H + GAP);
          const pct = d.value / maxVal;
          const w = Math.max(pct * (WIDTH - 80), 40);
          const isH = hoveredIdx === i;
          // Trapezoid shape
          const nextPct = i < data.length - 1 ? (data[i + 1].value / maxVal) : pct * 0.8;
          const nextW = Math.max(nextPct * (WIDTH - 80), 40);
          const x1 = CENTER - w / 2, x2 = CENTER + w / 2;
          const x3 = CENTER + nextW / 2, x4 = CENTER - nextW / 2;
          const path = `M ${x1} ${y} L ${x2} ${y} L ${x3} ${y + ROW_H} L ${x4} ${y + ROW_H} Z`;
          return (
            <g key={i} onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)} style={{ cursor: 'default' }}>
              <path d={path} fill={palette[i % palette.length]} opacity={isH ? 1 : 0.85} style={{ transition: 'opacity 0.15s' }} />
              <text x={CENTER} y={y + ROW_H / 2 + 1} textAnchor="middle" fontSize={11} fontFamily={t.font} fill="#fff" fontWeight={500}>
                {d.label}
              </text>
              <text x={CENTER} y={y + ROW_H / 2 + 13} textAnchor="middle" fontSize={9} fontFamily={t.fontMono} fill="rgba(255,255,255,0.7)">
                {abbreviate(d.value, valueCol, chartConfig?.format, metaFor(result, valueCol))} ({(pct * 100).toFixed(0)}%)
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Sankey / Flow Chart ─────────────────────────────────────────────────────

function SankeyChart({ result, themeMode, chartConfig }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig }) {
  const t = themes[themeMode];
  const palette = getPalette(chartConfig?.colorPalette, themeMode);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const sample = result.rows.slice(0, 20);
  const numericColumns = result.columns.filter((column) => isMeasureColumn(result, column) && sample.some((row) => isNumericValue(row[column])));
  const dimensionColumns = result.columns.filter((column) => !numericColumns.includes(column));
  const sourceCol = chartConfig?.x && dimensionColumns.includes(chartConfig.x)
    ? chartConfig.x
    : dimensionColumns.find((column) => /(?:^|_)(?:source|from|origin|upstream|supplier|producer|category)(?:_|$)/i.test(column)) ?? dimensionColumns[0];
  const targetCol = chartConfig?.color && dimensionColumns.includes(chartConfig.color) && chartConfig.color !== sourceCol
    ? chartConfig.color
    : dimensionColumns.find((column) => column !== sourceCol && /(?:^|_)(?:target|to|destination|downstream|consumer|customer|product)(?:_|$)/i.test(column))
      ?? dimensionColumns.find((column) => column !== sourceCol);
  const valueCol = chartConfig?.y && numericColumns.includes(chartConfig.y) ? chartConfig.y : numericColumns[0];

  if (!sourceCol || !targetCol || !valueCol) return <TableOutput result={result} themeMode={themeMode} />;

  const aggregated = new Map<string, { source: string; target: string; value: number }>();
  for (const row of result.rows) {
    const source = String(row[sourceCol] ?? '').trim();
    const target = String(row[targetCol] ?? '').trim();
    const value = Math.abs(Number(row[valueCol] ?? 0));
    if (!source || !target || !Number.isFinite(value) || value <= 0) continue;
    const key = `${source}\u0000${target}`;
    const previous = aggregated.get(key);
    aggregated.set(key, { source, target, value: (previous?.value ?? 0) + value });
  }
  const allLinks = [...aggregated.values()].sort((left, right) => right.value - left.value);
  if (allLinks.length === 0) return <TableOutput result={result} themeMode={themeMode} />;

  const sourceTotals = new Map<string, number>();
  const targetTotals = new Map<string, number>();
  allLinks.forEach((link) => {
    sourceTotals.set(link.source, (sourceTotals.get(link.source) ?? 0) + link.value);
    targetTotals.set(link.target, (targetTotals.get(link.target) ?? 0) + link.value);
  });
  const sources = [...sourceTotals].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([name]) => name);
  const targets = [...targetTotals].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([name]) => name);
  const visibleSources = new Set(sources);
  const visibleTargets = new Set(targets);
  const links = allLinks.filter((link) => visibleSources.has(link.source) && visibleTargets.has(link.target)).slice(0, 40);
  const maxLink = Math.max(...links.map((link) => link.value), 1);

  const WIDTH = 640;
  const HEIGHT = Math.max(250, Math.max(sources.length, targets.length) * 34 + 40);
  const SOURCE_X = 132, TARGET_X = WIDTH - 144, NODE_W = 12, PAD_Y = 28;
  const nodeY = (index: number, count: number) => count <= 1
    ? HEIGHT / 2
    : PAD_Y + index * ((HEIGHT - PAD_Y * 2) / (count - 1));
  const sourceIndex = new Map(sources.map((name, index) => [name, index]));
  const targetIndex = new Map(targets.map((name, index) => [name, index]));

  return (
    <div style={{ padding: '8px 0', overflowX: 'auto' }}>
      <svg
        role="img"
        aria-label={`${sourceCol} to ${targetCol} flow by ${valueCol}`}
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', minWidth: 520 }}
      >
        <text x={SOURCE_X} y={14} textAnchor="middle" fontSize={10} fontWeight={700} fontFamily={t.font} fill={t.textMuted}>{sourceCol}</text>
        <text x={TARGET_X} y={14} textAnchor="middle" fontSize={10} fontWeight={700} fontFamily={t.font} fill={t.textMuted}>{targetCol}</text>
        {links.map((link, index) => {
          const sy = nodeY(sourceIndex.get(link.source) ?? 0, sources.length);
          const ty = nodeY(targetIndex.get(link.target) ?? 0, targets.length);
          const key = `${link.source}\u0000${link.target}`;
          const active = hoveredKey === key;
          const path = `M ${SOURCE_X + NODE_W},${sy} C ${SOURCE_X + 150},${sy} ${TARGET_X - 150},${ty} ${TARGET_X},${ty}`;
          const midX = WIDTH / 2;
          const midY = (sy + ty) / 2;
          return (
            <g key={key} onMouseEnter={() => setHoveredKey(key)} onMouseLeave={() => setHoveredKey(null)}>
              <path d={path} fill="none" stroke={palette[index % palette.length]} strokeWidth={Math.max(2, (link.value / maxLink) * 18)} opacity={hoveredKey === null || active ? 0.7 : 0.14} strokeLinecap="round" style={{ transition: 'opacity 0.15s', cursor: 'default' }} />
              {active ? (
                <g pointerEvents="none">
                  <rect x={midX - 72} y={midY - 18} width={144} height={36} rx={5} fill={t.cellBg} stroke={t.cellBorder} />
                  <text x={midX} y={midY - 3} textAnchor="middle" fontSize={9.5} fontFamily={t.font} fill={t.textSecondary}>{link.source} → {link.target}</text>
                  <text x={midX} y={midY + 11} textAnchor="middle" fontSize={11} fontWeight={700} fontFamily={t.fontMono} fill={t.textPrimary}>{abbreviate(link.value, valueCol, chartConfig?.format, metaFor(result, valueCol))}</text>
                </g>
              ) : null}
            </g>
          );
        })}
        {sources.map((source, index) => {
          const y = nodeY(index, sources.length);
          return (
            <g key={`source-${source}`}>
              <rect x={SOURCE_X} y={y - 9} width={NODE_W} height={18} rx={3} fill={palette[index % palette.length]} />
              <text x={SOURCE_X - 7} y={y + 3} textAnchor="end" fontSize={10.5} fontFamily={t.font} fill={t.textSecondary}>{source.length > 18 ? `${source.slice(0, 17)}…` : source}</text>
            </g>
          );
        })}
        {targets.map((target, index) => {
          const y = nodeY(index, targets.length);
          return (
            <g key={`target-${target}`}>
              <rect x={TARGET_X} y={y - 9} width={NODE_W} height={18} rx={3} fill={palette[(index + sources.length) % palette.length]} />
              <text x={TARGET_X + NODE_W + 7} y={y + 3} textAnchor="start" fontSize={10.5} fontFamily={t.font} fill={t.textSecondary}>{target.length > 18 ? `${target.slice(0, 17)}…` : target}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Waterfall Chart ──────────────────────────────────────────────────────────

function WaterfallChart({ result, themeMode, chartConfig }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig }) {
  const t = themes[themeMode];
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const { labelCol, valueCol } = pickColumns(result, chartConfig);

  const data = result.rows.slice(0, 15).map((row) => ({
    label: String(row[labelCol] ?? ''),
    value: Number(row[valueCol] ?? 0),
  }));

  if (data.length === 0) return null;

  // Compute running totals
  let running = 0;
  const bars = data.map((d) => {
    const start = running;
    running += d.value;
    return { ...d, start, end: running };
  });

  const allVals = bars.flatMap((b) => [b.start, b.end]);
  const minVal = Math.min(0, ...allVals);
  const maxVal = Math.max(0, ...allVals);
  const valRange = maxVal - minVal || 1;

  const WIDTH = 560, HEIGHT = 240;
  const PAD_L = 52, PAD_R = 16, PAD_T = 16, PAD_B = 44;
  const chartW = WIDTH - PAD_L - PAD_R, chartH = HEIGHT - PAD_T - PAD_B;
  const barW = chartW / bars.length;

  const toY = (v: number) => PAD_T + chartH - ((v - minVal) / valRange) * chartH;

  return (
    <div style={{ padding: '8px 0' }}>
      <svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
        {/* Y grid */}
        {Array.from({ length: 6 }, (_, i) => {
          const val = minVal + (valRange * i) / 5;
          const y = toY(val);
          return (
            <g key={i}>
              <line x1={PAD_L} y1={y} x2={PAD_L + chartW} y2={y} stroke={t.tableBorder} strokeWidth={0.5} />
              <text x={PAD_L - 6} y={y + 4} textAnchor="end" fontSize={10} fontFamily={t.fontMono} fill={t.textMuted}>{abbreviate(val, valueCol, chartConfig?.format, metaFor(result, valueCol))}</text>
            </g>
          );
        })}
        {/* Zero line */}
        <line x1={PAD_L} y1={toY(0)} x2={PAD_L + chartW} y2={toY(0)} stroke={t.textMuted} strokeWidth={1} strokeDasharray="3,3" />
        {/* Bars + connectors */}
        {bars.map((bar, i) => {
          const x = PAD_L + i * barW;
          const y1 = toY(Math.max(bar.start, bar.end));
          const y2 = toY(Math.min(bar.start, bar.end));
          const h = y2 - y1;
          const isPositive = bar.value >= 0;
          const isH = hoveredIdx === i;
          return (
            <g key={i} onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)}>
              {/* Connector line to next bar */}
              {i < bars.length - 1 && (
                <line x1={x + barW - 2} y1={toY(bar.end)} x2={x + barW + 2} y2={toY(bar.end)} stroke={t.textMuted} strokeWidth={1} strokeDasharray="2,2" />
              )}
              <rect x={x + 4} y={y1} width={barW - 8} height={Math.max(h, 1)} rx={2}
                fill={isPositive ? t.success : t.error} opacity={isH ? 1 : 0.8} style={{ transition: 'opacity 0.1s' }} />
              {isH && (
                <text x={x + barW / 2} y={y1 - 4} textAnchor="middle" fontSize={10} fontFamily={t.fontMono} fill={t.textPrimary}>
                  {bar.value >= 0 ? '+' : ''}{abbreviate(bar.value, valueCol, chartConfig?.format, metaFor(result, valueCol))}
                </text>
              )}
            </g>
          );
        })}
        {/* X labels */}
        {bars.map((bar, i) => (
          <text key={i} x={PAD_L + i * barW + barW / 2} y={HEIGHT - 6} textAnchor="middle" fontSize={9} fontFamily={t.font} fill={t.textMuted}
            transform={`rotate(-20, ${PAD_L + i * barW + barW / 2}, ${HEIGHT - 6})`}>
            {bar.label.length > 8 ? bar.label.slice(0, 7) + '…' : bar.label}
          </text>
        ))}
        {/* Axes */}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />
        <line x1={PAD_L} y1={PAD_T + chartH} x2={PAD_L + chartW} y2={PAD_T + chartH} stroke={t.tableBorder} strokeWidth={1} />
      </svg>
    </div>
  );
}

// ─── Gauge Chart ──────────────────────────────────────────────────────────────

function GaugeChart({ result, themeMode, chartConfig }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig }) {
  const t = themes[themeMode];

  const row = result.rows[0];
  if (!row) return null;

  const yCol = (chartConfig?.y && result.columns.includes(chartConfig.y) ? chartConfig.y : undefined) ??
    measureColumns(result).find((c) => isNumericValue(row[c])) ?? result.columns[0];
  const rawVal = Number(row[yCol] ?? 0);
  const label = chartConfig?.title ?? yCol;

  // Assume 0-100 range unless value exceeds that
  const max = rawVal > 100 ? rawVal * 1.2 : 100;
  const pct = Math.min(Math.max(rawVal / max, 0), 1);

  const CX = 120, CY = 110, R = 80;
  // Arc from 180° to 0° (bottom half of circle)
  const startAngle = Math.PI;
  const endAngle = 0;
  const sweepAngle = startAngle - (startAngle - endAngle) * pct;

  const x1 = CX + R * Math.cos(startAngle);
  const y1 = CY + R * Math.sin(startAngle);
  const x2 = CX + R * Math.cos(sweepAngle);
  const y2 = CY + R * Math.sin(sweepAngle);
  const large = pct > 0.5 ? 1 : 0;

  // Background arc
  const bgX2 = CX + R * Math.cos(endAngle);
  const bgY2 = CY + R * Math.sin(endAngle);

  // Color based on percentage
  const color = pct < 0.33 ? t.error : pct < 0.66 ? t.warning : t.success;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 24px' }}>
      <svg width={240} height={140} style={{ display: 'block', overflow: 'visible' }}>
        {/* Background arc */}
        <path d={`M ${x1} ${y1} A ${R} ${R} 0 1 1 ${bgX2} ${bgY2}`}
          fill="none" stroke={t.tableBorder} strokeWidth={12} strokeLinecap="round" />
        {/* Value arc */}
        {pct > 0 && (
          <path d={`M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`}
            fill="none" stroke={color} strokeWidth={12} strokeLinecap="round" />
        )}
        {/* Value text */}
        <text x={CX} y={CY - 4} textAnchor="middle" fontSize={28} fontFamily={t.fontMono} fill={color} fontWeight={700}>
          {abbreviate(rawVal, yCol, chartConfig?.format, metaFor(result, yCol))}
        </text>
        <text x={CX} y={CY + 16} textAnchor="middle" fontSize={11} fontFamily={t.font} fill={t.textMuted}>
          {label}
        </text>
      </svg>
    </div>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

// Format a KPI value honoring the tile's `format` option. Large numbers use
// compact notation ($1.4M, 62K) so the hero figure never overflows a narrow
// KPI tile.
function formatKpiValue(column: string, raw: unknown, values: unknown[], format?: CellChartConfig['format'], meta?: ResultColumnMeta): string {
  const num = Number(raw);
  if (raw === null || raw === undefined || (typeof raw !== 'number' && isNaN(num))) {
    return raw === null || raw === undefined ? '—' : String(raw);
  }
  return formatDisplayValue(column, raw, values, { compact: Math.abs(num) >= 100_000, format, ...(meta ? { meta } : {}) });
}

/**
 * The largest KPI figure size (px) that fits the tile's width, so "$2,880.40"
 * is never cut to "$2,880.…" at the default tile size. Without a measured
 * width the usual responsive size applies.
 */
export function kpiValueFontSize(text: string, availableWidth?: number): number | undefined {
  if (!availableWidth || availableWidth <= 0) return undefined;
  // Monospace digits are about 0.62em wide; keep a little padding.
  const fit = Math.floor((availableWidth - 16) / (Math.max(1, text.length) * 0.62));
  return Math.max(16, Math.min(40, fit));
}

function KpiCard({ result, themeMode, chartConfig, availableWidth }: { result: QueryResult; themeMode: ThemeMode; chartConfig?: CellChartConfig; availableWidth?: number }) {
  const t = themes[themeMode];
  const palette = getPalette(chartConfig?.colorPalette, themeMode);
  const row = result.rows[0];
  if (!row) return null;

  const yCol = chartConfig?.y && result.columns.includes(chartConfig.y) ? chartConfig.y
    : measureColumns(result).find((c) => isNumericValue(row[c])) ?? result.columns[0];

  const displayVal = formatKpiValue(yCol, row[yCol], result.rows.map((item) => item[yCol]), chartConfig?.format, metaFor(result, yCol));
  const kpiFit = kpiValueFontSize(displayVal, availableWidth);

  return (
    <div className="dql-kpi-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', minHeight: 54, padding: '8px 4px', boxSizing: 'border-box', minWidth: 0 }}>
      <span
        className="dql-kpi-value"
        title={String(row[yCol])}
        style={{
          // Viewers embedded in constrained containers did not consistently
          // resolve container-query units, which could collapse the KPI figure
          // to an almost invisible size. Viewport-independent bounds stay
          // readable in compact tiles and in the cloud embed.
          fontSize: kpiFit ? `min(clamp(24px, 3.2vw, 40px), ${kpiFit}px)` : 'clamp(24px, 3.2vw, 40px)', fontWeight: 750, fontFamily: t.fontMono, color: palette[0] ?? t.accent,
          lineHeight: 1.1, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          ...(kpiFit ? { '--kpi-fit': `${kpiFit}px` } : {}),
        } as React.CSSProperties}
      >{displayVal}</span>
    </div>
  );
}

// ─── ChartOutput ──────────────────────────────────────────────────────────────

function ChartConfigPopover({
  config,
  columns,
  onChange,
  onClose,
  t,
}: {
  config: CellChartConfig;
  columns: string[];
  onChange: (updates: Partial<CellChartConfig>) => void;
  onClose: () => void;
  t: typeof themes['dark'];
}) {
  const inputStyle: React.CSSProperties = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.font,
    padding: '4px 8px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 4,
        right: 4,
        zIndex: 100,
        background: t.cellBg,
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 8,
        padding: 12,
        width: 240,
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        display: 'grid',
        gap: 8,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>Chart Settings</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 14 }}>&times;</button>
      </div>
      <label style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
        Title
        <input value={config.title ?? ''} onChange={(e) => onChange({ title: e.target.value || undefined })} placeholder="Chart title" style={{ ...inputStyle, marginTop: 2 }} />
      </label>
      <label style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
        X-axis label
        <input value={config.xLabel ?? ''} onChange={(e) => onChange({ xLabel: e.target.value || undefined })} placeholder="Auto" style={{ ...inputStyle, marginTop: 2 }} />
      </label>
      <label style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
        Y-axis label
        <input value={config.yLabel ?? ''} onChange={(e) => onChange({ yLabel: e.target.value || undefined })} placeholder="Auto" style={{ ...inputStyle, marginTop: 2 }} />
      </label>
      <label style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
        Legend
        <select value={config.legendPosition ?? 'top'} onChange={(e) => onChange({ legendPosition: e.target.value as CellChartConfig['legendPosition'] })} style={{ ...inputStyle, marginTop: 2 }}>
          <option value="top">Top</option>
          <option value="bottom">Bottom</option>
          <option value="left">Left</option>
          <option value="right">Right</option>
          <option value="none">Hidden</option>
        </select>
      </label>
      <label style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
        Color palette
        <select value={selectedPaletteOption(config.colorPalette)} onChange={(e) => onChange({ colorPalette: e.target.value as CellChartConfig['colorPalette'] })} style={{ ...inputStyle, marginTop: 2 }}>
          {CHART_PALETTE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
        Max items
        <input type="number" value={config.maxItems ?? DEFAULT_MAX_ITEMS} min={5} max={200} onChange={(e) => onChange({ maxItems: parseInt(e.target.value) || DEFAULT_MAX_ITEMS })} style={{ ...inputStyle, marginTop: 2 }} />
      </label>
    </div>
  );
}

export function ChartOutput({ result, themeMode, chartConfig, availableHeight, availableWidth, onMarkSelect, onConfigChange }: ChartOutputProps & { onConfigChange?: (updates: Partial<CellChartConfig>) => void }) {
  const t = themes[themeMode];
  const resolvedType = resolveChartType(result, chartConfig);
  const [showConfig, setShowConfig] = useState(false);

  // KPI renders without toggle bar
  if (resolvedType === 'kpi') {
    return <KpiCard result={result} themeMode={themeMode} chartConfig={chartConfig} availableWidth={availableWidth} />;
  }

  return (
    <div style={{ position: 'relative' }}>
      {chartConfig?.title && (
        <div style={{ padding: '8px 12px 0', fontSize: 13, fontWeight: 600, color: t.textPrimary, fontFamily: t.font, textAlign: 'center' }}>
          {chartConfig.title}
        </div>
      )}
      {onConfigChange && (
        <button
          onClick={() => setShowConfig(!showConfig)}
          title="Chart settings"
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            zIndex: 50,
            background: showConfig ? `${t.accent}18` : 'transparent',
            border: `1px solid ${showConfig ? t.accent : 'transparent'}`,
            borderRadius: 4,
            color: showConfig ? t.accent : t.textMuted,
            cursor: 'pointer',
            fontSize: 14,
            padding: '2px 6px',
            lineHeight: 1,
          }}
        >
          &#9881;
        </button>
      )}
      {showConfig && onConfigChange && (
        <ChartConfigPopover
          config={chartConfig ?? {}}
          columns={result.columns}
          onChange={(updates) => onConfigChange(updates)}
          onClose={() => setShowConfig(false)}
          t={t}
        />
      )}
      {renderChart(resolvedType, result, themeMode, chartConfig, availableHeight, availableWidth, onMarkSelect)}
    </div>
  );
}

export function renderChart(chartType: ChartType, result: QueryResult, themeMode: ThemeMode, chartConfig?: CellChartConfig, availableHeight?: number, availableWidth?: number, onMarkSelect?: (row: Record<string, unknown>) => void): React.ReactElement | null {
  const svgChart = renderSvgChart(chartType, result, themeMode, chartConfig, availableHeight, availableWidth, onMarkSelect);
  if (!ECHARTS_CHART_TYPES.has(chartType)) return svgChart;
  // Standard charts are drawn by ECharts from the DQL chart settings (RFC 0008
  // step 4); the SVG chart stays as the fallback for data ECharts cannot draw.
  return (
    <EChartsChart
      chartType={chartType}
      result={result}
      themeMode={themeMode}
      config={chartConfig}
      availableHeight={availableHeight}
      availableWidth={availableWidth}
      onMarkSelect={onMarkSelect}
      fallback={svgChart}
    />
  );
}

function renderSvgChart(chartType: ChartType, result: QueryResult, themeMode: ThemeMode, chartConfig?: CellChartConfig, availableHeight?: number, availableWidth?: number, onMarkSelect?: (row: Record<string, unknown>) => void): React.ReactElement | null {
  // Reorder columns based on explicit config
  const xCol = chartConfig?.x && result.columns.includes(chartConfig.x) ? chartConfig.x : undefined;
  const yCol = chartConfig?.y && result.columns.includes(chartConfig.y) ? chartConfig.y : undefined;
  const configuredResult = (xCol || yCol) ? reorderColumns(result, xCol, yCol) : result;

  switch (chartType) {
    case 'line':
      return <LineChart result={configuredResult} themeMode={themeMode} chartConfig={chartConfig} availableHeight={availableHeight} availableWidth={availableWidth} />;
    case 'area':
      return <LineChart result={configuredResult} themeMode={themeMode} chartConfig={chartConfig} availableHeight={availableHeight} availableWidth={availableWidth} showArea />;
    case 'bar':
      return <BarChart result={configuredResult} themeMode={themeMode} chartConfig={chartConfig} availableHeight={availableHeight} availableWidth={availableWidth} onMarkSelect={onMarkSelect} />;
    case 'grouped-bar':
      return <GroupedBarChart result={configuredResult} themeMode={themeMode} chartConfig={chartConfig} />;
    case 'stacked-bar':
      return <StackedBarChart result={configuredResult} themeMode={themeMode} chartConfig={chartConfig} />;
    case 'scatter':
      return <ScatterChart result={result} themeMode={themeMode} chartConfig={chartConfig} />;
    case 'pie':
      return <PieDonutChart result={result} themeMode={themeMode} chartConfig={chartConfig} isDonut={false} />;
    case 'donut':
      return <PieDonutChart result={result} themeMode={themeMode} chartConfig={chartConfig} isDonut />;
    case 'heatmap':
      return <HeatmapChart result={result} themeMode={themeMode} />;
    case 'histogram':
      return <HistogramChart result={result} themeMode={themeMode} chartConfig={chartConfig} />;
    case 'funnel':
      return <FunnelChart result={result} themeMode={themeMode} chartConfig={chartConfig} />;
    case 'sankey':
      return <SankeyChart result={result} themeMode={themeMode} chartConfig={chartConfig} />;
    case 'waterfall':
      return <WaterfallChart result={result} themeMode={themeMode} chartConfig={chartConfig} />;
    case 'gauge':
      return <GaugeChart result={result} themeMode={themeMode} chartConfig={chartConfig} />;
    case 'kpi':
      return <KpiCard result={result} themeMode={themeMode} chartConfig={chartConfig} />;
    default:
      return <TableOutput result={result} themeMode={themeMode} />;
  }
}

function ColumnWarnings({ warnings, t }: { warnings: string[]; t: typeof themes['dark'] }) {
  return (
    <div style={{ padding: '4px 12px', background: '#e3b34115', borderBottom: '1px solid #e3b34130', display: 'flex', flexDirection: 'column', gap: 2 }}>
      {warnings.map((w, i) => (
        <span key={i} style={{ fontSize: 11, color: '#e3b341', fontFamily: t.font }}>{w}</span>
      ))}
    </div>
  );
}

/** Reorder columns so that the explicit x/y cols come first (for bar/line charts) */
function reorderColumns(result: QueryResult, xCol?: string, yCol?: string): QueryResult {
  const cols = result.columns;
  const ordered: string[] = [];
  if (xCol && cols.includes(xCol)) ordered.push(xCol);
  if (yCol && cols.includes(yCol)) ordered.push(yCol);
  for (const c of cols) {
    if (!ordered.includes(c)) ordered.push(c);
  }
  if (ordered.join(',') === cols.join(',')) return result;
  return {
    ...result,
    columns: ordered,
    rows: result.rows.map((row) => {
      const reordered: Record<string, unknown> = {};
      for (const c of ordered) reordered[c] = row[c];
      return reordered;
    }),
  };
}
