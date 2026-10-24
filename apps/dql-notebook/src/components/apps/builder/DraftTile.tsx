import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import {
  datasetMeasureField,
  datasetPhysicalField,
} from '@zlens/core/datasets/descriptor';
import {
  datasetTileVisualizationCompatibility,
  tileQueryValidationRuns,
  validateTileQuery,
  type TileQuery,
} from '@zlens/core/apps/tile-query';
import { api, type DatasetTileQueryPreview } from '../../../api/client';
import type { CellChartConfig, QueryResult, ResultColumnMeta } from '../../../store/types';
import type { ThemeMode } from '../../../themes/notebook-theme';
import { ChartOutput } from '../../output/ChartOutput';
import { TableOutput } from '../../output/TableOutput';
import { TileQueryEditor } from './TileQueryEditor';
import { autoTileView, defaultTileTitle, descriptorTimeField, tileVisualization, vizTypeForEncoding, type TileView } from './field-query';
import { ShelfEditor, type ShelfChange } from './ShelfEditor';
import type { DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';
import { encodedChartConfig, encodedTileResult } from '../dashboard-chart-config';
import { humanize } from './studio-ui';
import { checkTileCalculations } from '@zlens/core/apps/tile-calcs';
import { pivotLayout, withPivotRollups } from '@zlens/core/apps/pivot';
import { encodingFromQuery } from '@zlens/core/apps/viz-encoding';
import { PivotTable } from '../PivotTable';
import { KpiCard, usesKpiCard } from '../KpiCard';
import { BarCapNote } from './BarCapNote';
import { barCategoryCap, sortTouched, withBarCategoryLimit, withDefaultBarSort } from './sort-top-n';

export type DraftTileState = {
  /** Catalog item id of the Dataset the tile is built from. */
  sourceKey: string;
  query: TileQuery;
  /** The shelves the tile is built on (RFC 0009); the query follows them. */
  encoding: DashboardVizEncoding;
  view: TileView;
  /** True once the author picks a view; field picks stop changing it. */
  viewChosen: boolean;
  /** The chart type picked in Show Me; kept while the shelves still read that way. */
  chart?: string;
  title: string;
  /** True once the author sets a sort or Top N; the bar default stops applying. */
  sortChosen?: boolean;
};

/**
 * The draft after a change, with a new bar chart sorted by its measure,
 * highest first, until the author chooses a sort or Top N themselves.
 */
export function withDraftSortDefault(descriptor: DatasetDescriptor, previous: DraftTileState | null, next: DraftTileState): DraftTileState {
  const sortChosen = Boolean(next.sortChosen || previous?.sortChosen || (previous && sortTouched(previous.query, next.query)));
  if (sortChosen) return { ...next, sortChosen: true };
  const query = withDefaultBarSort(next.query, draftVisualization(descriptor, next));
  return query === next.query ? next : { ...next, query };
}

/** The chart type a draft is added as: its view, drawn the way its shelves read. */
export function draftVisualization(descriptor: DatasetDescriptor, draft: DraftTileState): string {
  if (draft.view !== 'chart') return tileVisualization(draft.query, draft.view);
  const type = vizTypeForEncoding(draft.encoding, descriptorTimeField(descriptor), draft.chart);
  return type === 'single_value' || type === 'table' ? tileVisualization(draft.query, 'chart') : type;
}

type PreviewState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ready'; result: QueryResult; ms: number; reviewJoin?: boolean; key: string }
  | { state: 'failed'; message: string };

/**
 * Units for the preview columns, from the Dataset contract: the added tile
 * formats a ratio as a percent and revenue as money, so the draft must too.
 */
export function draftColumnsMeta(descriptor: DatasetDescriptor, query: TileQuery, columns: string[]): ResultColumnMeta[] {
  const meta: ResultColumnMeta[] = [];
  for (const measure of query.measures) {
    const name = measure.alias ?? measure.measure;
    const field = datasetMeasureField(descriptor, measure.measure);
    if (!field || !columns.includes(name)) continue;
    const kind = field.format?.kind ?? (field.aggregation === 'ratio' ? 'percent' : field.aggregation.startsWith('count') ? 'count' : 'number');
    meta.push({ name, kind, ...(field.format?.currency ? { unit: field.format.currency } : {}), ...(field.format?.decimals !== undefined ? { decimals: field.format.decimals } : {}) });
  }
  for (const dimension of query.dimensions) {
    const related = descriptor.fields.find((candidate) => candidate.kind === 'physical' && candidate.related && candidate.name.toLowerCase() === dimension.field.toLowerCase());
    if (!dimension.timeGrain) {
      // A related table's field reads as words ("Location Name"), never its joined name (design D2).
      const name = dimension.alias ?? dimension.field;
      if (related && columns.includes(name)) meta.push({ name, kind: 'text', label: humanize(related.name) });
      continue;
    }
    const name = dimension.alias ?? columns.find((column) => column === `${dimension.field}_${dimension.timeGrain}`) ?? dimension.field;
    if (columns.includes(name)) meta.push({ name, kind: 'date', grain: dimension.timeGrain, ...(related ? { label: humanize(related.name) } : {}) });
  }
  // Calculations carry their own format and name, as the page run gives them.
  for (const output of checkTileCalculations(descriptor, query).outputs) {
    if (!columns.includes(output.id)) continue;
    meta.push({
      name: output.id,
      kind: output.format.kind,
      label: output.label,
      ...(output.format.kind === 'percent' ? { unit: 'fraction' } : output.format.currency ? { unit: output.format.currency } : {}),
      ...(output.format.decimals !== undefined ? { decimals: output.format.decimals } : {}),
    });
  }
  return meta;
}

/** Why the draft cannot be added yet, or undefined when it can. */
export function draftTileBlocker(descriptor: DatasetDescriptor, draft: DraftTileState): string | undefined {
  if (!draft.query.measures.length && !draft.query.detail && !draft.query.calculations?.some((calculation) => calculation.expr)) return 'Pick at least one measure.';
  const validation = validateTileQuery(descriptor, draft.query);
  if (!tileQueryValidationRuns(validation)) return validation.diagnostics[0]?.message ?? 'This field combination is not covered by the data.';
  const compatibility = datasetTileVisualizationCompatibility(draft.query, draftVisualization(descriptor, draft));
  return compatibility.compatible ? undefined : compatibility.message;
}

/**
 * Runs one Dataset field query through the governed Dataset runtime (the
 * ephemeral /api/app-datasets/run path) and draws it as the tile will look.
 * Edits are debounced and a newer query cancels the older request. Nothing
 * here is App evidence — applying or adding a tile runs a real page preview.
 */
export function DatasetQueryPreview({
  sourceId,
  descriptor,
  query,
  visualization,
  themeMode,
  runnable = true,
  height = 260,
  onStatus,
  encoding,
  onResult,
}: {
  sourceId?: string;
  descriptor?: DatasetDescriptor;
  query: TileQuery;
  visualization: string;
  themeMode: ThemeMode;
  runnable?: boolean;
  height?: number;
  onStatus?: (status: string, tone: 'ok' | 'error' | 'idle') => void;
  /** Shelves to draw the preview with, as the added tile will be drawn. */
  encoding?: DashboardVizEncoding;
  /** The settled result, or undefined while none matches the query. */
  onResult?: (result: QueryResult | undefined) => void;
}): JSX.Element {
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });
  const [barShowAll, setBarShowAll] = useState(false);
  const latest = useRef(0);
  // A pivot previews with its totals, as the added tile will run.
  const runQuery = visualization === 'pivot' && !query.detail
    ? withPivotRollups((({ limit: _limit, ...rest }) => rest)(query), encoding ?? encodingFromQuery(query, 'pivot'), undefined)
    : query;
  const key = JSON.stringify(runQuery);
  useEffect(() => {
    if (!sourceId || !runnable) {
      setPreview({ state: 'idle' });
      return;
    }
    const ticket = ++latest.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPreview({ state: 'running' });
      const started = performance.now();
      void api.previewDatasetTileQuery({ sourceId, query: runQuery }, controller.signal).then((response: DatasetTileQueryPreview) => {
        if (ticket !== latest.current) return;
        if (!response.ok) {
          setPreview({ state: 'failed', message: response.error || 'This field query did not return a result.' });
          return;
        }
        const rows = response.result?.rows ?? [];
        const named = (response.result?.columns ?? []).map((column) => typeof column === 'string' ? column : String((column as { name?: string }).name ?? column));
        const columns = named.length ? named : Object.keys(rows[0] ?? {});
        setPreview({
          state: 'ready',
          key,
          ms: Math.round(performance.now() - started),
          reviewJoin: Boolean(response.joins?.some((join) => join.trust !== 'certified')),
          result: { columns, rows, rowCount: response.result?.rowCount ?? rows.length, ...(descriptor ? { columnsMeta: draftColumnsMeta(descriptor, runQuery, columns) } : {}) },
        });
      }).catch(() => {
        // Superseded by a newer edit.
      });
    // Short: a field click is one action, not typing (round 3: clicks felt a second late).
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [sourceId, key, runnable]);
  // A result for an earlier query is never drawn as this one (round 3): a KPI's
  // single total drawn as a line read "1 row" with its total on the x-axis
  // until the new run came back. Until the result matches, it is running.
  const current: PreviewState = preview.state === 'ready' && preview.key !== key ? { state: 'running' } : preview;
  useEffect(() => {
    if (!onStatus) return;
    if (current.state === 'ready') {
      const count = current.result.rowCount ?? current.result.rows.length;
      // A join nobody certified yet (drafted in setup) keeps the tile Not certified yet (design D2).
      onStatus(`Live · ${count} ${count === 1 ? 'row' : 'rows'} · ${current.ms} ms${current.reviewJoin ? ' · Not certified yet: it uses a join nobody has certified' : ''}`, 'ok');
    } else if (current.state === 'running') onStatus('Running…', 'idle');
    else if (current.state === 'failed') onStatus('Run failed', 'error');
  }, [current.state, current.state === 'ready' ? current.key : '', preview]);
  useEffect(() => {
    onResult?.(current.state === 'ready' ? current.result : undefined);
  }, [current.state, current.state === 'ready' ? current.key : '', preview]);
  if (current.state === 'failed') return <div className="draft-empty warn"><strong>This query did not run</strong><span>{current.message}</span></div>;
  if (current.state !== 'ready') return <div className="draft-empty loading"><span>{sourceId && runnable ? 'Running against live data…' : 'Runs when applied'}</span></div>;
  const shelved = { query, viz: { type: visualization, ...(encoding ? { encoding } : {}) } };
  const shown = encodedTileResult(shelved, current.result);
  if (visualization === 'pivot' && !query.detail) return <PivotTable result={shown} layout={pivotLayout(encoding ?? encodingFromQuery(query, 'pivot'), query)} themeMode={themeMode} maxHeight={height + 20} />;
  if (visualization === 'table' || visualization === 'pivot') return <TableOutput result={shown} themeMode={themeMode} maxHeight={height + 20} initialPageSize={10} />;
  if ((visualization === 'single_value' || visualization === 'kpi') && usesKpiCard(query, undefined)) return <KpiCard result={shown} query={query} label="This KPI" />;
  const chartConfig = { ...encodedChartConfig(shelved), chart: visualization === 'single_value' || visualization === 'kpi' ? 'kpi' : visualization.replace(/_/g, '-') } as CellChartConfig;
  // Above 50 categories a bar chart draws the top 25, as the added tile will.
  const barCap = barCategoryCap(shown, { chart: visualization, category: chartConfig.x, value: chartConfig.y, query, showAll: barShowAll });
  if (!barCap.cappable) return <ChartOutput result={shown} themeMode={themeMode} chartConfig={withBarCategoryLimit(chartConfig, barCap)} availableHeight={height} />;
  return <>
    <BarCapNote cap={barCap} showAll={barShowAll} onShowAll={setBarShowAll} />
    <ChartOutput result={barCap.result} themeMode={themeMode} chartConfig={withBarCategoryLimit(chartConfig, barCap)} availableHeight={Math.max(96, height - 24)} />
  </>;
}

/** The new tile on the canvas, drawn live as fields are picked. */
export function DraftTileCard({
  sourceId,
  descriptor,
  draft,
  themeMode,
  onResult,
}: {
  sourceId?: string;
  descriptor: DatasetDescriptor;
  draft: DraftTileState;
  themeMode: ThemeMode;
  onResult?: (result: QueryResult | undefined) => void;
}): JSX.Element {
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'error' | 'idle' }>({ text: 'Starting…', tone: 'idle' });
  const blocker = draftTileBlocker(descriptor, draft);
  const visualization = draftVisualization(descriptor, draft);
  const title = draft.title.trim() || defaultTileTitle(draft.query, humanize);
  const shownStatus = blocker ? (draft.query.measures.length ? 'Not runnable yet' : 'Waiting for a value') : status.text;
  return <article className="studio-component-card draft-tile" aria-label={`New tile: ${title}`} style={{ '--studio-tile-width': 12 } as React.CSSProperties}>
    <header>
      <span className="draft-badge">NEW TILE</span>
      <strong>{title}</strong>
      <span className={`draft-status ${!blocker ? status.tone : ''}`} aria-live="polite">{shownStatus}</span>
    </header>
    <div className="draft-body">
      {!draft.query.measures.length && !draft.query.detail
        ? <div className="draft-empty"><Plus size={20} /><strong>Pick a measure to start</strong><span>Click a measure in the Data panel. The tile runs as soon as it has one value.</span></div>
        : blocker
          ? <div className="draft-empty warn"><strong>Not runnable yet</strong><span>{blocker}</span></div>
          : <DatasetQueryPreview sourceId={sourceId} descriptor={descriptor} query={draft.query} visualization={visualization} encoding={draft.encoding} themeMode={themeMode} onStatus={(text, tone) => setStatus({ text, tone })} onResult={onResult} />}
    </div>
  </article>;
}

/** Right-column settings for the tile being built. */
export function DraftTileInspector({
  descriptor,
  datasetLabel,
  draft,
  disabled,
  onChange,
  onCancel,
  onAdd,
  result,
}: {
  descriptor: DatasetDescriptor;
  datasetLabel: string;
  draft: DraftTileState;
  disabled: boolean;
  onChange: (next: DraftTileState) => void;
  onCancel: () => void;
  onAdd: () => void;
  /** The draft's live preview result, for Show Me. */
  result?: QueryResult;
}): JSX.Element {
  const blocker = draftTileBlocker(descriptor, draft);
  const [moreOpen, setMoreOpen] = useState(false);
  const [filterField, setFilterField] = useState<string | undefined>();
  const isTime = descriptorTimeField(descriptor);
  const views: Array<[TileView, string]> = [['kpi', 'KPI'], ['chart', 'Chart'], ['table', 'Table']];
  const changeShelves = ({ encoding, query, visualization }: ShelfChange): string | void => {
    if (visualization) {
      // A Show Me pick: KPI and Table are views; any other chart is kept by name.
      const view: TileView = visualization === 'single_value' ? 'kpi' : visualization === 'table' ? 'table' : 'chart';
      const { chart: _chart, ...rest } = draft;
      onChange({ ...rest, encoding, query, view, viewChosen: true, ...(view === 'chart' ? { chart: visualization } : {}) });
      return;
    }
    const keepView = draft.viewChosen && datasetTileVisualizationCompatibility(query, draftVisualization(descriptor, { ...draft, encoding, query })).compatible;
    onChange({ ...draft, encoding, query, view: keepView ? draft.view : autoTileView(query, encoding, isTime), viewChosen: keepView });
  };
  return <div className="inspector-body draft-inspector">
    <section className="inspector-title"><label htmlFor="draft-tile-title">Title</label><input id="draft-tile-title" value={draft.title} placeholder={defaultTileTitle(draft.query, humanize)} onChange={(event) => onChange({ ...draft, title: event.target.value })} /></section>
    <section><label>Data</label><div className="static-field">{datasetLabel}</div></section>
    {draft.query.detail ? null : <section>
      <ShelfEditor descriptor={descriptor} encoding={draft.encoding} query={draft.query} disabled={disabled} onChange={changeShelves} onFilterField={(field) => { setFilterField(field); setMoreOpen(true); }} visualization={draftVisualization(descriptor, draft)} result={result} />
      <small className="field-help">Drag fields from the Data panel onto a shelf, or click one to add it.</small>
    </section>}
    {/* Show Me under the shelves picks the chart; row details have no shelves, only these views. */}
    {draft.query.detail ? <section><label>Show as</label><div className="segmented" role="radiogroup" aria-label="Show as">
      {views.map(([view, label]) => {
        const compatible = datasetTileVisualizationCompatibility(draft.query, tileVisualization(draft.query, view)).compatible;
        return <button key={view} type="button" role="radio" aria-checked={draft.view === view} className={draft.view === view ? 'on' : ''} disabled={!compatible} title={compatible ? undefined : 'These fields cannot show this way'} onClick={() => onChange({ ...draft, view, viewChosen: true })}>{label}</button>;
      })}
    </div>{!draft.viewChosen ? <small className="field-help">Chosen from the fields. Pick one to keep it.</small> : null}</section> : null}
    <details className="draft-more" open={moreOpen} onToggle={(event) => setMoreOpen((event.target as HTMLDetailsElement).open)}>
      <summary>Filters, sort and more</summary>
      <TileQueryEditor descriptor={descriptor} query={draft.query} disabled={disabled} onChange={(query) => onChange({ ...draft, query, ...(query.detail ? {} : {}) })} idPrefix="draft-tile" shelves={!draft.query.detail} filterField={filterField} />
    </details>
    {blocker && draft.query.measures.length ? <small className="dataset-builder-error" role="alert">{blocker}</small> : null}
    <footer className="inspector-footer">
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      <button type="button" className="primary" disabled={disabled || Boolean(blocker)} onClick={onAdd}>Add to page</button>
    </footer>
  </div>;
}
