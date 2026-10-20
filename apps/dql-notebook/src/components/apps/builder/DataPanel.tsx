import { useState } from 'react';
import { CalendarDays, Check, ChevronDown, Hash, Heading, Search, ShieldCheck, Table2, Type, X } from 'lucide-react';
import type { AppBlockRecommendation } from '../../../api/client';
import type { DatasetDescriptor, DatasetField } from '@zlens/core/datasets/descriptor';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import { groupDatasetFields, queryFieldNames } from './field-query';
import { humanize } from './studio-ui';
import { writeFieldDrag } from './ShelfEditor';

export type DataPanelTarget =
  | { kind: 'none' }
  | { kind: 'draft'; query: TileQuery }
  | { kind: 'tile'; title: string; query: TileQuery };

/**
 * The Data tab: one governed Dataset at a time and its fields. Clicking a
 * field builds the tile — a new draft tile, or the selected Dataset tile.
 * Blocks and every other governed source stay one click away.
 */
export function DataPanel({
  datasets,
  active,
  target,
  disabled,
  onChooseDataset,
  onPickField,
  onBrowseSources,
  onStartFromTable,
  onAddContent,
  loading = false,
}: {
  datasets: AppBlockRecommendation[];
  active: AppBlockRecommendation | null;
  target: DataPanelTarget;
  disabled: boolean;
  onChooseDataset: (item: AppBlockRecommendation) => void;
  onPickField: (field: DatasetField) => void;
  onBrowseSources: () => void;
  /** Start a Dataset from a table in the database. */
  onStartFromTable?: () => void;
  onAddContent: (kind: 'heading' | 'text') => void;
  /** The list of Datasets is still loading. */
  loading?: boolean;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const descriptor = active?.capabilities?.dataset as DatasetDescriptor | undefined;
  const groups = descriptor ? groupDatasetFields(descriptor, search) : null;
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
  return <div className="data-panel">
    <div className="dataset-picker">
      <button type="button" className="dataset-current" aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)} disabled={!datasets.length && !onStartFromTable}>
        <span className="dataset-icon"><TableGlyph /></span>
        <span className="dataset-text">
          <strong>{active ? humanize(active.name) : datasets.length ? 'Choose your data' : 'No data yet'}</strong>
          {active ? <small className={active.status === 'certified' ? 'certified' : 'review'}>{active.status === 'certified' ? <><ShieldCheck size={11} /> Certified</> : 'Needs review'}{descriptor ? ` · ${descriptor.fields.length} fields` : ''}</small> : <small>{datasets.length ? `${datasets.length} available` : 'Start from a table'}</small>}
        </span>
        <ChevronDown size={14} />
      </button>
      {pickerOpen ? <div className="dataset-menu" role="menu">
        {datasets.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === active?.id} className={item.id === active?.id ? 'on' : ''} onClick={() => { onChooseDataset(item); setPickerOpen(false); setSearch(''); }}>
          <span><strong>{humanize(item.name)}</strong><small>{humanize(item.domain)} · {item.status === 'certified' ? 'Certified' : 'Needs review'}</small></span>
          {item.id === active?.id ? <Check size={13} /> : null}
        </button>)}
        <hr />
        {onStartFromTable ? <button type="button" role="menuitem" onClick={() => { setPickerOpen(false); onStartFromTable(); }}><span><strong>Start from a table…</strong><small>Pick a table in your database</small></span></button> : null}
        <button type="button" role="menuitem" onClick={() => { setPickerOpen(false); onBrowseSources(); }}><span><strong>Saved queries and all sources…</strong><small>Metrics, saved queries and data that needs review</small></span></button>
      </div> : null}
    </div>

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

    {groups ? <div className="field-groups">
      {groups.measures.length ? <section><h3>Measures</h3>{groups.measures.map((field) => fieldRow(field, field.kind === 'measure' ? aggregationLabel(field.aggregation) : '', measureGlyph))}</section> : null}
      {groups.time.length ? <section><h3>Time</h3>{groups.time.map((field) => fieldRow(field, field.time?.grains?.slice(0, 3).join(' · ') ?? field.type, <CalendarDays size={14} />))}</section> : null}
      {groups.dimensions.length ? <section><h3>Dimensions</h3>{groups.dimensions.map((field) => fieldRow(field, field.kind === 'physical' && field.role === 'key' ? 'key' : '', field.kind === 'physical' && field.role === 'key' ? <Hash size={13} /> : <span className="aa">Aa</span>))}</section> : null}
      {groups.review.length ? <section><h3>Needs review</h3>{groups.review.map((field) => fieldRow(field, '', field.kind === 'measure' ? measureGlyph : <span className="aa">Aa</span>, true))}</section> : null}
      {!groups.measures.length && !groups.time.length && !groups.dimensions.length && !groups.review.length ? <p className="field-empty">No field matches “{search}”.</p> : null}
    </div> : datasets.length || loading ? <p className="field-empty">{loading && !datasets.length ? 'Looking for your data…' : 'Choose your data to see its fields.'} <button type="button" onClick={onBrowseSources}>Browse all sources</button></p> : (
      <div className="data-start">
        <Table2 size={20} aria-hidden="true" />
        <strong>Start with a table</strong>
        <p>Pick a table in your database. ZLens suggests what to add up, count and group by; you check it once, then build tiles from it.</p>
        {onStartFromTable ? <button type="button" className="primary" disabled={disabled} onClick={onStartFromTable}>Start from a table</button> : null}
        <button type="button" className="link" onClick={onBrowseSources}>Use a saved query instead</button>
      </div>
    )}

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
