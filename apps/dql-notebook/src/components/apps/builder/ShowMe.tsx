import { useId, useState } from 'react';
import {
  AreaChart,
  BarChart2,
  BarChart3,
  BarChartHorizontal,
  ChartBarStacked,
  Donut,
  Filter,
  Gauge,
  Grid3x3,
  LineChart,
  PieChart,
  ScatterChart,
  Table2,
  TableProperties,
} from 'lucide-react';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import { chartFromEncoding, outputAlias, type DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';
import {
  SHOW_ME_CHARTS,
  showMe,
  showMeFactsFromDescriptor,
  showMeInputFromEncoding,
  type ShowMeChart,
  type ShowMeSuggestion,
} from '@zlens/core/apps/show-me';
import type { QueryResult } from '../../../store/types';
import { shelfFieldLabel } from './field-labels';

const ICONS: Record<ShowMeChart, typeof Gauge> = {
  kpi: Gauge,
  line: LineChart,
  area: AreaChart,
  bar: BarChartHorizontal,
  column: BarChart3,
  grouped_bar: BarChart2,
  stacked_bar: ChartBarStacked,
  donut: Donut,
  pie: PieChart,
  funnel: Filter,
  scatter: ScatterChart,
  heatmap: Grid3x3,
  table: Table2,
  pivot: TableProperties,
};

/**
 * Show Me for a Dataset tile: every chart ranked for the fields on its
 * shelves. The Dataset contract says which dimensions are dates, which
 * measures add up and their units; the tile's last result, when there is
 * one, says how many values each dimension has and whether a measure goes
 * negative.
 */
export function tileShowMe(
  descriptor: DatasetDescriptor,
  encoding: DashboardVizEncoding,
  query: TileQuery,
  result?: QueryResult,
): ShowMeSuggestion[] {
  const column = (ref: { dimension: string } | { measure: string }) => {
    const name = outputAlias(query, ref);
    return name && result?.columns.includes(name) ? name : undefined;
  };
  const facts = showMeFactsFromDescriptor(descriptor, {
    cardinality: (dimension) => {
      const name = column({ dimension });
      if (!name || !result) return undefined;
      const loaded = new Set(result.rows.map((row) => String(row[name] ?? ''))).size;
      // A tile grouped by this field alone has one row per value: the result
      // counts all of them (930), the rows hold only the first (500).
      const counted = query.dimensions.length === 1 && loaded === result.rows.length && typeof result.rowCount === 'number' ? result.rowCount : 0;
      return Math.max(loaded, counted);
    },
    nonNegative: (measure) => {
      const name = column({ measure });
      if (!name || !result) return undefined;
      const values = result.rows.map((row) => Number(row[name])).filter((value) => Number.isFinite(value));
      return values.length ? values.every((value) => value >= 0) : undefined;
    },
  }, query);
  const input = showMeInputFromEncoding(encoding, facts);
  const label = (kind: 'dimension' | 'measure', name: string) => shelfFieldLabel(encoding, query, kind === 'measure' ? { measure: name } : { dimension: name });
  return showMe({
    dimensions: input.dimensions.map((field) => ({ ...field, label: label('dimension', field.name) })),
    measures: input.measures.map((field) => ({ ...field, label: label('measure', field.name) })),
    ...(query.detail ? { rowDetail: true } : {}),
    ...(query.comparison ? { comparison: true } : {}),
  });
}

/** The Show Me chart a tile draws as now: its chart type, read with its shelves. */
export function currentShowMeChart(visualization: string | undefined, encoding: DashboardVizEncoding, isTime: (field: string) => boolean): ShowMeChart | undefined {
  const type = (visualization ?? '').toLowerCase().replace(/-/g, '_');
  const drawn = chartFromEncoding(encoding, isTime);
  if (type === 'single_value' || type === 'kpi') return 'kpi';
  if (type === 'pivot') return 'pivot';
  if (type === 'table' || drawn.kind === 'table') return 'table';
  if (type === 'bar') return drawn.kind === 'cartesian' && drawn.orientation === 'vertical' ? 'column' : 'bar';
  return (SHOW_ME_CHARTS as readonly string[]).includes(type) ? type as ShowMeChart : undefined;
}

/**
 * The ranked charts as a picker. The best one is marked; charts that do not
 * fit stay visible, greyed out, and say why when hovered or focused.
 */
export function ShowMePanel({
  suggestions,
  current,
  disabled,
  onPick,
}: {
  suggestions: ShowMeSuggestion[];
  current?: ShowMeChart;
  disabled: boolean;
  onPick: (suggestion: ShowMeSuggestion) => void;
}): JSX.Element {
  const [pointed, setPointed] = useState<ShowMeChart | null>(null);
  const reasonId = useId();
  const shown = suggestions.find((entry) => entry.chart === pointed)
    ?? suggestions.find((entry) => entry.chart === current)
    ?? suggestions.find((entry) => entry.recommended);
  // The chart drawn now no longer fits these fields (e.g. more than eight
  // series): say so, and offer the best one, instead of a quietly incomplete chart.
  const currentFit = suggestions.find((entry) => entry.chart === current);
  const best = suggestions.find((entry) => entry.recommended);
  const misfit = currentFit && !currentFit.available && best && best.chart !== current ? { currentFit, best } : null;
  return (
    <section className="show-me" aria-label="Show Me">
      <span className="show-me-title">Show Me</span>
      {misfit ? (
        <div className="show-me-misfit" role="status">
          <p><strong>{misfit.currentFit.label} no longer fits.</strong> {misfit.currentFit.reason}</p>
          <button type="button" disabled={disabled} onClick={() => onPick(misfit.best)}>Use {misfit.best.label}</button>
        </div>
      ) : null}
      <div className="show-me-grid" role="radiogroup" aria-label="Chart type" onMouseLeave={() => setPointed(null)}>
        {suggestions.map((suggestion) => {
          const Icon = ICONS[suggestion.chart];
          const on = suggestion.chart === current;
          return (
            <button
              key={suggestion.chart}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={!suggestion.available || disabled}
              aria-describedby={`${reasonId}-${suggestion.chart}`}
              className={[on && 'on', !suggestion.available && 'unfit', suggestion.recommended && 'best'].filter(Boolean).join(' ') || undefined}
              title={suggestion.reason}
              onMouseEnter={() => setPointed(suggestion.chart)}
              onFocus={() => setPointed(suggestion.chart)}
              onBlur={() => setPointed(null)}
              onClick={() => { if (suggestion.available && !disabled && !on) onPick(suggestion); }}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{suggestion.label}</span>
              {suggestion.recommended ? <b className="show-me-best">Best</b> : null}
            </button>
          );
        })}
      </div>
      {/* Each chart carries its own reason, so keyboard focus announces the right one. */}
      <div className="visually-hidden">
        {suggestions.map((suggestion) => <span key={suggestion.chart} id={`${reasonId}-${suggestion.chart}`}>{suggestion.available ? suggestion.reason : `Does not fit: ${suggestion.reason}`}</span>)}
      </div>
      {shown ? (
        <p id={reasonId} className={`show-me-reason ${shown.available ? '' : 'unfit'}`.trim()} aria-hidden="true">
          <strong>{shown.label}{shown.available ? '' : ' does not fit'}</strong>
          {' '}{shown.reason}
        </p>
      ) : null}
    </section>
  );
}
