import React, { useMemo, useState } from 'react';
import type { QueryResult, CellChartConfig } from '../../store/types';
import type { Theme, ThemeMode } from '../../themes/notebook-theme';
import { ChartOutput, CHART_TYPE_OPTIONS, isMeasureColumn } from './ChartOutput';
import { TableOutput } from './TableOutput';

const CHART_X_DATE_RE = /date|time|day|month|year|week|quarter|period|_at$|^at$/i;
const TECHNICAL_IDENTIFIER_RE = /(?:^|_)(?:id|uuid|key|code)$/i;
const BUSINESS_LABEL_RE = /(?:name|title|label|display|description|customer|account|product|region|segment|category|channel)$/i;
const CHART_TYPES = new Set([
  'bar', 'grouped-bar', 'stacked-bar', 'line', 'area', 'scatter', 'pie', 'donut',
  'heatmap', 'histogram', 'funnel', 'sankey', 'waterfall', 'gauge', 'kpi', 'table',
]);

function isChartNumericCell(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim() !== '' && Number.isFinite(Number(value));
  return false;
}

/**
 * Columns this result may plot as VALUES. The recommender and the renderer must
 * agree, or the chart draws points while its own Y selector says player_id: the
 * result's contract (`columnsMeta`) decides first, and sampled values only
 * where a result carries no contract.
 */
function numericResultColumns(result: QueryResult): string[] {
  const sample = result.rows.slice(0, 20);
  if (sample.length === 0) return [];
  return result.columns.filter((column) =>
    isMeasureColumn(result, column)
    && sample.some((row) => isChartNumericCell(row[column]))
    && sample.every((row) => {
      const value = row[column];
      return value === null || value === undefined || value === '' || isChartNumericCell(value);
    }),
  );
}

/** Prefer a human-readable dimension over a neighbouring technical identifier. */
function preferredCategoryColumn(result: QueryResult, numeric: string[]): string {
  const dimensions = result.columns.filter((column) => !numeric.includes(column));
  return dimensions.find((column) => BUSINESS_LABEL_RE.test(column) && !TECHNICAL_IDENTIFIER_RE.test(column))
    ?? dimensions.find((column) => !TECHNICAL_IDENTIFIER_RE.test(column))
    ?? dimensions[0]
    ?? result.columns[0];
}

/** Hide an ID only when the result also has a clearly corresponding business label. */
function technicalColumnsWithLabels(result: QueryResult): string[] {
  return result.columns.filter((column) => {
    if (!TECHNICAL_IDENTIFIER_RE.test(column)) return false;
    const stem = column.replace(/(?:_)?(?:id|uuid|key|code)$/i, '').replace(/_+$/, '');
    return result.columns.some((candidate) => candidate !== column && (
      (stem.length > 0 && candidate.toLowerCase().startsWith(stem.toLowerCase()) && BUSINESS_LABEL_RE.test(candidate))
      || (stem.length === 0 && BUSINESS_LABEL_RE.test(candidate))
    ));
  });
}

function businessResult(result: QueryResult, hiddenColumns: string[]): QueryResult {
  if (hiddenColumns.length === 0) return result;
  const hidden = new Set(hiddenColumns);
  return {
    ...result,
    columns: result.columns.filter((column) => !hidden.has(column)),
    rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !hidden.has(column)))),
  };
}

export interface SmartChartRecommendation {
  config: CellChartConfig;
  chartable: boolean;
  reason: string;
}

/**
 * Choose a safe visualization from the returned shape. An LLM's `viz` is a
 * preference, not a blind command: it wins only when the actual rows can support
 * it. Authored DQL and an explicit user choice remain authoritative.
 */
export function deriveResultChartConfig(result: QueryResult, base?: CellChartConfig): SmartChartRecommendation {
  const numeric = numericResultColumns(result);
  const hasRows = result.rows.length > 0;
  const nonNumeric = result.columns.filter((column) => !numeric.includes(column));
  const chartable = hasRows && numeric.length >= 1;
  if (!chartable) return { config: { ...(base ?? {}), chart: 'table', decisionSource: 'data', rationale: 'The returned rows do not contain a numeric measure to plot.' }, chartable: false, reason: 'No numeric measure' };
  const category = preferredCategoryColumn(result, numeric);
  const x = base?.x && result.columns.includes(base.x) ? base.x : category;
  const y = base?.y && result.columns.includes(base.y) ? base.y : (numeric.find((column) => column !== x) ?? numeric[0]);
  const automatic = automaticChartType(result, numeric, nonNumeric, x);
  const preferred = normalizeChartType(base?.chart);
  const source = base?.decisionSource;
  const preserve = source === 'authored' || source === 'user';
  const chart = preserve && preferred
    ? preferred
    : preferred && chartCanRepresent(preferred, result, numeric, nonNumeric, x, y)
      ? preferred
      : automatic.chart;
  const wasOverridden = Boolean(preferred && preferred !== chart && !preserve);
  const color = base?.color && result.columns.includes(base.color)
    ? base.color
    : chart === 'sankey'
      ? nonNumeric.find((column) => column !== x)
      : base?.color;
  const reason = wasOverridden
    ? `${automatic.reason}; replaced the agent suggestion because the returned data is not compatible.`
    : preferred && !preserve
      ? 'Agent-selected visualization validated against the returned data.'
      : automatic.reason;
  return {
    config: {
      ...(base ?? {}),
      chart,
      x,
      y,
      ...(color ? { color } : {}),
      decisionSource: preserve ? source : preferred && !wasOverridden ? 'agent' : 'data',
      rationale: reason,
    },
    chartable: chart !== 'table',
    reason,
  };
}

function normalizeChartType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase().replace(/_/g, '-').replace('single-value', 'kpi');
  return CHART_TYPES.has(normalized) ? normalized : undefined;
}

function automaticChartType(
  result: QueryResult,
  numeric: string[],
  nonNumeric: string[],
  x: string,
): { chart: string; reason: string } {
  if (result.rows.length === 1 && numeric.length >= 1) return { chart: 'kpi', reason: 'Single returned value' };
  if (CHART_X_DATE_RE.test(x) && numeric.length >= 1) return { chart: 'line', reason: `Time-like field ${x}` };
  if (nonNumeric.length > 0 && numeric.length >= 2) return { chart: 'grouped-bar', reason: 'One category with multiple numeric measures' };
  if (nonNumeric.length > 0 && numeric.length === 1) return { chart: 'bar', reason: 'Categorical comparison with one numeric measure' };
  if (numeric.length >= 2) return { chart: 'scatter', reason: 'Two continuous numeric measures' };
  return { chart: 'table', reason: 'No comparable category or time axis was returned' };
}

function chartCanRepresent(
  chart: string,
  result: QueryResult,
  numeric: string[],
  nonNumeric: string[],
  x: string,
  y: string,
): boolean {
  if (chart === 'table') return true;
  if (chart === 'kpi' || chart === 'gauge') return numeric.length >= 1 && result.rows.length === 1;
  if (chart === 'line' || chart === 'area') return numeric.includes(y) && CHART_X_DATE_RE.test(x);
  if (chart === 'scatter') return numeric.length >= 2;
  if (chart === 'sankey') return nonNumeric.length >= 2 && numeric.length >= 1;
  if (chart === 'histogram') return numeric.length >= 1;
  if (chart === 'grouped-bar' || chart === 'stacked-bar') return nonNumeric.length >= 1 && numeric.length >= 2;
  if (chart === 'pie' || chart === 'donut') return nonNumeric.length >= 1 && numeric.length >= 1 && result.rows.length >= 2 && result.rows.length <= 8;
  if (chart === 'heatmap') return result.columns.length >= 3 && numeric.length >= 1;
  if (chart === 'funnel' || chart === 'waterfall') return nonNumeric.length >= 1 && numeric.length >= 1;
  // A time axis has an unambiguous ordering; an automatic bar suggestion masks
  // that relationship. A user can still deliberately choose bars afterwards.
  if (chart === 'bar') return nonNumeric.length >= 1 && numeric.length >= 1 && !CHART_X_DATE_RE.test(x);
  return false;
}

/**
 * Notebook-cell-style result view: a chart/table toggle + manual chart-type picker
 * over any QueryResult. Shared by Ask AI (UnifiedAgentRunPanel) and notebook query
 * cells so both render governed results identically.
 */
export interface ResultViewProps {
  result: QueryResult;
  themeMode: ThemeMode;
  t: Theme;
  chartConfig?: CellChartConfig;
  /** Removes the outer shell when Ask AI supplies the titled result card. */
  embedded?: boolean;
  tabLabels?: { chart: string; table: string };
  contentMaxHeight?: React.CSSProperties['maxHeight'];
  tableMaxHeight?: React.CSSProperties['maxHeight'];
}

export function ResultView({
  result,
  themeMode,
  t,
  chartConfig,
  embedded = false,
  tabLabels,
  contentMaxHeight,
  tableMaxHeight,
}: ResultViewProps) {
  const isEmpty = result.rows.length === 0;
  // User overrides from the chart-type picker / settings gear (type / X / Y / palette …).
  const [override, setOverride] = useState<CellChartConfig | undefined>();
  const [showTechnicalFields, setShowTechnicalFields] = useState(false);
  const base = useMemo<CellChartConfig>(() => ({ ...(chartConfig ?? {}), ...(override ?? {}) }), [chartConfig, override]);
  const { config: effectiveChart, chartable } = deriveResultChartConfig(result, base);
  const numericColumns = useMemo(() => numericResultColumns(result), [result]);
  const hiddenTechnicalColumns = useMemo(() => technicalColumnsWithLabels(result), [result]);
  const tableResult = useMemo(
    () => showTechnicalFields ? result : businessResult(result, hiddenTechnicalColumns),
    [hiddenTechnicalColumns, result, showTechnicalFields],
  );
  // Results open as a scannable table even when a chart recommendation exists.
  // The visualization remains one click away and keeps the authored/agent chart
  // configuration; this changes presentation preference, not analytical intent.
  const [view, setView] = useState<'chart' | 'table'>('table');
  const tabStyle = (active: boolean): React.CSSProperties => ({
    border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: t.font,
    fontSize: 11, fontWeight: 700, padding: '2px 4px', color: active ? t.accent : t.textMuted,
    borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
  });
  // Reflect the active chart type in the picker; fall back to bar if the resolved
  // type isn't one of the standard options.
  const currentChartType = CHART_TYPE_OPTIONS.some((option) => option.value === effectiveChart.chart)
    ? effectiveChart.chart
    : 'bar';
  return (
    <div style={{ border: embedded ? 'none' : `1px solid ${t.headerBorder}`, background: t.cellBg, borderRadius: embedded ? 0 : 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: embedded ? '9px 14px' : '5px 9px', borderBottom: `1px solid ${t.headerBorder}` }}>
        {/* Chart tab shows whenever the data can be plotted; the picker + gear let
            the user pick the chart type and axes manually. */}
        {chartable && <button type="button" onClick={() => setView('table')} style={tabStyle(view === 'table')}>{tabLabels?.table ?? 'Table'}</button>}
        {chartable && <button type="button" onClick={() => setView('chart')} style={tabStyle(view === 'chart')}>{tabLabels?.chart ?? 'Chart'}</button>}
        {!chartable && !isEmpty && <span style={{ fontSize: 11, fontWeight: 700, color: t.textMuted }}>{tabLabels?.table ?? 'Table'}</span>}
        {chartable && view === 'chart' ? (
          <select
            value={currentChartType}
            onChange={(event) => setOverride((prev) => ({ ...(prev ?? {}), chart: event.target.value, decisionSource: 'user', rationale: 'Selected manually.' }))}
            title="Chart type"
            style={{
              fontFamily: t.font, fontSize: 11, fontWeight: 600, color: t.textSecondary,
              background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 5,
              padding: '1px 4px', cursor: 'pointer',
            }}
          >
            {CHART_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : null}
        {chartable && view === 'chart' ? (
          <>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: t.textMuted, fontSize: 11 }}>
              X
              <select
                aria-label="X-axis field"
                value={effectiveChart.x ?? ''}
                onChange={(event) => setOverride((prev) => ({ ...(prev ?? {}), x: event.target.value, decisionSource: 'user', rationale: 'Axis selected manually.' }))}
                style={{ fontFamily: t.font, fontSize: 11, color: t.textSecondary, background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 5, padding: '1px 3px', cursor: 'pointer', maxWidth: 120 }}
              >
                {result.columns.map((column) => <option key={column} value={column}>{column}</option>)}
              </select>
            </label>
            {numericColumns.length > 0 ? (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: t.textMuted, fontSize: 11 }}>
                Y
                <select
                  aria-label="Y-axis field"
                  value={effectiveChart.y ?? ''}
                  onChange={(event) => setOverride((prev) => ({ ...(prev ?? {}), y: event.target.value, decisionSource: 'user', rationale: 'Axis selected manually.' }))}
                  style={{ fontFamily: t.font, fontSize: 11, color: t.textSecondary, background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 5, padding: '1px 3px', cursor: 'pointer', maxWidth: 120 }}
                >
                  {numericColumns.map((column) => <option key={column} value={column}>{column}</option>)}
                </select>
              </label>
            ) : null}
            {effectiveChart.chart === 'sankey' ? (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: t.textMuted, fontSize: 11 }}>
                Target
                <select
                  aria-label="Sankey target field"
                  value={effectiveChart.color ?? ''}
                  onChange={(event) => setOverride((prev) => ({ ...(prev ?? {}), color: event.target.value, decisionSource: 'user', rationale: 'Sankey target selected manually.' }))}
                  style={{ fontFamily: t.font, fontSize: 11, color: t.textSecondary, background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 5, padding: '1px 3px', cursor: 'pointer', maxWidth: 120 }}
                >
                  {result.columns.filter((column) => !numericColumns.includes(column) && column !== effectiveChart.x).map((column) => <option key={column} value={column}>{column}</option>)}
                </select>
              </label>
            ) : null}
          </>
        ) : null}
        {chartable && view === 'chart' && effectiveChart.rationale ? (
          <span title={effectiveChart.rationale} style={{ fontSize: 11, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 230 }}>
            Smart chart · {effectiveChart.chart}
          </span>
        ) : null}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: t.textMuted, alignSelf: 'center' }}>{(() => { const count = result.rowCount ?? result.rows.length; return `${count.toLocaleString('en-US')} ${count === 1 ? 'row' : 'rows'}`; })()}</span>
      </div>
      <div style={{ padding: embedded ? 12 : 8, minHeight: chartable && view === 'chart' ? 200 : undefined, maxHeight: contentMaxHeight ?? (embedded ? 380 : 320), overflow: 'auto' }}>
        {isEmpty
          ? <div style={{ padding: '18px 8px', textAlign: 'center', color: t.textMuted, fontSize: 12 }}>
              The query ran successfully and matched 0 rows{result.columns.length > 0 ? ` (columns: ${result.columns.join(', ')})` : ''}.
            </div>
          : chartable && view === 'chart'
            ? <ChartOutput
                result={result}
                themeMode={themeMode}
                chartConfig={effectiveChart}
                onConfigChange={(updates) => setOverride((prev) => ({ ...(prev ?? {}), ...updates, decisionSource: 'user', rationale: 'Adjusted manually.' }))}
              />
            : <>
                {hiddenTechnicalColumns.length > 0 ? (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                    <button type="button" onClick={() => setShowTechnicalFields((value) => !value)} style={{ border: 'none', background: 'transparent', color: t.accent, cursor: 'pointer', fontSize: 11, padding: 0 }}>
                      {showTechnicalFields ? 'Hide technical fields' : 'Show IDs'}
                    </button>
                  </div>
                ) : null}
                <TableOutput result={tableResult} themeMode={themeMode} maxHeight={tableMaxHeight} readableHeaders />
              </>}
      </div>
    </div>
  );
}
