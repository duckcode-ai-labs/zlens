import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, Hash, MoreHorizontal, Plus, SquareFunction, Type, X } from 'lucide-react';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import {
  SHELF_LABELS,
  chartFromEncoding,
  fieldKey,
  isMeasureRef,
  placeOnShelf,
  queryFromEncoding,
  refName,
  removeField,
  removeFromShelf,
  shelfAccepts,
  shelfContents,
  type DashboardVizEncoding,
  type FieldFormatKind,
  type ShelfFieldRef,
  type ShelfId,
} from '@zlens/core/apps/viz-encoding';
import { applyShowMe } from '@zlens/core/apps/show-me';
import {
  QUICK_CALC_KINDS,
  QUICK_CALC_LABELS,
  checkTileCalculations,
  formatTileCalcExpr,
  measureCalcFacts,
  quickCalcVerdict,
  uniqueCalculationId,
  type TileCalculation,
  type TileQuickCalcKind,
} from '@zlens/core/apps/tile-calcs';
import { CalculationEditor } from './CalculationEditor';
import { shelfFieldLabel } from './field-labels';
import type { QueryResult } from '../../../store/types';
import { descriptorTimeField, descriptorTimeGrain, isTimeField } from './field-query';
import { ShowMePanel, currentShowMeChart, tileShowMe } from './ShowMe';
import { humanize } from './studio-ui';
import { TOP_N_CHOICES, canShowTopN, topNFor, withSort, withTopN } from './sort-top-n';

/** The drag payload a field carries between the Data pane and the shelves. */
export const FIELD_DRAG_TYPE = 'application/x-dql-field';

export function writeFieldDrag(event: DragEvent, ref: ShelfFieldRef, from?: ShelfId): void {
  event.dataTransfer.setData(FIELD_DRAG_TYPE, JSON.stringify({ ref, ...(from ? { from } : {}) }));
  event.dataTransfer.setData('text/plain', refName(ref));
  event.dataTransfer.effectAllowed = 'move';
}

function readFieldDrag(event: DragEvent): { ref: ShelfFieldRef; from?: ShelfId } | null {
  try {
    const raw = event.dataTransfer.getData(FIELD_DRAG_TYPE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ref?: ShelfFieldRef; from?: ShelfId };
    return parsed.ref && ('measure' in parsed.ref || 'dimension' in parsed.ref) ? { ref: parsed.ref, ...(parsed.from ? { from: parsed.from } : {}) } : null;
  } catch {
    return null;
  }
}

const AXES: ShelfId[] = ['columns', 'rows'];
const MARKS: ShelfId[] = ['color', 'size', 'label', 'tooltip', 'detail'];
const SHELF_HINTS: Record<ShelfId, string> = {
  columns: 'Across',
  rows: 'Down',
  color: 'Split into series',
  size: 'Bubble size',
  label: 'Show values',
  tooltip: 'Add to tooltip',
  detail: 'More detail',
};
const FORMATS: Array<[FieldFormatKind | 'auto', string]> = [['auto', 'Automatic'], ['number', 'Number'], ['compact', 'Compact (1.2K)'], ['currency', 'Currency'], ['percent', 'Percent']];

export interface ShelfChange {
  encoding: DashboardVizEncoding;
  query: TileQuery;
  /** The chart type picked in Show Me. Absent when a field moved: the caller reads the type off the shelves. */
  visualization?: string;
}

/** One sentence on what the shelves draw, for the author. */
export function describeEncodedChart(encoding: DashboardVizEncoding, isTime: (field: string) => boolean, visualization?: string): string {
  const chart = chartFromEncoding(encoding, isTime);
  if (chart.kind === 'kpi') return 'Shows one number.';
  if (chart.kind === 'table') return chart.reason;
  if (chart.kind === 'scatter') return `A scatter of ${humanize(chart.y)} against ${humanize(chart.x)}.`;
  if (chart.kind === 'heatmap') return `A heatmap of ${humanize(chart.value)} by ${humanize(chart.x)} and ${humanize(chart.y)}.`;
  // The stored chart type decides the marks; the shelves decide the axis.
  const type = (visualization ?? '').replace(/-/g, '_');
  if (type === 'table') return 'A table of every value.';
  if (type === 'pivot') {
    const across = encoding.columns.filter((ref) => !isMeasureRef(ref)).map((ref) => humanize(refName(ref)));
    const down = encoding.rows.filter((ref) => !isMeasureRef(ref)).map((ref) => humanize(refName(ref)));
    return `A pivot: ${down.length ? down.join(' › ') : 'one row'} down the side${across.length ? `, ${across.join(' › ')} across` : ''}, with totals recomputed from the rows.`;
  }
  if (type === 'pie' || type === 'donut' || type === 'funnel') return `A ${type} of ${humanize(chart.measures[0] ?? '')} by ${humanize(chart.category)}.`;
  const bars = type === 'bar' || type === 'grouped_bar' || type === 'stacked_bar';
  const marks = type === 'stacked_bar' ? 'Stacked bars' : type === 'grouped_bar' ? 'Side-by-side bars' : chart.orientation === 'horizontal' ? 'Horizontal bars' : 'Bars';
  const shape = type === 'area' ? 'An area over' : chart.line && !bars ? 'A line over' : `${marks} ${isTime(chart.category) ? 'over' : 'by'}`;
  const series = encoding.color && !isMeasureRef(encoding.color) ? `, split by ${humanize(refName(encoding.color))}` : chart.measures.length > 1 ? `, ${chart.measures.length} series` : '';
  return `${shape} ${humanize(chart.category)}${series}.`;
}

/**
 * Shelves for a Dataset tile (RFC 0009 step 1): Columns and Rows for the
 * axes, and the marks shelves Colour, Size, Label, Tooltip and Detail. Fields
 * arrive by drag and drop from the Data pane or by click, move between
 * shelves by drag or from their menu, and every change produces a query the
 * caller validates against the Dataset contract before saving.
 */
export function ShelfEditor({
  descriptor,
  encoding,
  query,
  disabled,
  onChange,
  onFilterField,
  visualization,
  result,
}: {
  descriptor: DatasetDescriptor;
  encoding: DashboardVizEncoding;
  query: TileQuery;
  disabled: boolean;
  /** The tile's chart type. Given, Show Me ranks the charts under the shelves. */
  visualization?: string;
  /** The tile's last result: how many values each dimension has, for Show Me. */
  result?: QueryResult;
  /** Returns a refusal message when the change is not allowed. */
  onChange: (change: ShelfChange) => string | void;
  onFilterField?: (field: string) => void;
}): JSX.Element {
  const [menu, setMenu] = useState<{ shelf: ShelfId; ref: ShelfFieldRef } | null>(null);
  const [over, setOver] = useState<ShelfId | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [calcEditor, setCalcEditor] = useState<{ editing?: TileCalculation } | null>(null);
  const isTime = descriptorTimeField(descriptor);
  const timeGrainFor = descriptorTimeGrain(descriptor);
  const contents = shelfContents(encoding);
  useEffect(() => setRefusal(null), [JSON.stringify(encoding)]);

  const apply = (next: DashboardVizEncoding, nextQuery?: TileQuery, nextVisualization?: string): string | null => {
    const message = onChange({ encoding: next, query: nextQuery ?? queryFromEncoding(next, query, timeGrainFor), ...(nextVisualization ? { visualization: nextVisualization } : {}) });
    setRefusal(message || null);
    return message || null;
  };
  const calculationFor = (ref: ShelfFieldRef) => (isMeasureRef(ref) ? query.calculations?.find((calculation) => calculation.id.toLowerCase() === ref.measure.toLowerCase()) : undefined);
  const saveCalculation = (calculation: TileCalculation) => {
    const exists = query.calculations?.some((entry) => entry.id === calculation.id);
    const calculations = exists
      ? (query.calculations ?? []).map((entry) => (entry.id === calculation.id ? calculation : entry))
      : [...(query.calculations ?? []), calculation];
    // A new calculation joins the measures' axis; editing one keeps it where it is.
    const measureShelf: ShelfId = encoding.columns.some(isMeasureRef) && !encoding.rows.some(isMeasureRef) ? 'columns' : 'rows';
    const next = exists ? encoding : placeOnShelf(encoding, measureShelf, { measure: calculation.id });
    if (!apply(next, queryFromEncoding(next, { ...query, calculations }, timeGrainFor))) setCalcEditor(null);
  };
  const formulas = (query.calculations ?? []).filter((calculation) => calculation.expr);
  const dropOn = (shelf: ShelfId, event: DragEvent) => {
    event.preventDefault();
    setOver(null);
    const payload = readFieldDrag(event);
    if (!payload || disabled) return;
    if (!shelfAccepts(shelf, payload.ref)) {
      setRefusal(`${SHELF_LABELS[shelf]} takes ${shelf === 'detail' ? 'a dimension' : 'a measure'}.`);
      return;
    }
    // Moving from Label, Tooltip or Size takes it off that shelf; from the
    // Data pane or an axis, placeOnShelf moves it.
    const base = payload.from && ['size', 'label', 'tooltip'].includes(payload.from) && payload.from !== shelf
      ? removeFromShelf(encoding, payload.from, payload.ref)
      : encoding;
    apply(placeOnShelf(base, shelf, payload.ref));
  };

  const fieldLabel = (ref: ShelfFieldRef): string => shelfFieldLabel(encoding, query, ref);
  const grainOf = (ref: ShelfFieldRef) => (isMeasureRef(ref) ? undefined : query.dimensions.find((dimension) => dimension.field.toLowerCase() === ref.dimension.toLowerCase())?.timeGrain);

  const renderShelf = (shelf: ShelfId, compact = false) => {
    const refs = contents[shelf];
    return (
      <div
        key={shelf}
        className={`shelf ${compact ? 'mark' : 'axis'} ${over === shelf ? 'over' : ''}`}
        onDragOver={(event) => { if (!disabled && event.dataTransfer.types.includes(FIELD_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(shelf); } }}
        onDragLeave={() => setOver((current) => (current === shelf ? null : current))}
        onDrop={(event) => dropOn(shelf, event)}
      >
        <span className="shelf-name" title={SHELF_HINTS[shelf]}>{SHELF_LABELS[shelf]}</span>
        <ul className="shelf-pills" aria-label={`${SHELF_LABELS[shelf]} shelf`}>
          {refs.map((ref) => {
            const measure = isMeasureRef(ref);
            const grain = grainOf(ref);
            const time = !measure && isTime(refName(ref));
            const calculation = calculationFor(ref);
            return (
              <li
                key={fieldKey(ref)}
                className={`shelf-pill ${measure ? 'measure' : 'dimension'}${calculation ? ' calc' : ''}`}
                draggable={!disabled}
                onDragStart={(event) => writeFieldDrag(event, ref, shelf)}
                title={calculation?.expr ? formatTileCalcExpr(calculation.expr) : undefined}
              >
                {calculation ? <SquareFunction size={11} aria-label="Calculation" /> : measure ? <Hash size={11} aria-hidden="true" /> : time ? <CalendarDays size={11} aria-hidden="true" /> : <Type size={11} aria-hidden="true" />}
                <span className="shelf-pill-name">{fieldLabel(ref)}{grain ? <em> · {humanize(grain)}</em> : null}</span>
                <button type="button" className="shelf-pill-menu" disabled={disabled} aria-haspopup="menu" aria-expanded={menu?.shelf === shelf && fieldKey(menu.ref) === fieldKey(ref)} aria-label={`Options for ${fieldLabel(ref)} on ${SHELF_LABELS[shelf]}`} onClick={() => setMenu((current) => (current?.shelf === shelf && fieldKey(current.ref) === fieldKey(ref) ? null : { shelf, ref }))}>
                  <MoreHorizontal size={12} />
                </button>
                <button type="button" className="shelf-pill-remove" disabled={disabled} aria-label={`Remove ${fieldLabel(ref)} from ${SHELF_LABELS[shelf]}`} onClick={() => apply(removeFromShelf(encoding, shelf, ref))}>
                  <X size={11} />
                </button>
                {menu?.shelf === shelf && fieldKey(menu.ref) === fieldKey(ref) ? (
                  <FieldMenu
                    descriptor={descriptor}
                    encoding={encoding}
                    query={query}
                    shelf={shelf}
                    fieldRef={ref}
                    label={fieldLabel(ref)}
                    onClose={() => setMenu(null)}
                    onEncoding={(next, nextQuery) => { setMenu(null); apply(next, nextQuery); }}
                    onEditFormula={calculation?.expr ? () => { setMenu(null); setCalcEditor({ editing: calculation }); } : undefined}
                    timeGrainFor={timeGrainFor}
                    onFilter={onFilterField ? () => { setMenu(null); onFilterField(refName(ref)); } : undefined}
                  />
                ) : null}
              </li>
            );
          })}
          {!refs.length ? <li className="shelf-empty" aria-hidden="true">{compact ? SHELF_HINTS[shelf] : 'Drop a field here'}</li> : null}
        </ul>
      </div>
    );
  };

  return (
    <section className="shelf-editor" aria-label="Shelves">
      {AXES.map((shelf) => renderShelf(shelf))}
      <div className="shelf-marks" role="group" aria-label="Marks">
        {MARKS.map((shelf) => renderShelf(shelf, true))}
      </div>
      <div className="shelf-calcs" role="group" aria-label="Formulas">
        <span className="shelf-name">Formulas</span>
        <div className="shelf-calc-list">
          {formulas.map((calculation) => (
            <button key={calculation.id} type="button" className="shelf-calc" disabled={disabled} title={formatTileCalcExpr(calculation.expr!)} aria-label={`Edit ${fieldLabel({ measure: calculation.id })}: ${formatTileCalcExpr(calculation.expr!)}`} onClick={() => setCalcEditor({ editing: calculation })}>
              <SquareFunction size={11} aria-hidden="true" /> {fieldLabel({ measure: calculation.id })}
            </button>
          ))}
          <button type="button" className="shelf-calc-add" disabled={disabled} aria-expanded={Boolean(calcEditor && !calcEditor.editing)} onClick={() => setCalcEditor((current) => (current && !current.editing ? null : {}))}>
            <Plus size={11} aria-hidden="true" /> New formula
          </button>
        </div>
      </div>
      {calcEditor ? (
        <CalculationEditor
          key={calcEditor.editing?.id ?? 'new'}
          descriptor={descriptor}
          query={query}
          {...(calcEditor.editing ? { editing: calcEditor.editing } : {})}
          onSave={saveCalculation}
          onCancel={() => setCalcEditor(null)}
        />
      ) : null}
      <p className="shelf-reading" aria-live="polite">{describeEncodedChart(encoding, isTime, visualization)}</p>
      {refusal ? <small className="dataset-builder-error" role="alert">{refusal}</small> : null}
      {visualization !== undefined ? (
        <ShowMePanel
          suggestions={tileShowMe(descriptor, encoding, query, result)}
          current={currentShowMeChart(visualization, encoding, isTime)}
          disabled={disabled}
          onPick={(suggestion) => apply(applyShowMe(encoding, suggestion), undefined, suggestion.viz)}
        />
      ) : null}
    </section>
  );
}

export function FieldMenu({
  descriptor,
  encoding,
  query,
  shelf,
  fieldRef,
  label,
  onClose,
  onEncoding,
  onFilter,
  onEditFormula,
  timeGrainFor,
}: {
  descriptor: DatasetDescriptor;
  encoding: DashboardVizEncoding;
  query: TileQuery;
  shelf: ShelfId;
  fieldRef: ShelfFieldRef;
  label: string;
  onClose: () => void;
  onEncoding: (next: DashboardVizEncoding, nextQuery?: TileQuery) => void;
  onFilter?: () => void;
  onEditFormula?: () => void;
  timeGrainFor: (field: string) => string | undefined;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const key = fieldKey(fieldRef);
  const settings = encoding.fields?.[key] ?? {};
  const [name, setName] = useState(settings.label ?? '');
  const measure = isMeasureRef(fieldRef);
  const field = descriptor.fields.find((candidate) => candidate.name.toLowerCase() === refName(fieldRef).toLowerCase());
  const grains = field && isTimeField(field) ? field.time?.grains ?? [] : [];
  const dimension = measure ? undefined : query.dimensions.find((entry) => entry.field.toLowerCase() === refName(fieldRef).toLowerCase());
  const alias = measure
    ? query.measures.find((entry) => entry.measure.toLowerCase() === refName(fieldRef).toLowerCase())?.alias ?? refName(fieldRef)
    : dimension?.alias ?? (dimension?.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : refName(fieldRef));
  const quick = measure ? quickCalcState(descriptor, query, fieldRef) : null;
  const setQuick = (kind: TileQuickCalcKind | null, window?: number) => {
    if (!quick) return;
    const current = quick.calculation;
    // Back to the measure itself: its pill takes the calculation's place.
    const sourceRef: ShelfFieldRef = { measure: quick.sourceRef };
    if (kind === null) {
      onEncoding(...replaced(sourceRef, current ? (query.calculations ?? []).filter((entry) => entry.id !== current.id) : query.calculations));
      return;
    }
    // The column is named for what it now holds; the pill follows it.
    const others = (query.calculations ?? []).filter((entry) => entry.id !== current?.id);
    const id = current?.quick?.kind === kind ? current.id : uniqueCalculationId({ ...query, calculations: others }, `${quick.sourceAlias}_${kind}`);
    const calculation: TileCalculation = { id, quick: { kind, of: quick.sourceAlias, ...(kind === 'moving_average' && window ? { window } : {}) } };
    const calculations = [...others, calculation];
    onEncoding(...replaced({ measure: id }, calculations));
  };
  const replaced = (to: ShelfFieldRef, calculations: TileCalculation[] | undefined): [DashboardVizEncoding, TileQuery] => {
    // Quick calculations only ever swap one measure pill for another.
    const swap = <T extends ShelfFieldRef>(entry: T): T => (fieldKey(entry) === key ? to as T : entry);
    const next: DashboardVizEncoding = {
      ...encoding,
      columns: encoding.columns.map(swap),
      rows: encoding.rows.map(swap),
      ...(encoding.color ? { color: swap(encoding.color) } : {}),
      ...(encoding.size ? { size: swap(encoding.size) } : {}),
      ...(encoding.label ? { label: encoding.label.map(swap) } : {}),
      ...(encoding.tooltip ? { tooltip: encoding.tooltip.map(swap) } : {}),
    };
    const { calculations: _old, ...rest } = query;
    return [next, queryFromEncoding(next, calculations?.length ? { ...rest, calculations } : rest, timeGrainFor)];
  };
  const sorted = query.orderBy?.[0]?.alias.toLowerCase() === alias.toLowerCase() ? query.orderBy[0]!.direction : null;

  // Keep the menu on screen: a pill near the inspector's right edge opens it leftwards.
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const overflow = box.right - (window.innerWidth - 8);
    if (overflow > 0) setShift(-Math.min(overflow, Math.max(0, box.left - 8)));
  }, []);
  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [onClose]);

  const withSettings = (patch: { label?: string | null; format?: { kind: FieldFormatKind; decimals?: number } | null }): DashboardVizEncoding => {
    const next = { ...settings };
    if (patch.label !== undefined) { if (patch.label) next.label = patch.label; else delete next.label; }
    if (patch.format !== undefined) { if (patch.format) next.format = patch.format; else delete next.format; }
    const fields = { ...(encoding.fields ?? {}) };
    if (Object.keys(next).length) fields[key] = next;
    else delete fields[key];
    const { fields: _old, ...rest } = encoding;
    return Object.keys(fields).length ? { ...rest, fields } : rest;
  };
  const moveTargets = (['columns', 'rows', 'color', 'size', 'label', 'tooltip', 'detail'] as ShelfId[]).filter((target) => target !== shelf && shelfAccepts(target, fieldRef));
  // Sort and Top N write the tile query's orderBy and limit, the same fields
  // "Filters, sort and more" shows, so the two always agree.
  const sortBy = (direction: 'asc' | 'desc' | null) => onEncoding(encoding, withSort(query, alias, direction));
  const topN = measure && canShowTopN(query) ? topNFor(query, alias) : null;
  const showTopN = measure && canShowTopN(query);
  const [customTop, setCustomTop] = useState(topN !== null && !(TOP_N_CHOICES as readonly number[]).includes(topN) ? String(topN) : '');
  const setTopN = (n: number | null) => onEncoding(encoding, withTopN(query, alias, n));

  return (
    <div className="shelf-menu" role="menu" aria-label={`${label} options`} ref={ref} style={shift ? { transform: `translateX(${shift}px)` } : undefined}>
      <div className="shelf-menu-group" role="group" aria-label="Move to">
        <span className="shelf-menu-label">Move to</span>
        <div className="shelf-menu-chips">
          {moveTargets.map((target) => (
            <button key={target} type="button" role="menuitem" onClick={() => {
              const base = ['size', 'label', 'tooltip'].includes(shelf) ? removeFromShelf(encoding, shelf, fieldRef) : encoding;
              onEncoding(placeOnShelf(base, target, fieldRef));
            }}>{SHELF_LABELS[target]}</button>
          ))}
        </div>
      </div>
      {grains.length > 1 && dimension ? (
        <div className="shelf-menu-group" role="group" aria-label="Time grain">
          <span className="shelf-menu-label">Time grain</span>
          <div className="shelf-menu-chips">
            {grains.map((grain) => (
              <button key={grain} type="button" role="menuitemradio" aria-checked={dimension.timeGrain === grain} className={dimension.timeGrain === grain ? 'on' : ''} onClick={() => {
                const dimensions = query.dimensions.map((entry) => (entry === dimension ? { ...entry, timeGrain: grain } : entry));
                onEncoding(encoding, { ...query, dimensions, ...(query.orderBy ? { orderBy: query.orderBy.filter((entry) => entry.alias.toLowerCase() !== alias.toLowerCase()) } : {}) });
              }}>{humanize(grain)}</button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="shelf-menu-group" role="group" aria-label="Sort">
        <span className="shelf-menu-label">Sort</span>
        <div className="shelf-menu-chips">
          <button type="button" role="menuitemradio" aria-checked={sorted === 'asc'} aria-label={`Sort ascending by ${label}`} className={sorted === 'asc' ? 'on' : ''} onClick={() => sortBy('asc')}><ArrowUp size={11} aria-hidden="true" /> Ascending</button>
          <button type="button" role="menuitemradio" aria-checked={sorted === 'desc'} aria-label={`Sort descending by ${label}`} className={sorted === 'desc' ? 'on' : ''} onClick={() => sortBy('desc')}><ArrowDown size={11} aria-hidden="true" /> Descending</button>
          {sorted ? <button type="button" role="menuitem" onClick={() => sortBy(null)}>Clear</button> : null}
        </div>
      </div>
      {showTopN ? (
        <div className="shelf-menu-group" role="group" aria-label="Show top">
          <span className="shelf-menu-label">Show top</span>
          <div className="shelf-menu-chips">
            {TOP_N_CHOICES.map((n) => (
              <button key={n} type="button" role="menuitemradio" aria-checked={topN === n} aria-label={`Show top ${n} by ${label}`} className={topN === n ? 'on' : ''} onClick={() => setTopN(n)}>{n}</button>
            ))}
            <button type="button" role="menuitemradio" aria-checked={topN === null && typeof query.limit !== 'number'} className={topN === null && typeof query.limit !== 'number' ? 'on' : ''} onClick={() => setTopN(null)}>All</button>
          </div>
          <form className="shelf-menu-row" onSubmit={(event) => {
            event.preventDefault();
            const n = Number(customTop);
            if (Number.isInteger(n) && n >= 1 && n <= 10_000) setTopN(n);
          }}>
            <input aria-label="Custom top N" type="number" min={1} max={10000} placeholder="Other number" value={customTop} onChange={(event) => setCustomTop(event.target.value)} />
            <button type="submit" disabled={!customTop}>Show</button>
          </form>
        </div>
      ) : null}
      {quick ? (
        <div className="shelf-menu-group" role="group" aria-label="Quick calculation">
          <span className="shelf-menu-label">Quick calculation</span>
          <div className="shelf-menu-chips">
            {quick.options.map((option) => (
              <button
                key={option.kind}
                type="button"
                role="menuitemradio"
                aria-checked={quick.current === option.kind}
                className={`${quick.current === option.kind ? 'on' : ''}${option.refusal ? ' unfit' : ''}`}
                aria-disabled={Boolean(option.refusal)}
                title={option.refusal ?? QUICK_CALC_LABELS[option.kind]}
                onClick={() => { if (!option.refusal) setQuick(quick.current === option.kind ? null : option.kind); }}
              >{QUICK_CALC_SHORT[option.kind]}</button>
            ))}
            {quick.current ? <button type="button" role="menuitem" onClick={() => setQuick(null)}>None</button> : null}
          </div>
          {quick.current === 'moving_average' ? (
            <div className="shelf-menu-row">
              <label className="shelf-menu-label" htmlFor={`window-${key}`}>Periods</label>
              <select id={`window-${key}`} value={quick.calculation?.quick?.window ?? 3} onChange={(event) => setQuick('moving_average', Number(event.target.value))}>
                {[2, 3, 4, 6, 12].map((periods) => <option key={periods} value={periods}>{periods}</option>)}
              </select>
            </div>
          ) : null}
          {quick.refusalNote ? <small className="shelf-menu-note">{quick.refusalNote}</small> : null}
        </div>
      ) : null}
      {measure ? (
        <div className="shelf-menu-group" role="group" aria-label="Number format">
          <label className="shelf-menu-label" htmlFor={`format-${key}`}>Number format</label>
          <div className="shelf-menu-row">
            <select id={`format-${key}`} value={settings.format?.kind ?? 'auto'} onChange={(event) => {
              const kind = event.target.value as FieldFormatKind | 'auto';
              onEncoding(withSettings({ format: kind === 'auto' ? null : { kind, ...(settings.format?.decimals !== undefined ? { decimals: settings.format.decimals } : {}) } }));
            }}>
              {FORMATS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
            <input aria-label="Decimals" type="number" min={0} max={6} placeholder="Dec." disabled={!settings.format} value={settings.format?.decimals ?? ''} onChange={(event) => {
              if (!settings.format) return;
              const decimals = event.target.value === '' ? undefined : Math.max(0, Math.min(6, Math.round(Number(event.target.value))));
              onEncoding(withSettings({ format: { kind: settings.format.kind, ...(decimals !== undefined ? { decimals } : {}) } }));
            }} />
          </div>
        </div>
      ) : null}
      <form className="shelf-menu-group" onSubmit={(event) => { event.preventDefault(); onEncoding(withSettings({ label: name.trim() || null })); }}>
        <label className="shelf-menu-label" htmlFor={`rename-${key}`}>Name</label>
        <div className="shelf-menu-row">
          <input id={`rename-${key}`} value={name} maxLength={80} placeholder={humanize(refName(fieldRef))} onChange={(event) => setName(event.target.value)} />
          <button type="submit">Save</button>
        </div>
      </form>
      <div className="shelf-menu-actions">
        {onEditFormula ? <button type="button" role="menuitem" onClick={onEditFormula}>Edit formula…</button> : null}
        {onFilter && !measure ? <button type="button" role="menuitem" onClick={onFilter}>Filter…</button> : null}
        <button type="button" role="menuitem" className="danger" onClick={() => onEncoding(removeField(encoding, fieldRef))}>Remove from tile</button>
      </div>
    </div>
  );
}

const QUICK_CALC_SHORT: Record<TileQuickCalcKind, string> = {
  percent_of_total: '% of total',
  running_total: 'Running total',
  difference: 'Difference',
  percent_difference: '% difference',
  rank: 'Rank',
  moving_average: 'Moving average',
  year_over_year: 'Year over year',
};

/**
 * The quick calculations a measure pill offers, each with the rule that rules
 * it out on this tile. A pill that already is a quick calculation offers the
 * same list over its measure, with its own kind selected.
 */
export function quickCalcState(descriptor: DatasetDescriptor, query: TileQuery, ref: ShelfFieldRef): {
  calculation?: TileCalculation;
  current: TileQuickCalcKind | null;
  sourceAlias: string;
  sourceRef: string;
  options: Array<{ kind: TileQuickCalcKind; refusal?: string }>;
  refusalNote?: string;
} | null {
  if (!isMeasureRef(ref)) return null;
  const own = query.calculations?.find((calculation) => calculation.id.toLowerCase() === ref.measure.toLowerCase());
  const sourceAlias = own?.quick ? own.quick.of : own ? own.id : (query.measures.find((entry) => entry.measure.toLowerCase() === ref.measure.toLowerCase())?.alias ?? ref.measure);
  const sourceCalculation = query.calculations?.find((calculation) => calculation.id.toLowerCase() === sourceAlias.toLowerCase());
  const sourceMeasure = query.measures.find((entry) => (entry.alias ?? entry.measure).toLowerCase() === sourceAlias.toLowerCase());
  const measureField = sourceMeasure ? descriptor.fields.find((field) => field.kind === 'measure' && field.name.toLowerCase() === sourceMeasure.measure.toLowerCase()) : undefined;
  const facts = sourceCalculation
    ? checkTileCalculations(descriptor, query).outputs.find((output) => output.id === sourceCalculation.id)?.facts
    : measureField?.kind === 'measure' ? measureCalcFacts(measureField) : undefined;
  if (!facts) return null;
  const dimensions = query.dimensions.map((dimension) => ({
    alias: dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field),
    field: dimension.field,
    ...(dimension.timeGrain ? { timeGrain: dimension.timeGrain } : {}),
  }));
  const source = { label: humanize(sourceAlias), facts };
  const options = QUICK_CALC_KINDS.map((kind) => {
    const verdict = quickCalcVerdict(kind, source, dimensions);
    return { kind, ...(verdict.refusal ? { refusal: verdict.refusal } : {}) };
  });
  const refused = options.filter((option) => option.refusal);
  return {
    ...(own ? { calculation: own } : {}),
    current: own?.quick?.kind ?? null,
    sourceAlias,
    sourceRef: sourceCalculation ? sourceCalculation.id : sourceMeasure?.measure ?? sourceAlias,
    options,
    ...(refused.length === 1 ? { refusalNote: refused[0]!.refusal } : refused.length > 1 ? { refusalNote: `${refused.length} are not available for ${humanize(sourceAlias)}; hover one to see why.` } : {}),
  };
}
