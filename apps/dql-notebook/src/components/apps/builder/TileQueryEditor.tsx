import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import type {
  DatasetDescriptor,
  DatasetMeasureField,
  DatasetPhysicalField,
} from '@zlens/core/datasets/descriptor';
import {
  tileQueryOutputAliases,
  type TileFilterOperator,
  type TileQuery,
} from '@zlens/core/apps/tile-query';
import {
  buildDatasetComparison,
  datasetComparisonDraftFromQuery,
  datasetComparisonSummary,
  datasetComparisonTimeFields,
  type DatasetComparisonDraft,
} from '../app-dataset-comparison';

/**
 * The one field-query editor App Studio uses, both when adding a tile and
 * when editing a saved one. It is controlled: every change is a whole new
 * TileQuery handed to `onChange`, and the host decides whether to accept it.
 * A host that refuses returns the reason, which is shown here.
 *
 * Suggested (unreviewed) fields are listed but cannot be selected, so an
 * author sees what the Dataset could offer once reviewed instead of wondering
 * why a column is missing.
 */
export function TileQueryEditor({
  descriptor,
  query,
  disabled,
  onChange,
  idPrefix,
  shelves = false,
  filterField: requestedFilterField,
}: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  disabled: boolean;
  onChange: (next: TileQuery) => string | void;
  /** Keeps radio groups independent when two editors are on screen. */
  idPrefix: string;
  /** Shelves own the measures and grouping (RFC 0009); this editor keeps the rest. */
  shelves?: boolean;
  /** Preselect a field in the filter builder, e.g. from a shelf field's "Filter…". */
  filterField?: string;
}): JSX.Element {
  const fields = useMemo(() => datasetEditorFields(descriptor), [descriptor]);
  const detail = query.detail === true;
  const detailSupported = descriptor.operations.includes('detail');
  const [error, setError] = useState<string | null>(null);
  const [filterField, setFilterField] = useState(fields.filterable[0]?.name ?? '');
  const [filterOp, setFilterOp] = useState<TileFilterOperator>(() => filterOperatorsFor(fields.filterable[0])[0] ?? 'eq');
  const [filterValue, setFilterValue] = useState('');
  useEffect(() => {
    const field = fields.filterable.find((candidate) => candidate.name === requestedFilterField);
    if (!field) return;
    setFilterField(field.name);
    setFilterOp(filterOperatorsFor(field)[0] ?? 'eq');
  }, [requestedFilterField]);
  const [havingMeasure, setHavingMeasure] = useState(() => query.measures[0]?.measure ?? '');
  const [havingOp, setHavingOp] = useState<TileFilterOperator>('gt');
  const [havingValue, setHavingValue] = useState('');
  const comparisonTimeFields = useMemo(() => datasetComparisonTimeFields(descriptor), [descriptor]);
  const comparisonKey = query.comparison ? JSON.stringify(query.comparison) : '';
  const [comparisonOpen, setComparisonOpen] = useState(Boolean(query.comparison));
  const [comparisonDraft, setComparisonDraft] = useState<DatasetComparisonDraft>(() => datasetComparisonDraftFromQuery(descriptor, query.comparison));
  const comparisonResult = useMemo(() => comparisonOpen ? buildDatasetComparison(descriptor, comparisonDraft) : undefined, [comparisonDraft, comparisonOpen, descriptor]);

  useEffect(() => {
    setFilterField(fields.filterable[0]?.name ?? '');
    setFilterOp(filterOperatorsFor(fields.filterable[0])[0] ?? 'eq');
    setFilterValue('');
    setError(null);
  }, [descriptor.id, descriptor.sourceRevision]);
  useEffect(() => {
    const selected = query.measures.map((selection) => selection.measure);
    if (!selected.includes(havingMeasure)) setHavingMeasure(selected[0] ?? '');
  }, [havingMeasure, query.measures.map((selection) => selection.measure).join('|')]);
  useEffect(() => {
    setComparisonOpen(Boolean(query.comparison));
    setComparisonDraft(datasetComparisonDraftFromQuery(descriptor, query.comparison));
  }, [comparisonKey, descriptor.id, descriptor.sourceRevision]);

  const change = (next: TileQuery) => {
    const refused = onChange(next);
    setError(refused || null);
  };

  const selectedMeasures = new Set(query.measures.map((selection) => selection.measure));
  const groupDimension = query.dimensions[0];
  const grouped = fields.groupable.find((field) => field.name === groupDimension?.field || field.qualifiedId === groupDimension?.field);
  const outputs = tileQueryOutputAliases(query);
  const primarySort = query.orderBy?.[0];

  const toggleMeasure = (measure: DatasetMeasureField) => {
    const has = selectedMeasures.has(measure.name) || selectedMeasures.has(measure.qualifiedId);
    const measures = has
      ? query.measures.filter((selection) => selection.measure !== measure.name && selection.measure !== measure.qualifiedId)
      : [...query.measures, { measure: measure.name }];
    const keep = new Set(measures.map((selection) => selection.measure));
    const having = (query.having ?? []).filter((filter) => keep.has(filter.field));
    const aliases = new Set(tileQueryOutputAliases({ ...query, measures }).map((output) => output.alias));
    const orderBy = (query.orderBy ?? []).filter((order) => aliases.has(order.alias));
    change(withOptional({ ...query, measures }, { having, orderBy }));
  };

  const changeGroup = (fieldName: string) => {
    const field = fields.groupable.find((candidate) => candidate.name === fieldName);
    const dimensions = field ? [{ field: field.name, ...(field.role === 'time' && field.time?.grains[0] ? { timeGrain: field.time.grains[0] } : {}) }] : [];
    const next: TileQuery = { ...query, dimensions };
    const aliases = new Set(tileQueryOutputAliases(next).map((output) => output.alias));
    let orderBy = (query.orderBy ?? []).filter((order) => aliases.has(order.alias));
    // A new grouping reads best ranked by its first measure. It is a visible,
    // editable default below, never a hidden rule.
    if (field && orderBy.length === 0 && query.measures[0] && field.role !== 'time') {
      orderBy = [{ alias: query.measures[0].alias ?? query.measures[0].measure, direction: 'desc' }];
    }
    if (field?.role === 'time' && orderBy.length === 0) {
      const alias = tileQueryOutputAliases(next).find((output) => output.kind === 'dimension')?.alias;
      if (alias) orderBy = [{ alias, direction: 'asc' }];
    }
    change(withOptional(next, { orderBy }));
  };

  const changeGrain = (timeGrain: string) => {
    if (!grouped) return;
    const oldAlias = outputs.find((output) => output.kind === 'dimension')?.alias;
    const dimensions = [{ field: grouped.name, timeGrain }];
    const newAlias = tileQueryOutputAliases({ ...query, dimensions }).find((output) => output.kind === 'dimension')?.alias;
    const orderBy = (query.orderBy ?? []).map((order) => (order.alias === oldAlias && newAlias ? { ...order, alias: newAlias } : order));
    change(withOptional({ ...query, dimensions }, { orderBy }));
  };

  const changeSort = (alias: string, direction: 'asc' | 'desc') => {
    change(withOptional(query, { orderBy: alias ? [{ alias, direction }] : [] }));
  };

  const changeLimit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      const { limit: _limit, ...withoutLimit } = query;
      change(withoutLimit);
      return;
    }
    const limit = Number(trimmed);
    change({ ...query, limit: Number.isFinite(limit) ? Math.trunc(limit) : 0 });
  };

  const changeMode = (next: 'metrics' | 'detail') => {
    const keep = {
      ...(query.filters?.length ? { filters: query.filters } : {}),
      ...(query.respectsGlobalFilters === false ? { respectsGlobalFilters: false } : { respectsGlobalFilters: true }),
    };
    if (next === 'detail') {
      change({
        dimensions: [],
        measures: [],
        detail: true,
        detailColumns: query.detailColumns?.length ? query.detailColumns : fields.filterable.slice(0, 6).map((field) => field.name),
        limit: typeof query.limit === 'number' ? query.limit : 100,
        ...keep,
      });
      return;
    }
    const first = fields.measures.find((measure) => measure.status === 'approved');
    change({ dimensions: [], measures: first ? [{ measure: first.name }] : [], ...keep });
  };

  const toggleDetailColumn = (field: DatasetPhysicalField) => {
    const current = query.detailColumns ?? [];
    change({ ...query, detailColumns: current.includes(field.name) ? current.filter((column) => column !== field.name) : [...current, field.name] });
  };

  const addFilter = () => {
    const field = fields.filterable.find((candidate) => candidate.name === filterField);
    if (!field) return;
    const values = parseFilterValues(field.type, filterOp, filterValue);
    if (!values) {
      setError(filterOp === 'between' ? 'Enter exactly two values, separated by a comma.' : `Enter a valid ${field.type} value.`);
      return;
    }
    change({ ...query, filters: [...(query.filters ?? []), { field: field.name, op: filterOp, values }] });
    setFilterValue('');
  };

  const addHaving = () => {
    if (!query.measures.some((measure) => measure.measure === havingMeasure)) {
      setError('Choose a selected measure before filtering totals.');
      return;
    }
    const values = parseFilterValues('number', havingOp, havingValue);
    if (!values) {
      setError(havingOp === 'between' ? 'Enter exactly two numeric totals, separated by a comma.' : 'Enter a valid numeric total.');
      return;
    }
    change({ ...query, having: [...(query.having ?? []), { field: havingMeasure, op: havingOp, values }] });
    setHavingValue('');
  };

  const applyComparison = () => {
    if (query.measures.length !== 1) {
      setError('Choose exactly one measure before comparing periods.');
      return;
    }
    if (query.dimensions.some((dimension) => dimension.field === comparisonDraft.timeField)) {
      setError('Remove the comparison time field from Group by first. The periods already define that time scope.');
      return;
    }
    if (comparisonResult?.status !== 'ready') {
      setError(comparisonResult?.status === 'blocked' ? comparisonResult.message : 'Complete both periods before applying the comparison.');
      return;
    }
    // A comparison aligns complete period results before it calculates
    // deltas, so a ranking cap cannot apply to it.
    const { comparison: _comparison, orderBy: _orderBy, limit: _limit, ...rest } = query;
    change({ ...rest, comparison: comparisonResult.comparison });
  };

  const removeComparison = () => {
    const { comparison: _comparison, ...rest } = query;
    setComparisonOpen(false);
    change(rest);
  };

  const filterFieldEntry = fields.filterable.find((field) => field.name === filterField);
  return <div className="tile-query-editor">
    <fieldset className="dataset-builder-mode"><legend>Show</legend>
      <label><input type="radio" name={`${idPrefix}-mode`} checked={!detail} disabled={disabled} onChange={() => changeMode('metrics')} /><span><strong>Summarise</strong><small>Add up rows into a KPI, chart or table.</small></span></label>
      <label title={detailSupported ? undefined : 'Needs a column that is filled and different on every row.'}><input type="radio" name={`${idPrefix}-mode`} checked={detail} disabled={disabled || !detailSupported} onChange={() => changeMode('detail')} /><span><strong>Show rows</strong><small>{detailSupported ? 'Pick columns and how many rows to show.' : 'Needs a column that is filled and different on every row.'}</small></span></label>
    </fieldset>

    {!detail ? <>
      {!shelves ? <><fieldset><legend>Measures</legend>
        <div className="dataset-measure-list">
          {fields.measures.map((measure) => {
            const suggested = measure.status !== 'approved';
            return <label key={measure.qualifiedId} className={suggested ? 'is-suggested' : undefined} title={suggested ? 'Suggested by ZLens and not yet reviewed. Approve it in the Dataset definition to use it.' : undefined}>
              <input type="checkbox" checked={selectedMeasures.has(measure.name) || selectedMeasures.has(measure.qualifiedId)} disabled={disabled || suggested} onChange={() => toggleMeasure(measure)} />
              <span><strong>{humanize(measure.name)}</strong><small>{measure.aggregation.replace(/_/g, ' ')}{measure.format?.kind ? ` · ${measure.format.kind}` : ''}</small></span>
              {suggested ? <em className="dataset-field-badge">Suggested · needs review</em> : null}
            </label>;
          })}
        </div>
        {!fields.measures.some((measure) => measure.status === 'approved') ? <small className="dataset-builder-error">This Dataset has no approved measure yet.</small> : null}
      </fieldset>

      <div className="dataset-editor-row">
        <label><span>Group by</span><select value={grouped?.name ?? ''} disabled={disabled} onChange={(event) => changeGroup(event.target.value)}>
          <option value="">No grouping</option>
          {fields.groupable.map((field) => <option key={field.qualifiedId} value={field.name} disabled={field.status !== 'approved' || (Boolean(query.comparison) && field.name === query.comparison?.timeField)}>{humanize(field.name)}{field.status !== 'approved' ? ' (suggested, needs review)' : ''}</option>)}
        </select></label>
        {grouped?.role === 'time' ? <label><span>Time grain</span><select value={groupDimension?.timeGrain ?? grouped.time?.grains[0] ?? ''} disabled={disabled} onChange={(event) => changeGrain(event.target.value)}>
          {(grouped.time?.grains ?? []).map((grain) => <option key={grain} value={grain}>{humanize(grain)}</option>)}
        </select></label> : null}
      </div></> : null}

      {!query.comparison ? <div className="dataset-editor-row dataset-sort-row">
        <label><span>Sort by</span><select value={primarySort?.alias ?? ''} disabled={disabled || outputs.length === 0} onChange={(event) => changeSort(event.target.value, primarySort?.direction ?? 'desc')}>
          <option value="">Source order</option>
          {outputs.map((output) => <option key={output.alias} value={output.alias}>{humanize(output.alias)}</option>)}
        </select></label>
        <button type="button" className="dataset-sort-direction" disabled={disabled || !primarySort} aria-label={primarySort?.direction === 'asc' ? 'Sorted ascending, switch to descending' : 'Sorted descending, switch to ascending'} onClick={() => primarySort && changeSort(primarySort.alias, primarySort.direction === 'asc' ? 'desc' : 'asc')}>
          {primarySort?.direction === 'asc' ? <><ArrowUp size={12} /> Ascending</> : <><ArrowDown size={12} /> Descending</>}
        </button>
        <label><span>{query.dimensions.length && primarySort ? 'Show top' : 'Row limit'} <small>Optional</small></span><input type="number" min={1} max={10000} value={typeof query.limit === 'number' ? String(query.limit) : ''} placeholder="All" disabled={disabled} onChange={(event) => changeLimit(event.target.value)} /></label>
      </div> : null}

      <fieldset className="dataset-comparison-builder" aria-label="Compare periods"><legend>Compare periods</legend>
        <label className="dataset-comparison-toggle"><input type="checkbox" checked={comparisonOpen} disabled={disabled || (!comparisonTimeFields.length && !query.comparison)} onChange={(event) => {
          if (!event.target.checked) { removeComparison(); return; }
          setComparisonOpen(true);
          setComparisonDraft(datasetComparisonDraftFromQuery(descriptor, query.comparison));
        }} /><span><strong>Compare two calendar periods</strong><small>{comparisonTimeFields.length ? 'Shows current, prior, difference, and change together. It uses a Table or chart.' : 'This Dataset does not declare a supported comparison time field.'}</small></span></label>
        {comparisonOpen ? <div className="dataset-comparison-fields">
          <label><span>Time field</span><select value={comparisonDraft.timeField} disabled={disabled || !comparisonTimeFields.length} onChange={(event) => {
            const timeField = event.target.value;
            const next = comparisonTimeFields.find((field) => field.name === timeField);
            setComparisonDraft((current) => ({
              ...current,
              timeField,
              grain: next?.time?.grains.find((grain) => grain.toLowerCase() === current.grain.toLowerCase())
                ?? next?.time?.grains.find((grain) => COMPARISON_GRAINS.includes(grain.toLowerCase()))
                ?? current.grain,
            }));
          }}>{comparisonTimeFields.map((field) => <option key={field.qualifiedId} value={field.name}>{humanize(field.name)}</option>)}</select></label>
          <label><span>Calendar grain</span><select value={comparisonDraft.grain} disabled={disabled} onChange={(event) => setComparisonDraft((current) => ({ ...current, grain: event.target.value }))}>{(comparisonTimeFields.find((field) => field.name === comparisonDraft.timeField)?.time?.grains ?? []).filter((grain) => COMPARISON_GRAINS.includes(grain.toLowerCase())).map((grain) => <option key={grain} value={grain}>{humanize(grain)}</option>)}</select></label>
          <div className="dataset-comparison-periods">
            <label><span>Current period starts</span><input type="date" value={comparisonDraft.baseStart} disabled={disabled} onChange={(event) => setComparisonDraft((current) => ({ ...current, baseStart: event.target.value }))} /></label>
            <label><span>Current period ends before</span><input type="date" value={comparisonDraft.baseEnd} disabled={disabled} onChange={(event) => setComparisonDraft((current) => ({ ...current, baseEnd: event.target.value }))} /></label>
            <label><span>Compare with period starting</span><input type="date" value={comparisonDraft.comparisonStart} disabled={disabled} onChange={(event) => setComparisonDraft((current) => ({ ...current, comparisonStart: event.target.value }))} /></label>
            <label><span>Compare with period ending before</span><input type="date" value={comparisonDraft.comparisonEnd} disabled={disabled} onChange={(event) => setComparisonDraft((current) => ({ ...current, comparisonEnd: event.target.value }))} /></label>
          </div>
          <details className="dataset-comparison-advanced"><summary>Advanced period settings</summary>
            <small>Defaults come from the Dataset. Change them only when the governed calendar needs it.</small>
            <label><span>Time role</span><select value={comparisonDraft.timeRole} disabled={disabled} onChange={(event) => setComparisonDraft((current) => ({ ...current, timeRole: event.target.value }))}><option value="event_time">Event time</option><option value="reporting_time">Reporting time</option></select></label>
            <label><span>Time zone</span><input value={comparisonDraft.timezone} disabled={disabled} onChange={(event) => setComparisonDraft((current) => ({ ...current, timezone: event.target.value }))} aria-label="Comparison time zone" /></label>
            <label><span>Calendar</span><select value={comparisonDraft.calendarId} disabled><option value="calendar:gregorian">Gregorian calendar</option></select></label>
            <label><span>Completeness</span><select value={comparisonDraft.completenessPolicy} disabled={disabled} onChange={(event) => setComparisonDraft((current) => ({ ...current, completenessPolicy: event.target.value as DatasetComparisonDraft['completenessPolicy'] }))}><option value="closed_period">Closed period</option><option value="latest_complete">Latest complete</option><option value="partial_current">Partial current</option></select></label>
          </details>
          {comparisonResult?.status === 'ready' ? <small className="dataset-comparison-summary">{comparisonResult.summary}</small> : null}
          <button type="button" disabled={disabled || comparisonResult?.status !== 'ready'} onClick={applyComparison}>Apply comparison</button>
        </div> : null}
        {query.comparison ? <small className="dataset-comparison-summary">Applied: {datasetComparisonSummary(query.comparison)}</small> : null}
      </fieldset>
    </> : <fieldset className="dataset-detail-columns"><legend>Row detail columns</legend>
      <small>Live source rows, ordered by the Dataset key. ZLens rechecks the key on every run.</small>
      <div>{fields.filterable.map((field) => <label key={field.qualifiedId}><input type="checkbox" checked={(query.detailColumns ?? []).includes(field.name)} disabled={disabled} onChange={() => toggleDetailColumn(field)} /><span>{humanize(field.name)}</span><em>{field.role}</em></label>)}</div>
      <label className="dataset-detail-limit"><span>Maximum rows</span><input type="number" min={1} max={10000} value={typeof query.limit === 'number' ? query.limit : 100} disabled={disabled} onChange={(event) => change({ ...query, limit: Number(event.target.value) })} /></label>
    </fieldset>}

    <fieldset className="dataset-filter-builder"><legend>Row filters</legend>
      <small>Apply to source rows before anything is aggregated.</small>
      <div>
        <select value={filterField} disabled={disabled || !fields.filterable.length} aria-label="Filter field" onChange={(event) => { const next = event.target.value; setFilterField(next); setFilterOp(filterOperatorsFor(fields.filterable.find((field) => field.name === next))[0] ?? 'eq'); }}>{fields.filterable.map((field) => <option key={field.qualifiedId} value={field.name}>{humanize(field.name)}</option>)}</select>
        <select value={filterOp} disabled={disabled} aria-label="Filter operator" onChange={(event) => setFilterOp(event.target.value as TileFilterOperator)}>{filterOperatorsFor(filterFieldEntry).map((operator) => <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>)}</select>
      </div>
      <div>
        <input value={filterValue} disabled={disabled} aria-label="Filter value" onChange={(event) => setFilterValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addFilter(); } }} placeholder={filterOp === 'between' ? 'Start, end' : filterOp === 'in' || filterOp === 'not_in' ? 'Values, comma separated' : 'Value'} />
        <button type="button" disabled={disabled || !filterField || !filterValue.trim()} onClick={addFilter}><Plus size={12} /> Add filter</button>
      </div>
      {query.filters?.length ? <div className="dataset-filter-chips">{query.filters.map((filter, index) => <button key={`${filter.field}-${filter.op}-${index}`} type="button" disabled={disabled} title="Remove filter" onClick={() => { const next = query.filters?.filter((_, candidate) => candidate !== index) ?? []; const { filters: _filters, ...rest } = query; change(next.length ? { ...rest, filters: next } : rest); }}>{humanize(filter.field)} {OPERATOR_LABELS[filter.op]} {filter.values?.map(String).join(', ')} <X size={11} /></button>)}</div> : null}
    </fieldset>

    {!detail && descriptor.operations.includes('having') ? <fieldset className="dataset-filter-builder" aria-label="Filter totals"><legend>Filter totals</legend>
      <small>Applies after the selected measures are aggregated. It never changes the source-row filter.</small>
      <div>
        <select value={havingMeasure} disabled={disabled || !query.measures.length} aria-label="Total to filter" onChange={(event) => setHavingMeasure(event.target.value)}>{query.measures.map((measure) => <option key={measure.measure} value={measure.measure}>{humanize(measure.measure)}</option>)}</select>
        <select value={havingOp} disabled={disabled} aria-label="Total operator" onChange={(event) => setHavingOp(event.target.value as TileFilterOperator)}>{HAVING_OPERATORS.map((operator) => <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>)}</select>
      </div>
      <div>
        <input value={havingValue} disabled={disabled} aria-label="Total value" onChange={(event) => setHavingValue(event.target.value)} placeholder={havingOp === 'between' ? 'Lower, upper' : 'Total'} />
        <button type="button" disabled={disabled || !havingMeasure || !havingValue.trim()} onClick={addHaving}><Plus size={12} /> Add total filter</button>
      </div>
      {query.having?.length ? <div className="dataset-filter-chips">{query.having.map((filter, index) => <button key={`${filter.field}-${filter.op}-${index}`} type="button" disabled={disabled} title="Remove total filter" onClick={() => { const next = query.having?.filter((_, candidate) => candidate !== index) ?? []; const { having: _having, ...rest } = query; change(next.length ? { ...rest, having: next } : rest); }}>{humanize(filter.field)} {OPERATOR_LABELS[filter.op]} {filter.values?.map(String).join(', ')} <X size={11} /></button>)}</div> : null}
    </fieldset> : null}

    {error ? <small className="dataset-builder-error" role="alert">{error}</small> : null}
  </div>;
}

const COMPARISON_GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
const HAVING_OPERATORS: TileFilterOperator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between'];
const OPERATOR_LABELS: Record<TileFilterOperator, string> = {
  eq: 'is', neq: 'is not', in: 'is one of', not_in: 'is not one of', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between', contains: 'contains',
};

/** Fields grouped by what the editor offers them for. Suggested entries are kept, labelled. */
export function datasetEditorFields(descriptor: DatasetDescriptor): {
  measures: DatasetMeasureField[];
  groupable: DatasetPhysicalField[];
  filterable: DatasetPhysicalField[];
} {
  const byStatus = <T extends { status: string }>(items: T[]) => [...items].sort((left, right) => Number(left.status !== 'approved') - Number(right.status !== 'approved'));
  const physical = descriptor.fields.filter((field): field is DatasetPhysicalField => field.kind === 'physical');
  return {
    measures: byStatus(descriptor.fields.filter((field): field is DatasetMeasureField => field.kind === 'measure')),
    groupable: byStatus(physical.filter((field) => ['dimension', 'key', 'time', 'attribute'].includes(field.role))),
    filterable: physical.filter((field) => field.status === 'approved'),
  };
}

function filterOperatorsFor(field?: DatasetPhysicalField): TileFilterOperator[] {
  if (!field) return ['eq'];
  if (field.type === 'string') return ['eq', 'neq', 'in', 'not_in', 'contains'];
  if (field.type === 'boolean') return ['eq', 'neq'];
  return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in'];
}

/** Parse typed input for a filter; null when it does not fit the type or operator. */
export function parseFilterValues(type: DatasetPhysicalField['type'] | 'number', operator: TileFilterOperator, raw: string): unknown[] | null {
  const many = operator === 'in' || operator === 'not_in' || operator === 'between';
  const fragments = many ? raw.split(',').map((value) => value.trim()).filter(Boolean) : [raw.trim()];
  if (!fragments.length || !fragments[0] || (operator === 'between' && fragments.length !== 2)) return null;
  const values = fragments.map((value): unknown => {
    if (type === 'number') {
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    }
    if (type === 'boolean') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
      return undefined;
    }
    return value;
  });
  return values.some((value) => value === undefined) ? null : values;
}

function withOptional(query: TileQuery, parts: { having?: TileQuery['having']; orderBy?: TileQuery['orderBy'] }): TileQuery {
  const { having: _having, orderBy: _orderBy, ...rest } = query;
  const having = 'having' in parts ? parts.having : query.having;
  const orderBy = 'orderBy' in parts ? parts.orderBy : query.orderBy;
  return { ...rest, ...(having?.length ? { having } : {}), ...(orderBy?.length ? { orderBy } : {}) };
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
