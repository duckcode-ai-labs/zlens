import { useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Filter, Play, Plus, Search, Settings2, ShieldCheck, Trash2, X } from 'lucide-react';
import type { AppBlockRecommendation, AppStudioBuildDraft, DashboardRunResponse } from '../../../api/client';
import { defaultStudioFilterType, filterTileMappingsForField, type StudioFilterCandidate, type StudioRuntimeFilterFields, type StudioFilterTileMapping } from '../app-studio-filter-candidates';
import { humanize, PanelTitle } from './studio-ui';

type StudioFilterScope = 'page' | 'app';

type StudioFieldAvailability = {
  checkedComponents: number;
  compatibleComponents: number;
  valueCount: number;
  dateRange?: { min: string; max: string };
};

export type StudioFilterConfiguration = {
  id: string;
  fieldId: string;
  label: string;
  type: StudioFilterControlType;
  scope: StudioFilterScope;
  required: boolean;
  selectedMappingKeys: string[];
};

export type StudioFilterControlType = StudioDashboardFilter['type'];

export type StudioDashboardFilter = NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number];

export function FiltersPanel({
  draft,
  activePageId,
  catalog,
  candidates,
  runtimeFilterFields,
  previewRunsByPage,
  previewing,
  disabled,
  onRunPreview,
  onSave,
  onRemove,
}: {
  draft: AppStudioBuildDraft;
  activePageId?: string;
  catalog: AppBlockRecommendation[];
  candidates: StudioFilterCandidate[];
  runtimeFilterFields: StudioRuntimeFilterFields;
  previewRunsByPage: Record<string, DashboardRunResponse>;
  previewing: boolean;
  disabled: boolean;
  onRunPreview: () => void;
  onSave: (configuration: StudioFilterConfiguration) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const [configuration, setConfiguration] = useState<StudioFilterConfiguration | null>(null);
  const [fieldQuery, setFieldQuery] = useState('');
  const activePage = draft.pages.find((page) => page.id === activePageId) ?? draft.pages[0];
  const logicalFilters = useMemo(() => {
    const byId = new Map<string, { filter: StudioDashboardFilter; pageIds: string[] }>();
    for (const page of draft.pages) {
      for (const filter of page.filters ?? []) {
        const current = byId.get(filter.id);
        if (current) current.pageIds.push(page.id);
        else byId.set(filter.id, { filter, pageIds: [page.id] });
      }
    }
    return [...byId.values()];
  }, [draft.pages]);
  const existingIds = new Set(logicalFilters.map((item) => item.filter.id));
  const visibleCandidates = candidates.filter((candidate) => {
    const needle = fieldQuery.trim().toLowerCase();
    return !needle || [candidate.id, ...candidate.sourceNames].join(' ').toLowerCase().includes(needle);
  });
  const mappings = useMemo(
    () => configuration?.fieldId ? filterTileMappingsForField(draft.pages, catalog, configuration.fieldId, runtimeFilterFields, draft.sources) : [],
    [catalog, configuration?.fieldId, draft.pages, draft.sources, runtimeFilterFields],
  );
  const visibleMappings = configuration?.scope === 'page'
    ? mappings.filter((mapping) => mapping.pageId === activePage?.id)
    : mappings;
  const selectedMappings = new Set(configuration?.selectedMappingKeys ?? []);
  const selectedVisibleCount = visibleMappings.filter((mapping) => mapping.supported && selectedMappings.has(mapping.key)).length;
  const supportedVisibleCount = visibleMappings.filter((mapping) => mapping.supported).length;
  const fieldAvailability = useMemo(
    () => configuration?.fieldId
      ? studioFieldAvailability(configuration.fieldId, visibleMappings.filter((mapping) => mapping.supported), previewRunsByPage)
      : null,
    [configuration?.fieldId, previewRunsByPage, visibleMappings],
  );
  const dateControl = configuration?.type === 'daterange' || configuration?.type === 'date';
  const dateAvailabilityChecked = Boolean(dateControl
    && fieldAvailability
    && fieldAvailability.compatibleComponents > 0
    && fieldAvailability.checkedComponents === fieldAvailability.compatibleComponents);
  const dateFieldHasNoValues = Boolean(dateAvailabilityChecked && fieldAvailability?.valueCount === 0);

  const chooseField = (candidate: StudioFilterCandidate) => {
    const candidateMappings = filterTileMappingsForField(draft.pages, catalog, candidate.id, runtimeFilterFields, draft.sources);
    setConfiguration({
      id: candidate.id,
      fieldId: candidate.id,
      label: humanize(candidate.id),
      type: defaultStudioFilterType(candidate.id),
      scope: 'app',
      required: false,
      selectedMappingKeys: candidateMappings.filter((mapping) => mapping.supported).map((mapping) => mapping.key),
    });
  };
  const editFilter = (item: { filter: StudioDashboardFilter; pageIds: string[] }) => {
    const fieldId = item.filter.field?.name ?? item.filter.bindsTo ?? item.filter.id;
    const filterMappings = filterTileMappingsForField(draft.pages, catalog, fieldId, runtimeFilterFields, draft.sources);
    const linked = filterMappings.filter((mapping) => {
      const page = draft.pages.find((candidate) => candidate.id === mapping.pageId);
      const pageFilter = page?.filters?.find((filter) => filter.id === item.filter.id);
      if (!pageFilter) return false;
      if (mapping.datasetId && mapping.datasetField) {
        const datasetBinding = pageFilter.datasetBindings?.[mapping.datasetId];
        return (!pageFilter.scope?.tileIds || pageFilter.scope.tileIds.includes(mapping.tileId))
          && datasetBinding?.field === mapping.datasetField
          && (!datasetBinding.tileIds || datasetBinding.tileIds.includes(mapping.tileId));
      }
      if (pageFilter.scope?.tileIds) return pageFilter.scope.tileIds.includes(mapping.tileId);
      return page?.layout.items.find((tile) => tile.i === mapping.tileId)?.filterBindings
        ?.some((binding) => binding.filter === item.filter.id && binding.capability !== 'unsupported') ?? false;
    });
    setConfiguration({
      id: item.filter.id,
      fieldId,
      label: item.filter.label ?? humanize(item.filter.id),
      type: item.filter.type,
      scope: item.pageIds.length > 1 ? 'app' : 'page',
      required: item.filter.required ?? false,
      selectedMappingKeys: linked.map((mapping) => mapping.key),
    });
  };
  const setAllVisibleMappings = (checked: boolean) => {
    if (!configuration) return;
    const visibleKeys = new Set(visibleMappings.filter((mapping) => mapping.supported).map((mapping) => mapping.key));
    const next = new Set(configuration.selectedMappingKeys);
    for (const key of visibleKeys) checked ? next.add(key) : next.delete(key);
    setConfiguration({ ...configuration, selectedMappingKeys: [...next] });
  };
  const toggleMapping = (mapping: StudioFilterTileMapping) => {
    if (!configuration || !mapping.supported) return;
    const next = new Set(configuration.selectedMappingKeys);
    if (next.has(mapping.key)) next.delete(mapping.key); else next.add(mapping.key);
    setConfiguration({ ...configuration, selectedMappingKeys: [...next] });
  };

  if (configuration) {
    const editingExisting = existingIds.has(configuration.id);
    return <>
      <PanelTitle title={editingExisting ? 'Configure filter' : 'New filter'} detail="Choose a field and link its tiles" action={<button type="button" onClick={() => { setConfiguration(null); setFieldQuery(''); }} aria-label="Back to filters"><ArrowLeft size={14} /></button>} />
      {!configuration.fieldId ? <>
        <label className="filter-field-search"><Search size={14} /><input autoFocus value={fieldQuery} onChange={(event) => setFieldQuery(event.target.value)} placeholder="Search fields" /></label>
        <div className="filter-field-results">
          {visibleCandidates.filter((candidate) => !existingIds.has(candidate.id)).map((candidate) => <button key={candidate.id} type="button" onClick={() => chooseField(candidate)}>
            <span><Filter size={14} /></span><div><strong>{humanize(candidate.id)}</strong><small>{candidate.sourceNames.map(humanize).join(', ')}</small><em>{candidate.affectedTileCount} compatible · {candidate.pageCount} {candidate.pageCount === 1 ? 'page' : 'pages'}</em></div><ChevronDown size={13} />
          </button>)}
        </div>
        {visibleCandidates.filter((candidate) => !existingIds.has(candidate.id)).length === 0 ? <p className="panel-empty">No additional fields match this search.</p> : null}
      </> : <div className="filter-builder">
        <section className="filter-builder-field"><span><ShieldCheck size={15} /></span><div><small>FIELD</small><strong>{humanize(configuration.fieldId)}</strong></div>{!editingExisting ? <button type="button" onClick={() => setConfiguration({ ...configuration, fieldId: '', selectedMappingKeys: [] })}>Change</button> : null}</section>
        <label><span>Display label</span><input value={configuration.label} onChange={(event) => setConfiguration({ ...configuration, label: event.target.value })} /></label>
        <label><span>Control</span><select value={configuration.type} onChange={(event) => setConfiguration({ ...configuration, type: event.target.value as StudioFilterControlType })}>{filterControlOptions(configuration.fieldId).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {dateControl ? <section className={`filter-availability ${dateFieldHasNoValues ? 'empty' : fieldAvailability?.dateRange ? 'ready' : ''}`}>
          <span>{dateFieldHasNoValues ? <X size={14} /> : fieldAvailability?.dateRange ? <Check size={14} /> : <Play size={14} />}</span>
          <div><strong>{previewing ? 'Checking available dates…' : dateFieldHasNoValues ? 'No date values found' : fieldAvailability?.dateRange ? `${fieldAvailability.dateRange.min} – ${fieldAvailability.dateRange.max}` : 'Check available dates'}</strong><small>{previewing ? 'The settled preview is checking the selected field.' : dateFieldHasNoValues ? 'This field has no usable dates in the current result. Choose another field or refresh the data.' : fieldAvailability?.dateRange ? `${fieldAvailability.valueCount} dated rows found across ${fieldAvailability.checkedComponents} linked ${fieldAvailability.checkedComponents === 1 ? 'tile' : 'tiles'}.` : 'Run the current page once before creating this date control.'}</small></div>
          {!previewing && !fieldAvailability?.dateRange ? <button type="button" onClick={onRunPreview} disabled={disabled}><Play size={12} /> Run preview</button> : null}
        </section> : null}
        <fieldset><legend>Apply to</legend><div className="filter-scope-switch"><button type="button" className={configuration.scope === 'page' ? 'on' : ''} onClick={() => setConfiguration({ ...configuration, scope: 'page' })}>This page</button><button type="button" className={configuration.scope === 'app' ? 'on' : ''} onClick={() => setConfiguration({ ...configuration, scope: 'app' })}>All compatible pages</button></div><small>{configuration.scope === 'app' ? 'One dashboard control is retained on every page. Unmapped Dataset tiles stay visibly excluded until linked.' : `Only ${activePage?.metadata.title ?? 'this page'} receives this control.`}</small></fieldset>
        <fieldset className="filter-mapping"><legend>Linked tiles</legend><header><span>{selectedVisibleCount}/{supportedVisibleCount} compatible linked</span><button type="button" onClick={() => setAllVisibleMappings(selectedVisibleCount !== supportedVisibleCount)}>{selectedVisibleCount === supportedVisibleCount ? 'Clear compatible' : 'Link all compatible'}</button></header>
          <div>{draft.pages.filter((page) => configuration.scope === 'app' || page.id === activePage?.id).map((page) => {
            const pageMappings = visibleMappings.filter((mapping) => mapping.pageId === page.id);
            if (!pageMappings.length) return null;
            return <section key={page.id}><small>{page.metadata.title}</small>{pageMappings.map((mapping) => <label key={mapping.key} className={mapping.supported ? '' : 'unsupported'} title={mapping.reason}>
              <input type="checkbox" checked={mapping.supported && selectedMappings.has(mapping.key)} disabled={!mapping.supported} onChange={() => toggleMapping(mapping)} /><span><strong>{humanize(mapping.tileTitle)}</strong><small>{mapping.supported ? `${humanize(mapping.sourceName)} · ${mapping.datasetId ? 'Dataset field mapping' : mapping.mode === 'semantic' ? 'Metrics field' : 'field binding'}` : mapping.reason}</small></span>{mapping.supported ? <Check size={13} /> : <X size={13} />}
            </label>)}</section>;
          })}</div>
        </fieldset>
        <label className="filter-required"><input type="checkbox" checked={configuration.required} onChange={(event) => setConfiguration({ ...configuration, required: event.target.checked })} /><span><strong>Require a value</strong><small>Publication and runs require this filter to be set.</small></span></label>
        <div className="filter-builder-actions"><button type="button" onClick={() => setConfiguration(null)}>Cancel</button><button type="button" className="primary" disabled={disabled || !configuration.label.trim() || selectedVisibleCount === 0 || dateFieldHasNoValues} onClick={() => { onSave(configuration); setConfiguration(null); }}>{editingExisting ? 'Save filter' : 'Create filter'}</button></div>
      </div>}
    </>;
  }

  return <>
    <PanelTitle title="Filters" detail="Controls linked to certified fields" action={<button type="button" disabled={disabled || candidates.length === 0} onClick={() => setConfiguration({ id: '', fieldId: '', label: '', type: 'select', scope: 'app', required: false, selectedMappingKeys: [] })} aria-label="Create filter"><Plus size={14} /></button>} />
    <div className="filter-workflow" aria-label="How App filters work"><span><b>1</b>Choose a field</span><span><b>2</b>Link all or selected tiles</span><span><b>3</b>Use the control directly on the canvas</span><small>Changing a filter refreshes every linked tile together.</small></div>
    {logicalFilters.length > 0 ? <div className="panel-section-label"><span>Dashboard filters</span><small>{logicalFilters.length} configured</small></div> : null}
    <div className="filter-contract-list">{logicalFilters.map((item) => {
      const fieldId = item.filter.field?.name ?? item.filter.bindsTo ?? item.filter.id;
      const linked = linkedComponentCount(draft, item.filter.id);
      return <article key={item.filter.id}><button type="button" className="filter-contract-summary" onClick={() => editFilter(item)}><span><Filter size={14} /></span><div><strong>{item.filter.label ?? humanize(item.filter.id)}</strong><small>{humanize(fieldId)} · {humanize(item.filter.type)}</small><em>{linked} linked {linked === 1 ? 'tile' : 'tiles'} · {item.pageIds.length > 1 ? 'App-wide' : humanize(draft.pages.find((page) => page.id === item.pageIds[0])?.metadata.title ?? 'Page')}</em></div><Settings2 size={14} /></button><button type="button" className="filter-remove" onClick={() => onRemove(item.filter.id)} aria-label={`Delete ${item.filter.label ?? humanize(item.filter.id)} filter`} title="Delete filter"><Trash2 size={13} /></button></article>;
    })}</div>
    {logicalFilters.length === 0 ? <div className="filter-empty"><span><Filter size={18} /></span><strong>Create a dashboard filter</strong><p>Pick a field, choose a dropdown or search control, then link every compatible tile.</p><button type="button" disabled={disabled || candidates.length === 0} onClick={() => setConfiguration({ id: '', fieldId: '', label: '', type: 'select', scope: 'app', required: false, selectedMappingKeys: [] })}><Plus size={13} /> New filter</button></div> : null}
    {candidates.length === 0 ? <p className="panel-empty">Add a KPI, chart, or table from certified data first. Its filter fields and Metrics dimensions will appear here.</p> : logicalFilters.length > 0 ? <button type="button" className="filter-add-another" disabled={disabled} onClick={() => setConfiguration({ id: '', fieldId: '', label: '', type: 'select', scope: 'app', required: false, selectedMappingKeys: [] })}><Plus size={13} /> Add another filter</button> : null}
  </>;
}


export function filterControlOptions(fieldId: string): Array<{ value: StudioFilterControlType; label: string }> {
  const common: Array<{ value: StudioFilterControlType; label: string }> = [
    { value: 'select', label: 'Searchable dropdown' },
    { value: 'multiselect', label: 'Searchable multi-select' },
  ];
  if (defaultStudioFilterType(fieldId) === 'daterange') {
    return [
      { value: 'daterange', label: 'Date range' },
      { value: 'date', label: 'Single date' },
      ...common,
    ];
  }
  if (/count|amount|total|score|quantity|price|revenue|cost|limit|top_?n/i.test(fieldId)) {
    return [{ value: 'number', label: 'Number' }, ...common];
  }
  if (/^(is_|has_)|_flag$|enabled|active/i.test(fieldId)) {
    return [{ value: 'boolean', label: 'Yes / no' }, ...common];
  }
  return common;
}

export function studioFieldAvailability(
  fieldId: string,
  mappings: StudioFilterTileMapping[],
  previewRunsByPage: Record<string, DashboardRunResponse>,
): StudioFieldAvailability {
  let checkedComponents = 0;
  let valueCount = 0;
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;
  for (const mapping of mappings) {
    const tile = previewRunsByPage[mapping.pageId]?.tiles.find((candidate) => candidate.tileId === mapping.tileId);
    if (tile?.status !== 'ok' || !tile.result) continue;
    const requested = normalizeStudioField(mapping.binding ?? fieldId);
    const column = tile.result.columns.find((candidate) => normalizeStudioField(candidate) === requested);
    if (!column) continue;
    checkedComponents += 1;
    for (const row of tile.result.rows) {
      const timestamp = Date.parse(String(row[column] ?? ''));
      if (!Number.isFinite(timestamp)) continue;
      valueCount += 1;
      minTimestamp = Math.min(minTimestamp, timestamp);
      maxTimestamp = Math.max(maxTimestamp, timestamp);
    }
  }
  return {
    checkedComponents,
    compatibleComponents: mappings.length,
    valueCount,
    ...(valueCount > 0 ? {
      dateRange: {
        min: new Date(minTimestamp).toISOString().slice(0, 10),
        max: new Date(maxTimestamp).toISOString().slice(0, 10),
      },
    } : {}),
  };
}

export function normalizeStudioField(value: string): string {
  return value.trim().toLowerCase().replace(/["`\[\]]/g, '').split('.').at(-1)?.replace(/[^a-z0-9]/g, '') ?? '';
}

export function mergeStudioDateRanges(
  current?: { min: string; max: string },
  incoming?: { min: string; max: string },
): { min: string; max: string } | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  return {
    min: current.min < incoming.min ? current.min : incoming.min,
    max: current.max > incoming.max ? current.max : incoming.max,
  };
}

export function linkedComponentCount(draft: AppStudioBuildDraft, filterId: string): number {
  return draft.pages.reduce((count, page) => {
    const filter = page.filters?.find((candidate) => candidate.id === filterId);
    if (!filter) return count;
    return count + page.layout.items.filter((tile) => {
      if (filter.scope?.tileIds && !filter.scope.tileIds.includes(tile.i)) return false;
      if ((tile.query || tile.driver) && tile.sourceId && tile.sourceRevision) {
        return Boolean(page.datasets?.some((dataset) => {
          if (dataset.sourceId !== tile.sourceId || dataset.sourceRevision !== tile.sourceRevision) return false;
          const binding = filter.datasetBindings?.[dataset.id];
          return Boolean(binding && (!binding.tileIds || binding.tileIds.includes(tile.i)));
        }));
      }
      return tile.filterBindings?.some((binding) => binding.filter === filterId && binding.capability !== 'unsupported') ?? false;
    }).length;
  }, 0);
}
