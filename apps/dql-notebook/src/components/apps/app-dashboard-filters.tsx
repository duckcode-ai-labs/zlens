import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CalendarDays, ChevronDown, Hash, List, ToggleLeft, Type } from 'lucide-react';
import { api, type DashboardDocumentResponse } from '../../api/client';
import { defaultParameterFilterValue, type DashboardFilterCandidate, type DashboardFilterCoverage } from './dashboard-filters';
import { formatBusinessLabel } from './app-text';
import { describeDashboardDateRange } from '@zlens/core/apps/filter-dates';
import { studioFilterValue } from './app-studio-filter-values';
import { plainSourceText } from './source-names';
import { DateRangePresetSelect, filterTimezone } from './date-range-presets';
import { filterValueCapHint, loadBlockFilterValues, useFilterValueSearch, type FilterValueList, type FilterValueSource } from './filter-value-search';

/**
 * The App dashboard filter row: the controls, their value coercion, and the
 * per-type icons.
 *
 * Extracted from `AppsView.tsx`. Self-contained — it reads and writes a plain
 * `Record<string, unknown>` of filter values and knows nothing about the App.
 */
type DashboardFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number];
type DashboardDatasetBinding = NonNullable<DashboardDocumentResponse['dashboard']['datasets']>[number];

/** The Dataset field a filter's options come from: its first binding on this page. */
export function datasetOptionSource(filter: DashboardFilter, datasets: DashboardDatasetBinding[] | undefined): { sourceId: string; field: string } | undefined {
  for (const [datasetId, binding] of Object.entries(filter.datasetBindings ?? {})) {
    const dataset = datasets?.find((candidate) => candidate.id === datasetId);
    if (dataset) return { sourceId: dataset.sourceId, field: binding.field };
  }
  return undefined;
}

export function DashboardFilterControls({
  filters,
  values,
  onChange,
  datasets,
}: {
  filters: DashboardFilter[];
  values: Record<string, unknown>;
  onChange: (filter: DashboardFilter, value: unknown) => void;
  /** The page's Dataset bindings, so Dataset-bound filters can list their values. */
  datasets?: DashboardDatasetBinding[];
}) {
  if (filters.length === 0) {
    return <span className="dql-app-filter-empty">No filters</span>;
  }
  return (
    <>
      {filters.map((filter) => (
        <DashboardFilterInput
          key={filter.id}
          filter={filter}
          datasetSource={datasetOptionSource(filter, datasets)}
          value={values[filter.id] ?? defaultDashboardFilterValue(filter)}
          onChange={(value) => onChange(filter, value)}
        />
      ))}
    </>
  );
}

/**
 * Add, inspect, and remove a page's global filters.
 *
 * Filters were authored only by the AI at build time and had no editor at all,
 * so a page that got none could never gain one. Candidates come from what the
 * tiles actually returned, and each filter states the tiles it truly reaches —
 * a filter that silently narrows half a page is worse than none, because the
 * page still reads as one scope.
 */
/**
 * "Filter by…": pick a business column and a value, then apply.
 *
 * This is the viewer's control, not the author's — the same move as adding an
 * input to an Ask or Notebook result, at page scale. Columns come from the
 * server's parse of each tile's executed SQL. Values come from the server:
 * the column's first page, and typed text searches every value, as for a
 * declared filter. Only a column the server cannot list falls back to the
 * values the tiles returned (Codex F02: 24 sampled names hid most customers).
 *
 * Choosing one is session-only. A viewer exploring a number must never rewrite
 * the page's saved scope for everyone; an author promotes a choice explicitly
 * from Edit.
 */
export function DashboardFilterPicker({
  candidates,
  coverageFor,
  onApply,
}: {
  candidates: DashboardFilterCandidate[];
  coverageFor: (column: string) => DashboardFilterCoverage;
  onApply: (column: string, value: string) => void;
}) {
  const [column, setColumn] = useState('');
  const [value, setValue] = useState('');
  const active = candidates.find((candidate) => candidate.column === column);
  const valueSource = active?.valueSource;
  // The column's values from the server: null while loading, 'failed' when it cannot list them.
  const [serverList, setServerList] = useState<{ key: string; list: FilterValueList | 'failed' } | null>(null);
  const sourceKey = valueSource ? `${valueSource.blockId}\u0000${valueSource.column}` : '';
  useEffect(() => {
    if (!valueSource) return;
    let cancelled = false;
    void loadBlockFilterValues(valueSource).then((list) => {
      if (!cancelled) setServerList({ key: sourceKey, list: list && list.values.length > 0 ? list : 'failed' });
    }).catch(() => { if (!cancelled) setServerList({ key: sourceKey, list: 'failed' }); });
    return () => { cancelled = true; };
  }, [sourceKey]);
  if (candidates.length === 0) return null;
  const coverage = active ? coverageFor(active.column) : null;
  const loaded = valueSource && serverList?.key === sourceKey ? serverList.list : null;
  const loadingValues = Boolean(valueSource) && !loaded;
  const searchable = loaded && loaded !== 'failed' ? loaded : null;
  const label = active ? formatBusinessLabel(active.column) : '';
  return (
    <div className="dql-app-filter-picker">
      <select
        aria-label="Filter this page by"
        value={column}
        onChange={(event) => { setColumn(event.target.value); setValue(''); }}
      >
        <option value="">Filter by…</option>
        {candidates.map((candidate) => (
          <option key={candidate.column} value={candidate.column}>
            {formatBusinessLabel(candidate.column)}
          </option>
        ))}
      </select>
      {active ? (
        <>
          {searchable && valueSource ? (
            <SearchableFilterSelect
              icon={<List size={13} />}
              label={label}
              value={value}
              list={searchable}
              source={valueSource}
              allowAll={false}
              onChange={setValue}
            />
          ) : loadingValues ? (
            <span className="dql-app-filter-coverage-hint" role="status">Loading {label.toLowerCase()} values…</span>
          ) : active.sampleValues.length > 0 ? (
            <select aria-label={`${label} value`} value={value} onChange={(event) => setValue(event.target.value)}>
              <option value="">Choose a value…</option>
              {active.sampleValues.map((sample) => <option key={sample} value={sample}>{sample}</option>)}
            </select>
          ) : (
            <input
              aria-label={`${formatBusinessLabel(active.column)} value`}
              value={value}
              placeholder="Value…"
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          {coverage ? (
            <span className="dql-app-filter-coverage-hint">
              {coverage.applied.length === 0
                ? 'No tile on this page can apply it'
                : `Will narrow ${coverage.applied.length} of ${coverage.filterable} tiles`}
            </span>
          ) : null}
          <button
            type="button"
            className="dql-apps-btn dql-apps-btn-primary"
            disabled={!value.trim()}
            onClick={() => { onApply(active.column, value.trim()); setColumn(''); setValue(''); }}
          >
            Apply
          </button>
        </>
      ) : null}
    </div>
  );
}

export function DashboardFilterEditor({
  filters,
  candidates,
  coverageFor,
  onAdd,
  onRemove,
  busy,
}: {
  filters: DashboardFilter[];
  candidates: DashboardFilterCandidate[];
  coverageFor: (filterId: string) => DashboardFilterCoverage;
  onAdd: (column: string) => void;
  onRemove: (filterId: string) => void;
  busy?: boolean;
}) {
  const [adding, setAdding] = useState('');
  return (
    <div className="dql-app-filter-editor">
      {filters.map((filter) => {
        const coverage = coverageFor(filter.id);
        const partial = coverage.unaffected.length > 0 && coverage.applied.length > 0;
        const none = coverage.applied.length === 0;
        return (
          <div key={filter.id} className="dql-app-filter-editor-row">
            <span className="dql-app-filter-editor-name">{formatBusinessLabel(filter.id)}</span>
            <span
              className={`dql-app-filter-coverage${partial ? ' is-partial' : ''}${none ? ' is-none' : ''}`}
              title={coverage.unaffected.length
                ? `Not applied to: ${coverage.unaffected.map((tile) => `${tile.title ?? tile.tileId}${tile.reason ? ` — ${plainSourceText(tile.reason)}` : ''}`).join('; ')}`
                : 'Applies to every tile on this page.'}
            >
              {none
                ? 'Reaches no tile'
                : `Applies to ${coverage.applied.length} of ${coverage.filterable} tile${coverage.filterable === 1 ? '' : 's'}`}
            </span>
            <button
              type="button"
              className="dql-apps-btn dql-apps-btn-line"
              disabled={busy}
              aria-label={`Remove the ${formatBusinessLabel(filter.id)} filter`}
              onClick={() => onRemove(filter.id)}
            >
              Remove
            </button>
          </div>
        );
      })}
      {candidates.length > 0 ? (
        <div className="dql-app-filter-editor-row">
          <select
            aria-label="Add a filter column"
            value={adding}
            disabled={busy}
            onChange={(event) => setAdding(event.target.value)}
          >
            <option value="">Add a filter…</option>
            {candidates.map((candidate) => (
              <option key={candidate.column} value={candidate.column}>
                {formatBusinessLabel(candidate.column)} — in {candidate.tiles} tile{candidate.tiles === 1 ? '' : 's'}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="dql-apps-btn dql-apps-btn-primary"
            disabled={!adding || busy}
            onClick={() => { onAdd(adding); setAdding(''); }}
          >
            Add filter
          </button>
        </div>
      ) : filters.length === 0 ? (
        <span className="dql-app-filter-empty">
          No column is shared by enough tiles on this page to act as a global filter.
        </span>
      ) : null}
    </div>
  );
}

function DashboardFilterInput({
  filter,
  value,
  onChange,
  datasetSource,
}: {
  filter: DashboardFilter;
  value: unknown;
  onChange: (value: unknown) => void;
  datasetSource?: { sourceId: string; field: string };
}) {
  const label = filter.label?.trim() || formatBusinessLabel(filter.id);
  const valueText = filterInputValue(filter, value);
  // Categorical filters bound to a tile: fetch the column's distinct values and
  // upgrade the free-text box to a real dropdown (low-cardinality only).
  const sourceBlockId = (filter as { sourceBlockId?: string }).sourceBlockId;
  const column = filter.bindsTo || filter.id;
  const wantsOptions = (filter.type === 'string' || filter.type === 'select' || filter.type === 'multiselect' || filter.type === 'search') && Boolean(sourceBlockId) && !filter.options?.length;
  const [fetchedOptions, setFetchedOptions] = useState<string[] | null>(null);
  // A Dataset field's first page of values, and how many exist: a capped
  // list is searched on the server (every value), never only the page.
  const [datasetList, setDatasetList] = useState<FilterValueList | null>(null);
  const wantsDatasetOptions = (filter.type === 'select' || filter.type === 'multiselect' || filter.type === 'string')
    && Boolean(datasetSource) && !filter.options?.length;
  useEffect(() => {
    if (!wantsDatasetOptions || !datasetSource) return;
    let cancelled = false;
    void api.datasetFieldValues(datasetSource.sourceId, datasetSource.field).then((res) => {
      if (cancelled) return;
      setFetchedOptions(res.ok ? res.values : []);
      setDatasetList(res.ok ? { values: res.values, truncated: res.truncated, ...(res.valueCount !== undefined ? { valueCount: res.valueCount } : {}), ...(res.valueCountCapped ? { valueCountCapped: true } : {}) } : null);
    });
    return () => { cancelled = true; };
  }, [datasetSource?.sourceId, datasetSource?.field, wantsDatasetOptions]);
  useEffect(() => {
    if (!wantsOptions || !sourceBlockId) return;
    let cancelled = false;
    void api.dashboardFilterOptions(sourceBlockId, column).then((res) => {
      if (!cancelled) setFetchedOptions(res && res.options.length > 0 && !res.truncated ? res.options : []);
    });
    return () => { cancelled = true; };
  }, [sourceBlockId, column, wantsOptions]);
  if (filter.type !== 'multiselect' && datasetSource && datasetList && datasetList.values.length > 0) {
    return (
      <SearchableFilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
        list={datasetList}
        source={datasetSource}
        onChange={onChange}
      />
    );
  }
  if (filter.type !== 'multiselect' && fetchedOptions && fetchedOptions.length > 0) {
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={valueText}
        onChange={onChange}
        options={[['', `All ${label.toLowerCase()}`], ...fetchedOptions.map((opt) => [opt, opt] as [string, string])]}
      />
    );
  }
  if (filter.type === 'select' && filterOptions(filter).length > 0) {
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={valueText}
        onChange={onChange}
        options={filterOptions(filter)}
      />
    );
  }
  if (filter.type === 'multiselect') {
    // A single name is still a selection: showing "All" for it would hide a
    // filter that narrows the tiles.
    const selected = Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? [value] : [];
    const options = (filter.options ?? fetchedOptions ?? []).map(String);
    return <MultiSelectFilterChip label={label} icon={filterIconForDashboardFilter(filter)} options={options} selected={selected} onChange={onChange} />;
  }
  if (filter.type === 'relative_date') {
    const options = filter.options?.length ? filter.options : ['last_7_days', 'last_30_days', 'last_90_days', 'month_to_date', 'quarter_to_date', 'year_to_date'];
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={valueText}
        onChange={onChange}
        options={options.map((option) => [String(option), formatBusinessLabel(String(option))])}
      />
    );
  }
  if (filter.type === 'boolean') {
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={String(Boolean(value))}
        onChange={(next) => onChange(next === 'true')}
        options={[
          ['true', 'Yes'],
          ['false', 'No'],
        ]}
      />
    );
  }
  if (filter.type === 'daterange') {
    const range = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { start?: unknown; end?: unknown })
      : {};
    const start = typeof range.start === 'string' ? range.start : '';
    const end = typeof range.end === 'string' ? range.end : '';
    // One end is a "from" / "until" range (the runtime keeps rows from the
    // start, or up to the end); neither end clears the filter.
    const emit = (nextStart: string, nextEnd: string) => onChange(studioFilterValue(filter, { start: nextStart, end: nextEnd }));
    const oneSided = Boolean(start) !== Boolean(end);
    return (
      <label className="dql-app-filter-select dql-app-filter-range" title={filter.bindsTo ? `${label} -> ${filter.bindsTo}` : label} aria-label={label}>
        <span className="dql-app-filter-icon">{filterIconForDashboardFilter(filter)}</span>
        {/* The reader sees which date this is (new-user round 3, problem 9). */}
        <span className="dql-app-filter-label">{label}</span>
        <DateRangePresetSelect label={label} value={value} timezone={filterTimezone(filter)} className="dql-app-filter-presets" onChange={(next) => (next ? emit(next.start, next.end) : emit('', ''))} />
        <input type="date" value={start} aria-label={`${label} from`} onChange={(event) => emit(event.target.value, end)} />
        <span className="dql-app-filter-range-sep">–</span>
        <input type="date" value={end} aria-label={`${label} to`} onChange={(event) => emit(start, event.target.value)} />
        {oneSided ? <span className="dql-app-filter-range-note">{describeDashboardDateRange({ start, end })}</span> : null}
      </label>
    );
  }
  if (filter.type === 'number_range') {
    const range = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { min?: unknown; max?: unknown })
      : {};
    const min = typeof range.min === 'number' || typeof range.min === 'string' ? String(range.min) : '';
    const max = typeof range.max === 'number' || typeof range.max === 'string' ? String(range.max) : '';
    const emit = (nextMin: string, nextMax: string) => onChange({
      min: nextMin === '' ? undefined : Number(nextMin),
      max: nextMax === '' ? undefined : Number(nextMax),
    });
    return (
      <label className="dql-app-filter-select dql-app-filter-range" title={label} aria-label={label}>
        <span className="dql-app-filter-icon">{filterIconForDashboardFilter(filter)}</span>
        <input type="number" value={min} aria-label={`${label} minimum`} placeholder="Min" onChange={(event) => emit(event.target.value, max)} />
        <span className="dql-app-filter-range-sep">–</span>
        <input type="number" value={max} aria-label={`${label} maximum`} placeholder="Max" onChange={(event) => emit(min, event.target.value)} />
      </label>
    );
  }
  return (
    <label className="dql-app-filter-select" title={filter.bindsTo ? `${label} -> ${filter.bindsTo}` : label} aria-label={label}>
      <span className="dql-app-filter-icon">{filterIconForDashboardFilter(filter)}</span>
      <input
        type={filter.type === 'number' ? 'number' : filter.type === 'date' ? 'date' : 'text'}
        value={valueText}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function filterIconForDashboardFilter(filter: DashboardFilter): ReactNode {
  if (filter.type === 'date' || filter.type === 'daterange' || /season|year|date|time|period/i.test(filter.id)) {
    return <CalendarDays size={13} />;
  }
  return <Hash size={13} />;
}

function filterOptions(filter: DashboardFilter): Array<[string, string]> {
  const options = filter.options?.length ? filter.options : [filter.default].filter((value) => value !== undefined);
  return options.map((option) => [String(option), formatBusinessLabel(String(option))]);
}

export function defaultDashboardFilterValue(filter: DashboardFilter): unknown {
  if (filter.default !== undefined) return filter.default;
  if (filter.type === 'number') return defaultParameterFilterValue(filter.id);
  if (filter.type === 'boolean') return false;
  if (filter.type === 'select') return filter.options?.[0] ?? '';
  if (filter.type === 'multiselect') return [];
  if (filter.type === 'number_range') return { min: undefined, max: undefined };
  if (filter.type === 'relative_date') return filter.options?.[0] ?? 'last_30_days';
  return '';
}

function filterInputValue(filter: DashboardFilter, value: unknown): string {
  if (value === undefined || value === null) return String(defaultDashboardFilterValue(filter) ?? '');
  if ((filter.type === 'daterange' || filter.type === 'number_range' || filter.type === 'multiselect') && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function coerceDashboardFilterValue(filter: DashboardFilter, value: unknown): unknown {
  if (filter.type === 'number') {
    if (typeof value === 'string' && value.trim() === '') return '';
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (filter.type === 'boolean') return value === true || value === 'true';
  if (filter.type === 'multiselect') return Array.isArray(value) ? value.map(String) : [];
  if (filter.type === 'select' && typeof filter.default === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  return value;
}

export function shallowEqualRecords(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function FilterSelect({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="dql-app-filter-select" title={label} aria-label={label}>
      {icon ? <span className="dql-app-filter-icon">{icon}</span> : <span>{label}</span>}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
  );
}

/**
 * One value from a long list, with search. The reader's version of the
 * editor's dropdown: the first page is listed for browsing, and typed text
 * searches every value of the field when the list is capped.
 */
export function SearchableFilterSelect({
  label,
  icon,
  value,
  list,
  source,
  allowAll = true,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  list: FilterValueList;
  source?: FilterValueSource;
  /** false: choosing a value is the point (the reader's "Filter by…" picker), so there is no "All". */
  allowAll?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const search = useFilterValueSearch(source, list, query);
  const capHint = filterValueCapHint(list);
  const choose = (next: string) => { onChange(next); setOpen(false); setQuery(''); };
  return (
    <div className={`dql-app-filter-select dql-app-filter-multi dql-app-filter-searchable ${value ? 'is-set' : ''}`} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
      <button type="button" className="dql-app-filter-multi-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${value || (allowAll ? 'All' : 'choose a value')}`} onClick={() => setOpen((current) => !current)}>
        <span className="dql-app-filter-icon">{icon}</span>
        <span className="dql-app-filter-multi-label">{label}:</span>
        <b>{value || (allowAll ? 'All' : 'Choose a value…')}</b>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="dql-app-filter-multi-menu dql-app-filter-search-menu">
          <input type="search" autoFocus value={query} placeholder={`Search ${label.toLowerCase()}`} aria-label={`Search ${label}`} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
          <div role="listbox" aria-label={label}>
            {allowAll ? <button type="button" role="option" aria-selected={!value} className={!value ? 'on' : ''} onClick={() => choose('')}>All</button> : null}
            {search.values.map((option) => (
              <button key={option} type="button" role="option" aria-selected={option === value} className={option === value ? 'on' : ''} onClick={() => choose(option)}>{option}</button>
            ))}
          </div>
          {search.values.length === 0 ? <small>{search.searching ? 'Searching all values…' : 'No matching values'}</small> : null}
          <small className="dql-app-filter-search-hint">{query.trim() ? search.searching ? 'Searching all values…' : search.truncated ? `First ${search.values.length} matches · type more to narrow` : `${search.values.length} ${search.values.length === 1 ? 'match' : 'matches'}` : capHint ?? `${list.values.length} values`}</small>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" className={`dql-app-toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <i /> {label}
    </button>
  );
}

/**
 * A multi-value filter as one chip ("Region: US") that opens a checklist.
 * A native multi-select renders as an always-open list box in the filter row.
 */
function MultiSelectFilterChip({
  label,
  icon,
  options,
  selected,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  options: string[];
  selected: string[];
  onChange: (value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = selected.length === 0 ? 'All' : selected.length === 1 ? formatBusinessLabel(selected[0]!) : `${selected.length} selected`;
  const toggle = (option: string) => onChange(selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option]);
  return (
    <div className={`dql-app-filter-select dql-app-filter-multi ${selected.length ? 'is-set' : ''}`} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <button type="button" className="dql-app-filter-multi-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label} multiple selection`} onClick={() => setOpen((value) => !value)}>
        <span className="dql-app-filter-icon">{icon}</span>
        <span className="dql-app-filter-multi-label">{label}:</span>
        <b>{summary}</b>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="dql-app-filter-multi-menu" role="listbox" aria-multiselectable="true" aria-label={label}>
          {options.map((option) => (
            <label key={option} className={selected.includes(option) ? 'on' : ''}>
              <input type="checkbox" checked={selected.includes(option)} onChange={() => toggle(option)} />
              <span>{formatBusinessLabel(option)}</span>
            </label>
          ))}
          {!options.length ? <small>No values available.</small> : null}
          {selected.length ? <button type="button" onClick={() => onChange([])}>Clear</button> : null}
        </div>
      ) : null}
    </div>
  );
}
