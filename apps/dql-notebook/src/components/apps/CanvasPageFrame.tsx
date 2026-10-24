import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { annotateCanvasHtml, checkCanvasHtml, escapeHtml, fillCanvasHtml } from '@zlens/core/apps/canvas-page';
import type { StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import type { DashboardCanvasV1, DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import type { CellChartConfig, QueryResult } from '../../store/types';
import type { ThemeMode } from '../../themes/notebook-theme';
import { mountLiveChart, renderOptionToSvg, type MarkPointer } from '../output/echarts/EChartsChart';
import { buildVizOption, ECHARTS_CHART_TYPES } from '../output/echarts/viz-option';
import { isDarkThemeMode } from '../output/chart-palettes';
import type { ChartType } from '../output/chart-helpers';
import { encodedTileResult, mergeDashboardTileChartConfig, normalizeDashboardChartType } from './dashboard-chart-config';
import { formatDriverNumber } from './driver-probe';
import { readerTileTrust } from './reader-trust';
import { NumberReceiptPopover, type NumberReceiptInfo } from './NumberReceipt';
import { CONDITIONAL_TONE_LABELS, conditionalCell, conditionalStats, type ConditionalTone, type DashboardConditionalFormat } from '@zlens/core/apps/conditional-format';
import { formatDisplayValue } from '../../utils/value-format';
import { pivotLayout } from '@zlens/core/apps/pivot';
import { encodingFromQuery } from '@zlens/core/apps/viz-encoding';
import { pivotHtml } from './PivotTable';
import { kpiHtml, usesKpiCard } from './KpiCard';

type LayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];

/**
 * Editing a Custom layout in Studio. Every element carries its source path,
 * the host attaches its own listeners to the frame (the page itself still
 * runs no scripts), and the frame holds still while the author types.
 */
export interface CanvasFrameEditing {
  onFrameLoad: (frame: HTMLIFrameElement, remeasure: () => void) => void;
  /** Keep the current frame while the author is typing in it. */
  frozen: boolean;
  /** Bumped to throw away unsaved typing and redraw from the saved layout. */
  revision: number;
  /** Drawn over the frame: the selected piece's toolbar. */
  overlay?: ReactNode;
}

/**
 * A governed HTML page (RFC 0008 step 9). The page's own markup runs in a
 * sandboxed frame with no scripts and a CSP that allows no network, so it
 * can only lay out what ZLens filled in: escaped values for <dql-value> and
 * DQL-drawn tiles for <dql-tile>. The trust frame is drawn here, outside the
 * frame, where the page's markup cannot reach it.
 */
export function CanvasPageFrame({
  canvas,
  catalog,
  items,
  tiles,
  themeMode,
  trust,
  loading = false,
  editing,
  onMark,
  receiptFor,
}: {
  canvas: DashboardCanvasV1;
  catalog: StoryBindingCatalog;
  items: LayoutItem[];
  tiles: RunTile[];
  themeMode: ThemeMode;
  /** e.g. "all 7 tiles certified". */
  trust?: string | null;
  loading?: boolean;
  editing?: CanvasFrameEditing;
  /** A reader clicked a mark in a live chart: open the click menu (RFC 0009 step 6a). Pointer is in window pixels. */
  onMark?: (item: LayoutItem, tile: RunTile | undefined, row: Record<string, unknown>, pointer: MarkPointer | undefined) => void;
  /** Each bound number explains itself on hover, focus or tap (RFC 0009 step 6a). */
  receiptFor?: (key: string) => NumberReceiptInfo | null;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(960);
  const [height, setHeight] = useState(480);
  useEffect(() => {
    const node = hostRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.floor(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Re-check on every render: a page file is trusted only after the checker says so.
  const checked = useMemo(() => checkCanvasHtml(canvas.html), [canvas.html]);
  const annotate = Boolean(editing);
  const frozenDoc = useRef('');
  const srcDoc = useMemo(() => {
    if (editing?.frozen && frozenDoc.current) return frozenDoc.current;
    if (checked.issues.length) return '';
    // Charts are drawn at a panel-friendly width and only ever shrink to
    // fit: a page lays tiles out in columns the host cannot measure.
    const chartWidth = Math.min(Math.max(360, width - 40), 640);
    const filled = fillCanvasHtml(annotate ? annotateCanvasHtml(checked.html) : checked.html, catalog, (tileId, tileHeight) => drawCanvasTile(items.find((item) => item.i === tileId), tiles.find((tile) => tile.tileId === tileId), catalog, themeMode, chartWidth, tileHeight));
    // A revision change must redraw even when the markup is the same.
    const doc = canvasDocument(filled, themeVariables(hostRef.current), isDarkThemeMode(themeMode)) + (editing ? `<!--${editing.revision}-->` : '');
    frozenDoc.current = doc;
    return doc;
  }, [catalog, checked, items, themeMode, tiles, width, annotate, editing?.frozen, editing?.revision]);
  const measure = () => {
    const doc = frameRef.current?.contentDocument;
    if (doc?.documentElement) setHeight(Math.max(200, Math.ceil(doc.documentElement.scrollHeight) + 2));
  };
  // Charts in the frame are drawn live by the host, so they have tooltips and
  // clicks; the static SVG stays for exports and until the frame loads.
  const liveCharts = useRef<Array<() => void>>([]);
  const onMarkRef = useRef(onMark);
  onMarkRef.current = onMark;
  useEffect(() => () => { liveCharts.current.forEach((dispose) => dispose()); liveCharts.current = []; }, []);
  const mountCharts = () => {
    liveCharts.current.forEach((dispose) => dispose());
    liveCharts.current = [];
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;
    for (const box of Array.from(doc.querySelectorAll<HTMLElement>('.dql-tile[data-tile]'))) {
      const tileId = box.getAttribute('data-tile') ?? '';
      const item = items.find((candidate) => candidate.i === tileId);
      const tile = tiles.find((candidate) => candidate.tileId === tileId);
      const svg = box.querySelector('svg');
      const built = item && tile ? canvasTileChart(item, tile, themeMode) : null;
      if (!svg || !built) continue;
      const height = Number(svg.getAttribute('height')) || 280;
      const host = doc.createElement('div');
      host.className = 'dql-tile-live';
      host.style.cssText = `width:100%;height:${height}px`;
      svg.replaceWith(host);
      liveCharts.current.push(mountLiveChart(host, built, editing ? undefined : (row, pointer) => {
        const rect = frame.getBoundingClientRect();
        onMarkRef.current?.(item!, tile, row, pointer ? { x: rect.left + pointer.x, y: rect.top + pointer.y } : undefined);
      }));
    }
  };
  // Numbers in the page explain themselves. The frame runs no scripts, so
  // the host listens and draws the receipt above the page.
  const [receipt, setReceipt] = useState<{ info: NumberReceiptInfo; at: { left: number; top: number; bottom: number }; pinned: boolean } | null>(null);
  const receiptForRef = useRef(receiptFor);
  receiptForRef.current = receiptFor;
  const receiptTimer = useRef<number | null>(null);
  const holdReceipt = () => { if (receiptTimer.current !== null) window.clearTimeout(receiptTimer.current); receiptTimer.current = null; };
  const dropReceipt = () => { holdReceipt(); receiptTimer.current = window.setTimeout(() => setReceipt((current) => (current?.pinned ? current : null)), 160); };
  useEffect(() => holdReceipt, []);
  const wireNumbers = () => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc || editing || !receiptForRef.current) return;
    const open = (chip: HTMLElement, pinned: boolean) => {
      const info = receiptForRef.current?.(chip.getAttribute('data-bind') ?? '');
      if (!info) return;
      holdReceipt();
      const frameBox = frame.getBoundingClientRect();
      const box = chip.getBoundingClientRect();
      setReceipt((current) => ({ info, at: { left: frameBox.left + box.left, top: frameBox.top + box.top, bottom: frameBox.top + box.bottom }, pinned: pinned || Boolean(current?.pinned && current.info.label === info.label) }));
    };
    for (const chip of Array.from(doc.querySelectorAll<HTMLElement>('.dql-value[data-bind]'))) {
      chip.tabIndex = 0;
      chip.setAttribute('role', 'button');
      chip.style.cursor = 'help';
      chip.style.textDecoration = 'underline dotted';
      chip.style.textUnderlineOffset = '3px';
      chip.addEventListener('pointerenter', () => open(chip, false));
      chip.addEventListener('focus', () => open(chip, false));
      chip.addEventListener('pointerleave', dropReceipt);
      chip.addEventListener('blur', dropReceipt);
      chip.addEventListener('click', () => open(chip, true));
      chip.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(chip, true); } if (event.key === 'Escape') setReceipt(null); });
    }
    doc.addEventListener('mousedown', (event) => { if (!(event.target as Element | null)?.closest?.('.dql-value')) setReceipt(null); });
  };
  const loaded = () => {
    measure();
    mountCharts();
    wireNumbers();
    if (editing && frameRef.current) editing.onFrameLoad(frameRef.current, measure);
  };
  const values = checked.bindings.length;
  const tileCount = checked.tiles.length;
  return (
    <div className="dql-canvas-page" ref={hostRef}>
      <style>{CANVAS_FRAME_STYLES}</style>
      <header className="dql-canvas-trust" aria-label="About this page">
        <span className="dql-canvas-badge"><ShieldCheck size={13} aria-hidden="true" /> Custom layout</span>
        <span>{values} {values === 1 ? 'value' : 'values'} and {tileCount} {tileCount === 1 ? 'tile' : 'tiles'} from this page’s results{trust ? ` · ${trust}` : ''}</span>
        <span className="dql-canvas-note">{canvas.generatedBy === 'ai' ? `Designed by ${canvas.model ?? 'AI'} · ` : ''}checked: no scripts, no network, every figure bound</span>
      </header>
      {checked.issues.length ? (
        <p className="dql-canvas-error" role="alert">This page's layout did not pass ZLens's safety check, so it is not shown: {checked.issues[0]!.message}</p>
      ) : loading && tiles.length === 0 ? (
        <div className="dql-canvas-loading" role="status" aria-busy="true"><span className="visually-hidden">Loading the page's data…</span></div>
      ) : (
        <div className="dql-canvas-stage">
        <iframe
          ref={frameRef}
          title="Page layout"
          // No scripts, no forms, no popups, no top navigation. Same origin
          // only so the host can read the height; with scripts off nothing in
          // the frame can use it.
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          onLoad={loaded}
          style={{ width: '100%', height, border: 0, display: 'block', background: 'transparent' }}
        />
        {editing?.overlay}
        </div>
      )}
      {receipt ? <NumberReceiptPopover info={receipt.info} at={receipt.at} onClose={() => setReceipt(null)} onPointerEnter={holdReceipt} onPointerLeave={dropReceipt} /> : null}
    </div>
  );
}

/** The frame's document: a CSP that allows only inline styles and data images, and the host's theme. */
function canvasDocument(body: string, variables: string, dark = false): string {
  // The frame's colour scheme matches the host's: a light scheme inside a dark
  // page is painted white behind the page's light text (RFC 0009 evaluation).
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${dark ? 'dark' : 'light'}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'"><style>:root{${variables};color-scheme:${dark ? 'dark' : 'light'}}html,body{margin:0;background:transparent}body{padding:4px;font:400 15px/1.55 var(--dql-font);color:var(--dql-ink);font-variant-numeric:tabular-nums}.dql-value{font-weight:600}.dql-value.missing{color:var(--dql-muted)}.dql-tile{margin:8px 0;padding:12px;border:1px solid var(--dql-line);border-radius:12px;background:var(--dql-surface);overflow:hidden}.dql-tile svg{display:block;width:100%;max-width:640px;height:auto}.dql-tile-live svg{max-width:none;width:100%;height:100%}.dql-tile-title{margin:0 0 8px;font-size:13px;font-weight:600}.dql-tile-kpi{font:600 32px/1.2 var(--dql-font-display)}.dql-kpi-change{margin:4px 0;font-size:12px;font-weight:600}.dql-kpi-change.up{color:var(--trust-governed,#3659c9)}.dql-kpi-change.down{color:var(--status-warning,#b26b1f)}.dql-kpi-target{margin:4px 0 0;font-size:12px}.dql-kpi-target.met strong{color:var(--status-success,#0b7a75)}.dql-kpi-target.missed strong{color:var(--status-warning,#b26b1f)}.dql-tile table{width:100%;border-collapse:collapse;font-size:13px}.dql-tile th,.dql-tile td{padding:4px 8px;border-bottom:1px solid var(--dql-line);text-align:left}.dql-tile td.num{text-align:right}.dql-tile .dql-pivot th{text-align:left;font-weight:600}.dql-tile .dql-pivot th.num{text-align:right}.dql-tile .dql-pivot tr.subtotal td,.dql-tile .dql-pivot tr.total td{font-weight:600}.dql-cf-tone{font-weight:600}.dql-cf-tone.good{color:var(--status-success,#0b7a75)}.dql-cf-tone.warning{color:var(--status-warning,#b26b1f)}.dql-cf-tone.bad{color:var(--status-error,#c14545)}.dql-tile .muted{color:var(--dql-muted);font-size:12px}.dql-tile ol{margin:6px 0 0;padding-left:18px}</style></head><body>${body}</body></html>`;
}

function themeVariables(node: HTMLElement | null): string {
  const read = (name: string, fallback: string) => {
    if (!node || typeof getComputedStyle === 'undefined') return fallback;
    const value = getComputedStyle(node).getPropertyValue(name).trim();
    return value || fallback;
  };
  const vars: Array<[string, string]> = [
    ['--dql-ink', read('--dql-app-ink', read('--text-primary', '#1a1a1a'))],
    ['--dql-muted', read('--dql-app-muted', read('--text-secondary', '#4a4a52'))],
    ['--dql-line', read('--dql-app-line', read('--border-subtle', '#e9e6e0'))],
    ['--dql-surface', read('--dql-app-surface', read('--bg-2', '#ffffff'))],
    ['--dql-accent', read('--dql-app-accent', read('--accent', '#0b7a75'))],
    ['--dql-accent-soft', read('--dql-app-accent-soft', read('--accent-dim', 'rgba(11,122,117,0.1)'))],
    ['--dql-font', read('--font-ui', "Inter, system-ui, sans-serif")],
    ['--dql-font-display', "ui-serif, Georgia, 'Times New Roman', serif"],
  ];
  // Values come from the host's own stylesheet; strip anything that could end the declaration.
  return vars.map(([name, value]) => `${name}:${value.replace(/[;{}<>]/g, '')}`).join(';');
}

/** A tile drawn by DQL as static markup: a chart as SVG, a KPI, a table or a driver summary. */
export function drawCanvasTile(item: LayoutItem | undefined, tile: RunTile | undefined, catalog: StoryBindingCatalog, themeMode: ThemeMode, width: number, height?: number): string {
  const title = item?.title ? `<p class="dql-tile-title">${escapeHtml(item.title)}</p>` : '';
  if (!item || !tile) return `${title}<p class="muted">This tile has no result in this run.</p>`;
  if (tile.status !== 'ok') return `${title}<p class="muted">${escapeHtml(tile.error ?? 'This tile could not run.')}</p>`;
  if (tile.driver) {
    const top = tile.driver.dimensions[0];
    return `${title}<p>${escapeHtml(tile.driver.summary)}</p>${top ? `<ol>${top.members.slice(0, 5).map((member) => `<li>${escapeHtml(member.label)}: ${escapeHtml(formatDriverNumber(member.delta, true))}</li>`).join('')}</ol>` : ''}`;
  }
  const result = encodedTileResult(item as never, tile.result as QueryResult | undefined);
  if (!result || result.rows.length === 0) return `${title}<p class="muted">No rows.</p>`;
  const chartType = normalizeDashboardChartType(item.viz.type) as ChartType;
  if (chartType === 'kpi' && item.query && usesKpiCard(item.query, item.viz.style)) {
    const html = kpiHtml(result, item.query, item.viz.style, item.title ?? 'This KPI');
    if (html) return `${title}${html}`;
  }
  if (chartType === 'kpi' || (result.rows.length === 1 && result.columns.length <= 2)) {
    const binding = Object.values(catalog).find((entry) => entry.tileId === item.i && entry.kind === 'number');
    return `${title}<div class="dql-tile-kpi">${escapeHtml(binding?.display ?? '—')}</div>`;
  }
  if (item.viz.type === 'pivot' && item.query && !item.query.detail) {
    return `${title}${pivotHtml(result, pivotLayout(item.viz.encoding ?? encodingFromQuery(item.query, 'pivot'), item.query), item.viz.style?.conditional)}`;
  }
  const built = canvasTileChart(item, tile, themeMode);
  if (built) return `${title}${renderOptionToSvg(built, Math.max(280, width), height ?? 280)}`;
  return `${title}${staticTableHtml(result, item.viz.style?.conditional)}`;
}

const TONE_MARKS: Record<ConditionalTone, string> = { good: '✓', warning: '!', bad: '✕', neutral: '•' };

/**
 * A table as static markup, formatted as the live table formats it (names,
 * units, conditional formats). A rule's state is a mark with its name, never
 * colour alone.
 */
export function staticTableHtml(result: QueryResult, conditionalFormats?: DashboardConditionalFormat[], limit = 15): string {
  const columns = result.columns.slice(0, 8);
  const meta = (column: string) => result.columnsMeta?.find((entry) => entry.name === column);
  const numeric = new Set(columns.filter((column) => result.rows.every((row) => row[column] === null || typeof row[column] === 'number')));
  const values = new Map(columns.map((column) => [column, result.rows.map((row) => row[column])]));
  const formats = new Map((conditionalFormats ?? []).filter((format) => columns.includes(format.column)).map((format) => [format.column, { format, stats: conditionalStats(values.get(format.column) ?? []) }]));
  const cell = (row: Record<string, unknown>, column: string) => {
    const value = row[column];
    const text = value === null || value === undefined ? '—' : formatDisplayValue(column, value, values.get(column) ?? [], { meta: meta(column) });
    const rule = formats.get(column);
    const look = rule ? conditionalCell(rule.format, value, rule.stats) : undefined;
    const style = [
      look?.background ? `background:${look.background}` : '',
      look?.bar ? `background-image:linear-gradient(90deg, ${look.bar.color} ${look.bar.width}%, transparent ${look.bar.width}%)` : '',
    ].filter(Boolean).join(';');
    const mark = look?.tone ? `<span class="dql-cf-tone ${look.tone}" title="${escapeHtml(CONDITIONAL_TONE_LABELS[look.tone])}" aria-label="${escapeHtml(CONDITIONAL_TONE_LABELS[look.tone])}">${TONE_MARKS[look.tone]}</span> ` : '';
    return `<td${numeric.has(column) ? ' class="num"' : ''}${style ? ` style="${escapeHtml(style)}"` : ''}>${mark}${escapeHtml(text)}</td>`;
  };
  const head = columns.map((column) => `<th>${escapeHtml(meta(column)?.label ?? column.replace(/_/g, ' '))}</th>`).join('');
  const body = result.rows.slice(0, limit).map((row) => `<tr>${columns.map((column) => cell(row, column)).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${result.rows.length > limit ? `<p class="muted">${escapeHtml(`First ${limit} of ${result.rows.length} rows`)}</p>` : ''}`;
}

/** The chart a tile draws on a Custom layout, or null for a KPI, table, driver or empty result. */
export function canvasTileChart(item: LayoutItem, tile: RunTile, themeMode: ThemeMode) {
  if (tile.status !== 'ok' || tile.driver) return null;
  const result = encodedTileResult(item as never, tile.result as QueryResult | undefined);
  if (!result || result.rows.length === 0) return null;
  const chartType = normalizeDashboardChartType(item.viz.type) as ChartType;
  if (chartType === 'kpi' || (result.rows.length === 1 && result.columns.length <= 2) || !ECHARTS_CHART_TYPES.has(chartType)) return null;
  const config = mergeDashboardTileChartConfig(item as never, tile.chartConfig as CellChartConfig | undefined);
  const trust = readerTileTrust(item as never, tile);
  return buildVizOption({ chartType, result, themeMode, config: { ...config, ...(item.viz.style ? { style: item.viz.style } : {}), ...(trust ? { tooltipFooter: trust.label } : {}) } as CellChartConfig, animate: false }) ?? null;
}

const CANVAS_FRAME_STYLES = `
.dql-canvas-page { display: grid; gap: 10px; }
.dql-canvas-trust { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 12px; border: 1px solid var(--dql-app-line, var(--border-subtle)); border-radius: 8px; background: var(--dql-app-surface, var(--bg-2)); color: var(--dql-app-muted, var(--text-secondary)); font: 400 12px/1.4 var(--font-ui, inherit); }
.dql-canvas-badge { display: inline-flex; align-items: center; gap: 5px; color: var(--dql-app-ink, var(--text-primary)); font-weight: 600; }
.dql-canvas-badge svg { color: var(--trust-certified, #0b7a75); }
.dql-canvas-note { margin-left: auto; }
.dql-canvas-error { margin: 0; padding: 12px; border: 1px solid var(--status-error-border, rgba(193,69,69,.3)); border-radius: 8px; color: var(--status-error, #c14545); font-size: 13px; }
.dql-canvas-stage { position: relative; }
.dql-canvas-loading { height: 320px; border-radius: 12px; background: var(--dql-app-control, var(--bg-0)); }
`;
