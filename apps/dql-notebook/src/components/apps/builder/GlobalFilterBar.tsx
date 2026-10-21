import { useMemo, useState } from 'react';
import { ArrowLeft, CalendarDays, Check, ChevronDown, Filter, Plus, Search, Settings2, ShieldCheck, Trash2, X } from 'lucide-react';
import { formatDashboardCalendarDate } from '@zlens/core/apps/filter-dates';
import type { AppBlockRecommendation, AppStudioBuildDraft, DashboardRunResponse } from '../../../api/client';
import { defaultStudioFilterType, filterLinkSuggestions, filterPrimarySourceId, filterTileMappingsForField, initialFilterMappingKeys, isStudioDateFilterType, studioFilterFieldOverrides, type StudioFilterCandidate, type StudioFilterFieldOverrides, type StudioFilterLinkSuggestion, type StudioFilterMappingOptions, type StudioRuntimeFilterFields, type StudioFilterTileMapping } from '../app-studio-filter-candidates';
import { humanize, PanelTitle } from './studio-ui';
import { filterLinkedTileIds } from '../app-studio-filter-values';
import { plainSourceText, searchMatches, sourceDisplayName } from '../source-names';

export { filterLinkedTileIds };

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
  /** The Dataset the field was picked from; other Datasets are only suggested (D10). */
  primarySourceId?: string;
  /**
   * A date filter's field per Dataset (by source id) where the author mapped
   * a differently named date field ("Use Ordered At on Order Items").
   */
  fieldOverrides?: StudioFilterFieldOverrides;
};

/** How a filter configuration maps tiles: its date-field choices apply only to a date control. */
export function studioFilterMappingOptions(configuration: Pick<StudioFilterConfiguration, 'type' | 'fieldOverrides'> | null | undefined): StudioFilterMappingOptions {
  const dateFilter = isStudioDateFilterType(configuration?.type);
  return {
    dateFilter,
    ...(dateFilter && configuration?.fieldOverrides && Object.keys(configuration.fieldOverrides).length ? { fieldOverrides: configuration.fieldOverrides } : {}),
  };
}

/**
 * Whether a filter field matches the typed search. It ignores case, spaces
 * and underscores, and matches the label a person reads ("customer name"
 * finds `customer_name`) and the data it comes from.
 */
export function filterCandidateMatches(candidate: Pick<StudioFilterCandidate, 'id' | 'sourceNames'>, search: string): boolean {
  return searchMatches(search, [candidate.id, humanize(candidate.id), ...candidate.sourceNames.map((name) => sourceDisplayName(name))]);
}

/** "from Customers" or "from Customers and Orders", never an internal identity. */
export function filterCandidateOrigin(candidate: Pick<StudioFilterCandidate, 'sourceNames'>): string {
  const names = [...new Set(candidate.sourceNames.map((name) => sourceDisplayName(name)))];
  if (!names.length) return '';
  return `from ${names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`}`;
}

export type StudioFilterControlType = StudioDashboardFilter['type'];

export type StudioDashboardFilter = NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number];

export function FiltersPanel({
  draft,
  activePageId,
  catalog,
  candidates,
  runtimeFilterFields,
  previewRunsByPage,
  disabled,
  onSave,
  onRemove,
}: {
  draft: AppStudioBuildDraft;
  activePageId?: string;
  catalog: AppBlockRecommendation[];
  candidates: StudioFilterCandidate[];
  runtimeFilterFields: StudioRuntimeFilterFields;
  previewRunsByPage: Record<string, DashboardRunResponse>;
  /** Kept for callers; the date note no longer depends on a run in flight. */
  previewing?: boolean;
  disabled: boolean;
  /** Kept for callers; a date control never asks for a run before it is created. */
  onRunPreview?: () => void;
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
  const visibleCandidates = candidates.filter((candidate) => filterCandidateMatches(candidate, fieldQuery));
  const mappingOptions = studioFilterMappingOptions(configuration);
  const mappingOptionsKey = JSON.stringify(mappingOptions);
  const mappings = useMemo(
    () => configuration?.fieldId ? filterTileMappingsForField(draft.pages, catalog, configuration.fieldId, runtimeFilterFields, draft.sources, mappingOptions) : [],
    [catalog, configuration?.fieldId, draft.pages, draft.sources, runtimeFilterFields, mappingOptionsKey],
  );
  const visibleMappings = configuration?.scope === 'page'
    ? mappings.filter((mapping) => mapping.pageId === activePage?.id)
    : mappings;
  const selectedMappings = new Set(configuration?.selectedMappingKeys ?? []);
  const linkSuggestions = useMemo(
    () => filterLinkSuggestions(visibleMappings, configuration?.primarySourceId, draft.sources),
    [configuration?.primarySourceId, draft.sources, visibleMappings],
  );
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
    const primarySourceId = filterPrimarySourceId(candidateMappings, activePage?.id);
    setConfiguration({
      id: candidate.id,
      fieldId: candidate.id,
      label: humanize(candidate.id),
      type: defaultStudioFilterType(candidate.id),
      scope: 'app',
      required: false,
      // Only the picked field's own Dataset (and tiles that expose the field
      // directly) start linked; other Datasets are suggestions (D10).
      selectedMappingKeys: initialFilterMappingKeys(candidateMappings, primarySourceId),
      ...(primarySourceId ? { primarySourceId } : {}),
    });
  };
  const editFilter = (item: { filter: StudioDashboardFilter; pageIds: string[] }) => {
    const fieldId = item.filter.field?.name ?? item.filter.bindsTo ?? item.filter.id;
    // A date filter keeps the date fields the author mapped on other Datasets.
    const fieldOverrides = isStudioDateFilterType(item.filter.type) ? studioFilterFieldOverrides(draft.pages, item.filter.id, fieldId) : {};
    const filterMappings = filterTileMappingsForField(draft.pages, catalog, fieldId, runtimeFilterFields, draft.sources, studioFilterMappingOptions({ type: item.filter.type, fieldOverrides }));
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
    const primarySourceId = linked.find((mapping) => mapping.datasetId && mapping.sourceId)?.sourceId
      ?? filterPrimarySourceId(filterMappings, activePage?.id);
    setConfiguration({
      id: item.filter.id,
      fieldId,
      label: item.filter.label ?? humanize(item.filter.id),
      type: item.filter.type,
      scope: item.pageIds.length > 1 ? 'app' : 'page',
      required: item.filter.required ?? false,
      selectedMappingKeys: linked.map((mapping) => mapping.key),
      ...(primarySourceId ? { primarySourceId } : {}),
      ...(Object.keys(fieldOverrides).length ? { fieldOverrides } : {}),
    });
  };
  /**
   * Map a date filter to a tile's own date field ("Use Ordered At on Order
   * Items"): every tile on that Dataset then takes the filter through it.
   * Only ever an explicit author choice.
   */
  const useDateField = (mapping: StudioFilterTileMapping, field: string) => {
    if (!configuration || !mapping.sourceId) return;
    const sourceId = mapping.sourceId;
    const next = new Set(configuration.selectedMappingKeys);
    for (const candidate of visibleMappings) if (candidate.sourceId === sourceId) next.add(candidate.key);
    setConfiguration({ ...configuration, fieldOverrides: { ...(configuration.fieldOverrides ?? {}), [sourceId]: field }, selectedMappingKeys: [...next] });
  };
  const clearDateField = (mapping: StudioFilterTileMapping) => {
    if (!configuration || !mapping.sourceId) return;
    const sourceId = mapping.sourceId;
    const { [sourceId]: _removed, ...rest } = configuration.fieldOverrides ?? {};
    const keys = new Set(visibleMappings.filter((candidate) => candidate.sourceId === sourceId).map((candidate) => candidate.key));
    setConfiguration({ ...configuration, fieldOverrides: rest, selectedMappingKeys: configuration.selectedMappingKeys.filter((key) => !keys.has(key)) });
  };
  const setAllVisibleMappings = (checked: boolean) => {
    if (!configuration) return;
    const visibleKeys = new Set(visibleMappings.filter((mapping) => mapping.supported).map((mapping) => mapping.key));
    const next = new Set(configuration.selectedMappingKeys);
    for (const key of visibleKeys) checked ? next.add(key) : next.delete(key);
    setConfiguration({ ...configuration, selectedMappingKeys: [...next] });
  };
  const toggleSuggestion = (suggestion: StudioFilterLinkSuggestion, checked: boolean) => {
    if (!configuration) return;
    const next = new Set(configuration.selectedMappingKeys);
    for (const key of suggestion.mappingKeys) checked ? next.add(key) : next.delete(key);
    setConfiguration({ ...configuration, selectedMappingKeys: [...next] });
  };
  /** "Applies" links the tile; "Does not apply" is a saved author choice (never a gap). */
  const setMapping = (mapping: StudioFilterTileMapping, applies: boolean) => {
    if (!configuration || (applies && !mapping.supported)) return;
    const next = new Set(configuration.selectedMappingKeys);
    if (applies) next.add(mapping.key); else next.delete(mapping.key);
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
            <span><Filter size={14} /></span><div><strong>{humanize(candidate.id)}</strong><small>{filterCandidateOrigin(candidate)}</small><em>{candidate.affectedTileCount} compatible · {candidate.pageCount} {candidate.pageCount === 1 ? 'page' : 'pages'}</em></div><ChevronDown size={13} />
          </button>)}
        </div>
        {visibleCandidates.filter((candidate) => !existingIds.has(candidate.id)).length === 0 ? <p className="panel-empty">No additional fields match this search.</p> : null}
      </> : <div className="filter-builder">
        <section className="filter-builder-field"><span><ShieldCheck size={15} /></span><div><small>FIELD</small><strong>{humanize(configuration.fieldId)}</strong></div>{!editingExisting ? <button type="button" onClick={() => setConfiguration({ ...configuration, fieldId: '', selectedMappingKeys: [] })}>Change</button> : null}</section>
        {linkSuggestions.length ? <fieldset className="filter-link-suggestions" aria-label="Also filter these tiles?">
          <legend>Also filter these tiles?</legend>
          <small>Other Datasets in this App have a field with the same name. Nothing is linked until you check it.</small>
          {linkSuggestions.map((suggestion) => {
            const checked = suggestion.mappingKeys.every((key) => selectedMappings.has(key));
            const label = `${suggestion.datasetName} · ${humanize(suggestion.field)}`;
            return <label key={suggestion.sourceId}>
              <input type="checkbox" checked={checked} onChange={() => toggleSuggestion(suggestion, !checked)} aria-label={`Also filter ${label}`} />
              <span><strong>{label}</strong><small>{suggestion.tileCount} {suggestion.tileCount === 1 ? 'tile' : 'tiles'}</small></span>
            </label>;
          })}
        </fieldset> : null}
        <label><span>Display label</span><input value={configuration.label} onChange={(event) => setConfiguration({ ...configuration, label: event.target.value })} /></label>
        <label><span>Control</span><select value={configuration.type} onChange={(event) => setConfiguration({ ...configuration, type: event.target.value as StudioFilterControlType })}>{filterControlOptions(configuration.fieldId).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {dateControl ? <section className={`filter-availability ${fieldAvailability?.dateRange ? 'ready' : ''}`}>
          <span>{fieldAvailability?.dateRange ? <Check size={14} /> : <CalendarDays size={14} />}</span>
          {/* A date control never needs a value list, so nothing here blocks
              creating it. Dates the current preview holds are a hint only;
              "no dates" is said only when every linked tile's column was read. */}
          <div><strong>{fieldAvailability?.dateRange ? `Data from ${formatDashboardCalendarDate(fieldAvailability.dateRange.min)} to ${formatDashboardCalendarDate(fieldAvailability.dateRange.max)}` : dateFieldHasNoValues ? 'No dates in the current preview' : 'Any date'}</strong><small>{configuration.type === 'daterange' ? 'Readers set a start, an end, or both. Only a start means “from”; only an end means “until”.' : 'Readers pick one day; it keeps that whole day.'}</small></div>
        </section> : null}
        <fieldset><legend>Apply to</legend><div className="filter-scope-switch"><button type="button" className={configuration.scope === 'page' ? 'on' : ''} onClick={() => setConfiguration({ ...configuration, scope: 'page' })}>This page</button><button type="button" className={configuration.scope === 'app' ? 'on' : ''} onClick={() => setConfiguration({ ...configuration, scope: 'app' })}>All compatible pages</button></div><small>{configuration.scope === 'app' ? 'One dashboard control is retained on every page. Unmapped Dataset tiles stay visibly excluded until linked.' : `Only ${activePage?.metadata.title ?? 'this page'} receives this control.`}</small></fieldset>
        <fieldset className="filter-mapping"><legend>Tiles</legend><header><span>Applies to {selectedVisibleCount} of {visibleMappings.length} {visibleMappings.length === 1 ? 'tile' : 'tiles'}</span>{supportedVisibleCount > 0 ? <button type="button" onClick={() => setAllVisibleMappings(selectedVisibleCount !== supportedVisibleCount)}>{selectedVisibleCount === supportedVisibleCount ? 'Apply to none' : 'Apply to all'}</button> : null}</header>
          <small className="filter-mapping-hint">Each tile either takes this filter or shows “Not filtered by {configuration.label.trim() || humanize(configuration.fieldId)}” to readers. Both choices are saved; neither blocks publishing.</small>
          <div>{draft.pages.filter((page) => configuration.scope === 'app' || page.id === activePage?.id).map((page) => {
            const pageMappings = visibleMappings.filter((mapping) => mapping.pageId === page.id);
            if (!pageMappings.length) return null;
            return <section key={page.id}><small>{page.metadata.title}</small>{pageMappings.map((mapping) => (
              <FilterTileChoice key={mapping.key} mapping={mapping} applies={mapping.supported && selectedMappings.has(mapping.key)} onChoose={(applies) => setMapping(mapping, applies)} onUseDateField={(field) => useDateField(mapping, field)} onClearDateField={() => clearDateField(mapping)} />
            ))}</section>;
          })}</div>
        </fieldset>
        <label className="filter-required"><input type="checkbox" checked={configuration.required} onChange={(event) => setConfiguration({ ...configuration, required: event.target.checked })} /><span><strong>Require a value</strong><small>Publication and runs require this filter to be set.</small></span></label>
        <div className="filter-builder-actions"><button type="button" onClick={() => setConfiguration(null)}>Cancel</button><button type="button" className="primary" disabled={disabled || !configuration.label.trim() || selectedVisibleCount === 0} onClick={() => { onSave(configuration); setConfiguration(null); }}>{editingExisting ? 'Save filter' : 'Create filter'}</button></div>
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


/**
 * One tile's explicit choice for a filter: "Applies" (linked) or "Does not
 * apply" (a saved exclusion readers see as "Not filtered by …"). A tile that
 * cannot take the field can only be "Does not apply", with the reason shown.
 */
export function FilterTileChoice({ mapping, applies, onChoose, onUseDateField, onClearDateField }: {
  mapping: StudioFilterTileMapping;
  applies: boolean;
  onChoose: (applies: boolean) => void;
  /** Map a date filter to one of this tile's own date fields. */
  onUseDateField?: (field: string) => void;
  onClearDateField?: () => void;
}): JSX.Element {
  const tileName = humanize(mapping.tileTitle);
  const sourceName = sourceDisplayName(mapping.sourceName);
  return <div className={`filter-mapping-row ${applies ? 'applies' : 'does-not-apply'} ${mapping.supported ? '' : 'unsupported'}`} title={mapping.reason ? plainSourceText(mapping.reason) : undefined} data-testid="filter-tile-choice">
    <span><strong>{tileName}</strong><small>{mapping.supported ? `From ${sourceName} · ${mapping.mappedFrom && mapping.datasetField ? `uses ${humanize(mapping.datasetField)}` : mapping.datasetId ? 'Dataset field' : mapping.mode === 'semantic' ? 'Metrics field' : 'field binding'}` : plainSourceText(mapping.reason)}</small>
      {!mapping.supported && mapping.dateFieldOptions?.length && onUseDateField ? <span className="filter-date-field-options">{mapping.dateFieldOptions.map((option) => <button key={option.field} type="button" onClick={() => onUseDateField(option.field)}>Use {humanize(option.field)} on {sourceName}</button>)}</span> : null}
      {mapping.supported && mapping.mappedFrom && onClearDateField ? <button type="button" className="filter-date-field-clear" onClick={onClearDateField}>Don’t use {humanize(mapping.datasetField ?? '')}</button> : null}
    </span>
    <div className="filter-applies-switch" role="radiogroup" aria-label={`Does this filter apply to ${tileName}?`}>
      <button type="button" role="radio" aria-checked={applies} className={applies ? 'on' : ''} disabled={!mapping.supported} onClick={() => onChoose(true)}><Check size={11} /> Applies</button>
      <button type="button" role="radio" aria-checked={!applies} className={!applies ? 'on' : ''} onClick={() => onChoose(false)}><X size={11} /> Does not apply</button>
    </div>
  </div>;
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
  return draft.pages.reduce((count, page) => count + filterLinkedTileIds(page, filterId).length, 0);
}

