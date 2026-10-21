import { useEffect, useState } from 'react';
import { BarChart3, CalendarDays, Check, ChevronDown, FileText, Gauge, Hash, Heading, MoreHorizontal, Plus, Search, ShieldCheck, Table2, Type, X } from 'lucide-react';
import type { AppBlockRecommendation } from '../../../api/client';
import type { DatasetDescriptor, DatasetField } from '@zlens/core/datasets/descriptor';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import { groupDatasetFields, queryFieldNames } from './field-query';
import { humanize } from './studio-ui';
import { writeFieldDrag } from './ShelfEditor';
import { appDataSameNameOrigins } from './app-data-names';
import { FIELD_TILES_OFF_MESSAGE, MAKE_ROW_LEVEL_HINT, SAVED_QUERY_FIELDS_NOTE, canMakeRowLevel, needsReview, sourceCatalogKindLabel, trustLabel } from './app-data';

export type DataPanelTarget =
  | { kind: 'none' }
  | { kind: 'draft'; query: TileQuery }
  | { kind: 'tile'; title: string; query: TileQuery };

/**
 * The Data tab: a switcher over the App's data (its sources), the chosen
 * source's fields, and **+ Add data**. Clicking a field builds the tile — a
 * new draft tile, or the selected Dataset tile. A saved query's fields come
 * from its result (design D1); only when its columns can't be read is it
 * added whole as a Table, Chart or KPI. "Make row-level" sits under ⋯.
 */
export function DataPanel({
  appData,
  active,
  target,
  disabled,
  datasetTilesEnabled = true,
  onChoose,
  onPickField,
  onAddData,
  onAddSavedQuery,
  onAddContent,
  onAuthorDataset,
  onRefreshBinding,
  onMakeRowLevel,
  fieldsStatus,
  pickerRequest = 0,
  defaultPickerOpen = false,
  loading = false,
}: {
  /** This App's data: Datasets, Metrics and saved queries already connected. */
  appData: AppBlockRecommendation[];
  /** The chosen source: a Dataset or Metrics (fields), or a saved query. */
  active: AppBlockRecommendation | null;
  target: DataPanelTarget;
  disabled: boolean;
  datasetTilesEnabled?: boolean;
  onChoose: (item: AppBlockRecommendation) => void;
  onPickField: (field: DatasetField) => void;
  /** Open the Add data browser. */
  onAddData: () => void;
  onAddSavedQuery: (item: AppBlockRecommendation, kind: 'kpi' | 'chart' | 'table') => void;
  onAddContent: (kind: 'heading' | 'text') => void;
  /** Author the active Dataset's definition, when it is a DQL block Dataset. */
  onAuthorDataset?: (item: AppBlockRecommendation) => void;
  /** Refresh this App's binding to the active Dataset's current revision. */
  onRefreshBinding?: (item: AppBlockRecommendation) => void;
  /** Make the chosen saved query row-level (formerly "Add fields"). Absent when field tiles are off. */
  onMakeRowLevel?: (item: AppBlockRecommendation) => void;
  /** Reading the chosen saved query's result columns as fields, or why that failed. */
  fieldsStatus?: { state: 'reading' } | { state: 'failed'; error: string };
  /** Changing this number opens the switcher (tile settings "Choose another Dataset"). */
  pickerRequest?: number;
  defaultPickerOpen?: boolean;
  /** The App's data is still loading. */
  loading?: boolean;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(defaultPickerOpen);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { if (pickerRequest > 0) setPickerOpen(true); }, [pickerRequest]);
  const descriptor = active?.capabilities?.dataset as DatasetDescriptor | undefined;
  // A saved query's result fields need field tiles; with them off it is added whole.
  const resultFields = Boolean(descriptor?.result);
  const savedQuery = active && (!descriptor || (resultFields && !datasetTilesEnabled)) ? active : null;
  const groups = descriptor && datasetTilesEnabled ? groupDatasetFields(descriptor, search) : null;
  const rowLevel = active && onMakeRowLevel && canMakeRowLevel(active) ? onMakeRowLevel : undefined;
  const used = queryFieldNames(target.kind === 'none' ? undefined : target.query);
  const fieldRow = (field: DatasetField, meta: string, glyph: JSX.Element, locked = false) => {
    const on = used.has(field.name.toLowerCase());
    return <button
      key={field.name}
      type="button"
      className={`data-field ${on ? 'on' : ''}`}
      disabled={disabled || locked}
      aria-pressed={on}
      title={locked ? 'Suggested field — it needs review in the Dataset before tiles can use it.' : on ? `Remove ${humanize(field.name)}` : `Add ${humanize(field.name)}, or drag it onto a shelf`}
      onClick={() => onPickField(field)}
      draggable={!disabled && !locked}
      onDragStart={(event) => writeFieldDrag(event, field.kind === 'measure' ? { measure: field.name } : { dimension: field.name })}
    >
      <span className="glyph">{glyph}</span>
      <span className="name">{humanize(field.name)}</span>
      {locked ? <span className="badge">Suggested</span> : <span className="meta">{meta}</span>}
      {on ? <Check size={13} className="check" /> : null}
    </button>;
  };
  const measureGlyph = <span className="sigma">Σ</span>;
  const activeCertified = active ? !needsReview(active) : false;
  const sameNames = appDataSameNameOrigins(appData);
  return <div className="data-panel">
    <div className="dataset-picker">
      <button type="button" className="dataset-current" aria-expanded={pickerOpen} aria-haspopup="menu" onClick={() => setPickerOpen((open) => !open)}>
        <span className="dataset-icon"><TableGlyph /></span>
        <span className="dataset-text">
          <strong>{active ? humanize(active.name) : appData.length ? 'Choose your data' : 'No data yet'}{active && sameNames.get(active.id) ? <em className="same-name-origin"> · {sameNames.get(active.id)}</em> : null}</strong>
          {active ? <small className={activeCertified ? 'certified' : 'review'}>{activeCertified ? <ShieldCheck size={11} /> : null} {sourceCatalogKindLabel(active)} · {trustLabel(activeCertified ? 'certified' : 'review')}{descriptor ? ` · ${descriptor.fields.length} fields` : ''}</small> : <small>{appData.length ? `${appData.length} in this App` : 'Add data to start'}</small>}
        </span>
        <ChevronDown size={14} />
      </button>
      {rowLevel && active ? <span className="dataset-more">
        <button type="button" aria-haspopup="menu" aria-expanded={moreOpen} aria-label={`More for ${humanize(active.name)}`} disabled={disabled} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={14} /></button>
        {moreOpen ? <span className="dataset-more-menu" role="menu" aria-label={`More for ${humanize(active.name)}`}>
          <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); rowLevel(active); }}><strong>Make row-level</strong><small>{MAKE_ROW_LEVEL_HINT}</small></button>
        </span> : null}
      </span> : null}
      {pickerOpen ? <div className="dataset-menu" role="menu" aria-label="This App's data">
        <small className="dataset-menu-label">This App's data</small>
        {appData.map((item) => {
          const certified = !needsReview(item);
          return <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === active?.id} className={item.id === active?.id ? 'on' : ''} onClick={() => { onChoose(item); setPickerOpen(false); setSearch(''); }}>
            <span><strong>{humanize(item.name)}{sameNames.get(item.id) ? <em className="same-name-origin"> · {sameNames.get(item.id)}</em> : null}</strong><small>{sourceCatalogKindLabel(item)} · {trustLabel(certified ? 'certified' : 'review')}{item.domain && item.domain !== 'Unassigned' ? ` · ${humanize(item.domain)}` : ''}</small></span>
            {item.id === active?.id ? <Check size={13} /> : null}
          </button>;
        })}
        {!appData.length ? <small className="dataset-menu-empty">No data in this App yet.</small> : null}
        <hr />
        <button type="button" role="menuitem" onClick={() => { setPickerOpen(false); onAddData(); }}><span><strong>+ Add data…</strong><small>Datasets, Metrics, saved queries and database tables</small></span></button>
      </div> : null}
    </div>

    {descriptor && !resultFields && !datasetTilesEnabled ? <p className="field-empty" role="status">{FIELD_TILES_OFF_MESSAGE}</p> : null}

    {groups ? <>
      <label className="field-search">
        <Search size={14} />
        <input id="studio-field-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search fields" aria-label="Search fields" />
        {search ? <button type="button" onClick={() => setSearch('')} aria-label="Clear field search"><X size={12} /></button> : null}
      </label>

      <p className="field-target" role="status">{target.kind === 'tile'
        ? <>Click a field to add it to <strong>{target.title}</strong>. Click it again to remove it.</>
        : target.kind === 'draft'
          ? <>Building a <strong>new tile</strong>. Values become numbers; dates and categories group them.</>
          : <>Click a field to start a new tile.</>}</p>

      <div className="field-groups">
        {groups.measures.length ? <section><h3>Measures</h3>{groups.measures.map((field) => fieldRow(field, field.kind === 'measure' ? aggregationLabel(field.aggregation) : '', measureGlyph))}</section> : null}
        {groups.time.length ? <section><h3>Time</h3>{groups.time.map((field) => fieldRow(field, field.time?.grains?.slice(0, 3).join(' · ') ?? field.type, <CalendarDays size={14} />))}</section> : null}
        {groups.dimensions.length ? <section><h3>Dimensions</h3>{groups.dimensions.map((field) => fieldRow(field, field.kind === 'physical' && field.role === 'key' ? 'key' : '', field.kind === 'physical' && field.role === 'key' ? <Hash size={13} /> : <span className="aa">Aa</span>))}</section> : null}
        {groups.review.length ? <section><h3>Needs review</h3>{groups.review.map((field) => fieldRow(field, '', field.kind === 'measure' ? measureGlyph : <span className="aa">Aa</span>, true))}</section> : null}
        {!groups.measures.length && !groups.time.length && !groups.dimensions.length && !groups.review.length ? <p className="field-empty">No field matches “{search}”.</p> : null}
      </div>
      {resultFields ? <small className="field-help">{SAVED_QUERY_FIELDS_NOTE}</small> : null}
      {active && (onAuthorDataset || onRefreshBinding) ? <div className="dataset-source-actions">
        {onAuthorDataset ? <button type="button" className="link" disabled={disabled} onClick={() => onAuthorDataset(active)}><FileText size={12} /> Author Dataset definition</button> : null}
        {onRefreshBinding ? <button type="button" className="link" disabled={disabled} onClick={() => onRefreshBinding(active)}><ShieldCheck size={12} /> Refresh this App binding</button> : null}
      </div> : null}
    </> : null}

    {savedQuery && fieldsStatus?.state === 'reading' ? <p className="field-empty" role="status">Reading the columns of {humanize(savedQuery.name)}…</p> : null}
    {savedQuery && fieldsStatus?.state !== 'reading' ? <div className="saved-query-panel">
      {savedQuery.description ? <p>{savedQuery.description}</p> : null}
      {fieldsStatus?.state === 'failed' ? <small className="field-help" role="status">ZLens couldn’t read its columns as fields: {fieldsStatus.error}</small> : null}
      <span className="saved-query-label">Add as it is</span>
      <div className="source-view-options" aria-label={`Add ${humanize(savedQuery.name)} as a tile`}>
        <button type="button" disabled={disabled} aria-label={`Add ${humanize(savedQuery.name)} as Table`} onClick={() => onAddSavedQuery(savedQuery, 'table')}><Table2 size={13} /> Table</button>
        <button type="button" disabled={disabled} aria-label={`Add ${humanize(savedQuery.name)} as Chart`} onClick={() => onAddSavedQuery(savedQuery, 'chart')}><BarChart3 size={13} /> Chart</button>
        <button type="button" disabled={disabled} aria-label={`Add ${humanize(savedQuery.name)} as KPI`} onClick={() => onAddSavedQuery(savedQuery, 'kpi')}><Gauge size={13} /> KPI</button>
      </div>
    </div> : null}

    {!active ? (loading && !appData.length
      ? <p className="field-empty">Looking for your data…</p>
      : appData.length
        ? <p className="field-empty">Choose data from this App to see its fields.</p>
        : <div className="data-start">
          <Table2 size={20} aria-hidden="true" />
          <strong>This App has no data yet</strong>
          <p>Add a Dataset, Metrics, a saved query or a database table. Then click its fields to build tiles.</p>
          <button type="button" className="primary" disabled={disabled} onClick={onAddData}><Plus size={13} /> Add data</button>
        </div>) : null}

    <div className="panel-section-label"><span>Page elements</span><small>No data needed</small></div>
    <div className="content-quick-add compact">
      <button type="button" disabled={disabled} onClick={() => onAddContent('heading')}><Heading size={14} /><span><strong>Heading</strong></span></button>
      <button type="button" disabled={disabled} onClick={() => onAddContent('text')}><Type size={14} /><span><strong>Text</strong></span></button>
    </div>
  </div>;
}

function aggregationLabel(aggregation: string): string {
  const labels: Record<string, string> = { sum: 'sum', count: 'count', count_distinct: 'distinct', distinct_count: 'distinct', avg: 'average', average: 'average', min: 'min', max: 'max', ratio: 'ratio', expression: 'formula' };
  return labels[aggregation] ?? aggregation.replace(/_/g, ' ');
}

function TableGlyph(): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16" /></svg>;
}
