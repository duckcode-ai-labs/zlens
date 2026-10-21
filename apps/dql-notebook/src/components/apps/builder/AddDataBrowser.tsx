import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronDown, Database, FileText, Hash, MoreHorizontal, Plus, Search, ShieldCheck, Table2, X } from 'lucide-react';
import {
  api,
  type AppBlockRecommendation,
  type AppSourceCandidatePage,
  type AppStudioBuildDraft,
  type WarehouseTableSummary,
} from '../../../api/client';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import { groupDatasetFields } from './field-query';
import { humanize, messageOf } from './studio-ui';
import { TableDatasetDialog } from './TableDatasetDialog';
import { SavedQueryFieldsDialog } from './SavedQueryFieldsDialog';
import { appDataSameNameOrigins } from './app-data-names';
import {
  ADD_DATA_KINDS,
  MAKE_ROW_LEVEL_HINT,
  SAVED_QUERY_FIELDS_NOTE,
  TABLE_BECOMES_DATASET_HINT,
  addDataCatalogRequest,
  addDataDomainChips,
  addDataKindOf,
  addNeedsReviewChoice,
  canMakeRowLevel,
  datasetSampleQuery,
  filterAddDataCatalog,
  isAddedToApp,
  needsReview,
  savedQueryNeedsFields,
  sourceOriginLabel,
  tilesUsingSource,
  trustLabel,
  type AddDataKind,
} from './app-data';

type DraftSources = AppStudioBuildDraft['sources'];
type SourcePolicy = AppStudioBuildDraft['sourcePolicy'];
type CatalogLoader = (input: ReturnType<typeof addDataCatalogRequest>, signal: AbortSignal) => Promise<AppSourceCandidatePage>;
type TablesLoader = () => Promise<{ ok: boolean; tables: WarehouseTableSummary[]; error?: string }>;
type FieldsReader = (sourceId: string) => Promise<{ ok: boolean; descriptor?: DatasetDescriptor; error?: string }>;

export interface AddDataBrowserProps {
  draftId: string;
  /** The App's data (draft sources) and pages, to mark rows Added and count the tiles that use one. */
  draft: Pick<AppStudioBuildDraft, 'sources' | 'pages'>;
  sourcePolicy: SourcePolicy;
  /** The App's domain; the domain chips start on it. */
  appDomain?: string;
  /** The project's domains from the Domains page. */
  domainOptions?: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
  disabled?: boolean;
  /** The filter chip the list opens on (All by default). */
  initialKind?: AddDataKind;
  /** First rows to show before the catalog answers (and in tests). */
  initialItems?: AppBlockRecommendation[];
  /** Database tables to show before the database answers (and in tests). */
  initialTables?: WarehouseTableSummary[];
  loadCatalog?: CatalogLoader;
  loadTables?: TablesLoader;
  /** Read a saved query's result columns as fields (design D1). */
  readFields?: FieldsReader;
  /** Connect one source to the App. Resolves to false when it was not added. */
  onAdd: (sourceId: string, options: { allowReview: boolean }) => Promise<boolean>;
  onRemove: (sourceId: string) => void;
  onChangePolicy: (policy: SourcePolicy) => void;
  /** Field-based tiles are on: saved queries show fields and can be made row-level (default on). */
  fieldsEnabled?: boolean;
  /** A saved query was made row-level; the App refreshes its copy when the saved query is already in it. */
  onFieldsAdded?: (sourceId: string, status: 'certified' | 'review' | 'draft') => void;
}

/**
 * Add data (design D1, "everything you add has fields"): one list of the data
 * an App can use. Each row says where it comes from (a table, a saved query or
 * Metrics), whether it is certified, its domain, and shows its fields when
 * opened; a saved query's fields come from its result, with no review step.
 * Chips narrow the list to one kind. A database table becomes a Dataset after
 * ZLens checks it once. Used as the Data step before the canvas and as the
 * canvas **+ Add data** dialog.
 */
export function AddDataBrowser({
  draftId,
  draft,
  sourcePolicy,
  appDomain,
  domainOptions = [],
  disabled = false,
  initialKind = 'all',
  initialItems = [],
  initialTables,
  loadCatalog,
  loadTables,
  readFields,
  onAdd,
  onRemove,
  onChangePolicy,
  fieldsEnabled = true,
  onFieldsAdded,
}: AddDataBrowserProps): JSX.Element {
  const [kind, setKind] = useState<AddDataKind>(initialKind);
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState(appDomain ?? '');
  const [items, setItems] = useState<AppBlockRecommendation[]>(initialItems);
  const [catalogDomains, setCatalogDomains] = useState<Record<string, number>>({});
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  // The catalog loads on open: start loading so the list never flashes "No certified data yet / 0".
  const [loading, setLoading] = useState(!initialItems.length);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [tables, setTables] = useState<WarehouseTableSummary[] | null>(initialTables ?? null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [checkingTable, setCheckingTable] = useState<WarehouseTableSummary | null>(null);
  const [rowLevelFor, setRowLevelFor] = useState<AppBlockRecommendation | null>(null);
  /** Saved queries whose result columns are being read, or could not be. */
  const [fieldReads, setFieldReads] = useState<Record<string, { state: 'reading' } | { state: 'failed'; error: string }>>({});
  const load = useRef<CatalogLoader>(loadCatalog ?? ((input, signal) => api.listAppSourceCandidates(draftId, input, signal)));
  load.current = loadCatalog ?? ((input, signal) => api.listAppSourceCandidates(draftId, input, signal));
  const read = useRef<FieldsReader>(readFields ?? ((sourceId) => api.readSavedQueryFields(sourceId)));
  read.current = readFields ?? ((sourceId) => api.readSavedQueryFields(sourceId));

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void load.current(addDataCatalogRequest({ query, domain }), controller.signal).then((page) => {
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setCatalogDomains((current) => ({ ...current, ...page.facets?.domains }));
      }).catch((cause) => {
        if (active && !controller.signal.aborted) setError(messageOf(cause));
      }).finally(() => { if (active) setLoading(false); });
    }, query ? 180 : 0);
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, domain, sourcePolicy, reloadNonce]);

  useEffect(() => {
    if (tables) return undefined;
    let active = true;
    void (loadTables ?? (() => api.listWarehouseTables()))().then((response) => {
      if (!active) return;
      if (response.ok) setTables(response.tables);
      else setTablesError(response.error ?? 'ZLens could not read the tables in your database.');
    }).catch((cause) => { if (active) setTablesError(messageOf(cause)); });
    return () => { active = false; };
  }, [tables]);

  const loadMore = () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    const controller = new AbortController();
    void load.current(addDataCatalogRequest({ query, domain, cursor: nextCursor }), controller.signal).then((page) => {
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    }).catch((cause) => setError(messageOf(cause))).finally(() => setLoading(false));
  };

  const chips = useMemo(() => addDataDomainChips(domainOptions, catalogDomains, appDomain), [domainOptions, catalogDomains, appDomain]);
  const rows = useMemo(() => filterAddDataCatalog(items, kind), [items, kind]);
  const sameNames = useMemo(() => appDataSameNameOrigins(items), [items]);
  const tableNeedle = query.trim().toLowerCase().replace(/[\s_]+/g, '');
  // Database tables have no domain: a domain chip shows the catalog only.
  const shownTables = (kind === 'all' || kind === 'tables') && !domain
    ? (tables ?? []).filter((table) => !tableNeedle || `${table.schema ?? ''}.${table.name}`.toLowerCase().replace(/[\s_]+/g, '').includes(tableNeedle)).slice(0, 200)
    : [];
  const counts = useMemo(() => {
    const value: Record<AddDataKind, number> = { all: items.length + (tables?.length ?? 0), tables: tables?.length ?? 0, queries: 0, metrics: 0 };
    for (const item of items) value[addDataKindOf(item)] += 1;
    return value;
  }, [items, tables]);
  const noCertifiedData = !loading && !error && !query.trim() && kind !== 'tables' && items.every((item) => needsReview(item));

  const add = async (item: AppBlockRecommendation, allowReview: boolean) => {
    const sourceId = item.sourceId ?? item.id;
    setAddingId(sourceId);
    try {
      const added = await onAdd(sourceId, { allowReview });
      if (added) setHighlightId(sourceId);
    } finally {
      setAddingId(null);
    }
  };

  /** Open a row; a saved query whose columns were never read reads them now. */
  const toggle = (item: AppBlockRecommendation) => {
    const sourceId = item.sourceId ?? item.id;
    const opening = expandedId !== sourceId;
    setExpandedId(opening ? sourceId : null);
    if (!opening || !fieldsEnabled || !savedQueryNeedsFields(item) || fieldReads[sourceId]) return;
    setFieldReads((current) => ({ ...current, [sourceId]: { state: 'reading' } }));
    void read.current(sourceId).then((response) => {
      if (response.ok && response.descriptor) {
        setItems((current) => current.map((candidate) => ((candidate.sourceId ?? candidate.id) === sourceId && candidate.capabilities
          ? { ...candidate, capabilities: { ...candidate.capabilities, dataset: response.descriptor } }
          : candidate)));
        setFieldReads((current) => {
          const next = { ...current };
          delete next[sourceId];
          return next;
        });
      } else {
        setFieldReads((current) => ({ ...current, [sourceId]: { state: 'failed', error: response.error ?? 'ZLens could not read its columns.' } }));
      }
    }).catch((cause) => setFieldReads((current) => ({ ...current, [sourceId]: { state: 'failed', error: messageOf(cause) } })));
  };

  const tableCreated = async (sourceId: string | undefined) => {
    setCheckingTable(null);
    setQuery('');
    setReloadNonce((current) => current + 1);
    if (!sourceId) return;
    setAddingId(sourceId);
    try {
      if (await onAdd(sourceId, { allowReview: false })) {
        setHighlightId(sourceId);
        setExpandedId(sourceId);
      }
    } finally {
      setAddingId(null);
    }
  };

  const madeRowLevel = (sourceId: string, status: 'certified' | 'review' | 'draft') => {
    setRowLevelFor(null);
    setQuery('');
    setReloadNonce((current) => current + 1);
    setHighlightId(sourceId);
    setExpandedId(sourceId);
    onFieldsAdded?.(sourceId, status);
  };

  const searchLabel = 'Search tables, saved queries and Metrics';

  return <section className="add-data-browser" aria-label="Add data">
    <div className="add-data-controls">
      <label className="add-data-search">
        <Search size={15} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
        {query ? <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button> : null}
      </label>
      <div className="add-data-kinds" role="group" aria-label="Kind of data">
        {ADD_DATA_KINDS.map(([id, label]) => <button key={id} type="button" aria-pressed={kind === id} className={kind === id ? 'on' : ''} onClick={() => setKind(id)}>{label}{!loading && (id !== 'all' && id !== 'tables' ? true : tables !== null) ? <small>{counts[id]}</small> : null}</button>)}
      </div>
      <div className="add-data-domains" role="group" aria-label="Domain">
        <button type="button" aria-pressed={domain === ''} className={domain === '' ? 'on' : ''} onClick={() => setDomain('')}>All domains</button>
        {chips.map((chip) => <button key={chip.value} type="button" aria-pressed={domain === chip.value} className={domain === chip.value ? 'on' : ''} onClick={() => setDomain(chip.value)}>{chip.label}</button>)}
      </div>
      <p className="add-data-rule"><ShieldCheck size={13} aria-hidden="true" /><span>Data rule: <strong>{sourcePolicy === 'governed_only' ? 'Only certified data' : 'Also allow data that needs review'}</strong></span><button type="button" className="link" disabled={disabled} onClick={() => onChangePolicy(sourcePolicy === 'governed_only' ? 'include_review_required' : 'governed_only')}>Change</button></p>
    </div>

    <div className="add-data-list" role="list" aria-label="Data you can add">
      {noCertifiedData ? <div className="add-data-empty" role="status">
        <Database size={18} aria-hidden="true" />
        <div><strong>No certified data yet.</strong><p>Start from a database table, or allow data that needs review.</p></div>
        <span className="add-data-empty-actions">
          <button type="button" className="primary" onClick={() => setKind('tables')}><Table2 size={13} /> Start from a database table</button>
          {sourcePolicy === 'governed_only' ? <button type="button" disabled={disabled} onClick={() => onChangePolicy('include_review_required')}>Allow data that needs review</button> : null}
        </span>
      </div> : null}
      {loading && !rows.length ? <p className="add-data-muted" role="status">Finding data…</p> : null}
      {error ? <p className="add-data-error" role="alert">{error}</p> : null}
      {rows.map((item) => {
        const sourceId = item.sourceId ?? item.id;
        return <AddDataRow
          key={item.id}
          item={item}
          draft={draft}
          sourcePolicy={sourcePolicy}
          disabled={disabled}
          expanded={expandedId === sourceId}
          highlighted={highlightId === sourceId}
          adding={addingId === sourceId}
          fieldsEnabled={fieldsEnabled}
          fieldRead={fieldReads[sourceId]}
          onToggle={() => toggle(item)}
          onAdd={(allowReview) => void add(item, allowReview)}
          onRemove={() => onRemove(sourceId)}
          sameNameOrigin={sameNames.get(item.id)}
          {...(fieldsEnabled && canMakeRowLevel(item) ? { onMakeRowLevel: () => setRowLevelFor(item) } : {})}
        />;
      })}
      {nextCursor && kind !== 'tables' ? <button type="button" className="add-data-more" disabled={loading} onClick={loadMore}>{loading ? 'Loading…' : 'Show more'}</button> : null}
      {shownTables.length ? <p className="add-data-hint"><Table2 size={13} aria-hidden="true" /> {TABLE_BECOMES_DATASET_HINT}</p> : null}
      {shownTables.map((table) => <article key={table.id} className="add-data-row table" role="listitem" data-table-id={table.id}>
        <div className="add-data-summary static">
          <span className="add-data-mark"><Table2 size={14} /></span>
          <div><strong>{table.name}</strong><small>{['Table', 'Not checked yet', table.schema, `${table.columnCount} columns`, table.rowCountEstimate !== undefined ? `~${table.rowCountEstimate.toLocaleString()} rows` : ''].filter(Boolean).join(' · ')}</small></div>
        </div>
        <div className="add-data-action"><button type="button" disabled={disabled} onClick={() => setCheckingTable(table)} aria-label={`Check ${table.name} and add it as a Dataset`}><Plus size={13} /> Check and add</button></div>
      </article>)}
      {(kind === 'all' || kind === 'tables') && !domain ? <>
        {tablesError ? <p className="add-data-error" role="alert">{tablesError}</p> : null}
        {kind === 'tables' && !tables && !tablesError ? <p className="add-data-muted" role="status">Reading your database…</p> : null}
        {kind === 'tables' && tables && !tables.length ? <p className="add-data-muted">No tables found. Check the connection in Settings.</p> : null}
      </> : null}
      {!loading && !error && !noCertifiedData && !rows.length && !shownTables.length && (kind !== 'tables' || tables?.length)
        ? <p className="add-data-muted">{query.trim() || domain ? 'Nothing matches. Clear the search or choose All.' : kind === 'queries' ? 'No saved queries yet.' : kind === 'metrics' ? 'No Metrics yet.' : 'No data yet.'}</p>
        : null}
    </div>
    {checkingTable ? <TableDatasetDialog
      initialTable={checkingTable}
      {...(domain || appDomain ? { domain: domain || appDomain } : {})}
      onClose={() => setCheckingTable(null)}
      onCreated={(sourceId) => void tableCreated(sourceId)}
    /> : null}
    {rowLevelFor ? <SavedQueryFieldsDialog
      sourceId={rowLevelFor.sourceId ?? rowLevelFor.id}
      name={rowLevelFor.name}
      onClose={() => setRowLevelFor(null)}
      onAdded={madeRowLevel}
    /> : null}
  </section>;
}

function AddDataRow({
  item,
  draft,
  sourcePolicy,
  disabled,
  expanded,
  highlighted,
  adding,
  fieldsEnabled,
  fieldRead,
  onToggle,
  onAdd,
  onRemove,
  onMakeRowLevel,
  sameNameOrigin,
}: {
  item: AppBlockRecommendation;
  draft: Pick<AppStudioBuildDraft, 'sources' | 'pages'>;
  sourcePolicy: SourcePolicy;
  disabled: boolean;
  expanded: boolean;
  highlighted: boolean;
  adding: boolean;
  fieldsEnabled: boolean;
  fieldRead?: { state: 'reading' } | { state: 'failed'; error: string };
  onToggle: () => void;
  onAdd: (allowReview: boolean) => void;
  onRemove: () => void;
  /** A saved query: open "Make row-level". */
  onMakeRowLevel?: () => void;
  /** Told apart from another item with the same name ("Table" or "Metrics"). */
  sameNameOrigin?: string;
}): JSX.Element {
  const sourceId = item.sourceId ?? item.id;
  const added = isAddedToApp(draft.sources, item);
  const reviewChoice = addNeedsReviewChoice(item, sourcePolicy);
  const certified = !needsReview(item);
  const origin = sourceOriginLabel(item);
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = [origin, trustLabel(certified ? 'certified' : 'review'), item.domain && item.domain !== 'Unassigned' ? humanize(item.domain) : '', item.owner ?? ''].filter(Boolean).join(' · ');
  return <article className={`add-data-row ${highlighted ? 'highlight' : ''} ${added ? 'added' : ''}`} role="listitem" data-source-id={sourceId} data-origin={origin}>
    <button type="button" className="add-data-summary" aria-expanded={expanded} onClick={onToggle} aria-label={`${expanded ? 'Hide' : 'Show'} details for ${humanize(item.name)}`}>
      <span className={`add-data-mark ${certified ? 'certified' : 'review'}`}>{certified ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
      <div><strong title={item.name}>{humanize(item.name)}{sameNameOrigin ? <em className="same-name-origin"> · {sameNameOrigin}</em> : null}</strong><small>{meta}</small>{item.description ? <p>{item.description}</p> : null}</div>
      <ChevronDown size={14} className="chevron" aria-hidden="true" />
    </button>
    <div className="add-data-action">
      {added
        ? <><span className="add-data-added"><Check size={13} /> Added</span><RemoveDataButton name={humanize(item.name)} tileCount={tilesUsingSource(draft, sourceId).length} disabled={disabled} onRemove={onRemove} /></>
        : <button type="button" className={reviewChoice ? 'review' : 'primary'} disabled={disabled || adding} onClick={() => onAdd(reviewChoice)} aria-label={`${reviewChoice ? 'Allow data that needs review and add' : 'Add to App'}: ${humanize(item.name)}`}>{adding ? 'Adding…' : reviewChoice ? 'Allow data that needs review & add' : <><Plus size={13} /> Add to App</>}</button>}
      {onMakeRowLevel ? <span className="add-data-more-menu">
        <button type="button" className="more" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`More for ${humanize(item.name)}`} disabled={disabled} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={14} /></button>
        {menuOpen ? <span className="add-data-menu" role="menu" aria-label={`More for ${humanize(item.name)}`}>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onMakeRowLevel(); }}><strong>Make row-level</strong><small>{MAKE_ROW_LEVEL_HINT}</small></button>
        </span> : null}
      </span> : null}
    </div>
    {expanded ? <AddDataDetail item={item} fieldsEnabled={fieldsEnabled} {...(fieldRead ? { fieldRead } : {})} /> : null}
  </article>;
}

/** Remove, asking first when tiles use the data (they are removed with it). */
export function RemoveDataButton({ name, tileCount, disabled, onRemove }: { name: string; tileCount: number; disabled?: boolean; onRemove: () => void }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return <span className="add-data-confirm" role="alertdialog" aria-label={`Remove ${name}`}>
      <small>{tileCount} {tileCount === 1 ? 'tile uses' : 'tiles use'} this data and will be removed.</small>
      <button type="button" className="danger" disabled={disabled} onClick={() => { setConfirming(false); onRemove(); }}>Remove</button>
      <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
    </span>;
  }
  return <button type="button" className="remove" disabled={disabled} onClick={() => (tileCount > 0 ? setConfirming(true) : onRemove())} aria-label={`Remove ${name} from this App`}>Remove</button>;
}

function AddDataDetail({ item, fieldsEnabled, fieldRead }: { item: AppBlockRecommendation; fieldsEnabled: boolean; fieldRead?: { state: 'reading' } | { state: 'failed'; error: string } }): JSX.Element {
  const descriptor = item.capabilities?.dataset as DatasetDescriptor | undefined;
  const groups = descriptor ? groupDatasetFields(descriptor) : null;
  const sampleQuery = datasetSampleQuery(descriptor);
  const [sample, setSample] = useState<{ rows: Array<Record<string, unknown>>; error?: string } | null>(null);
  const [sampling, setSampling] = useState(false);
  const showSample = () => {
    if (!sampleQuery || sampling) return;
    setSampling(true);
    void api.previewDatasetTileQuery({ sourceId: item.sourceId ?? item.id, query: sampleQuery }).then((result) => {
      setSample(result.ok ? { rows: result.result?.rows?.slice(0, 10) ?? [] } : { rows: [], error: result.error ?? 'These rows could not be read.' });
    }).finally(() => setSampling(false));
  };
  const outputs = item.capabilities?.outputs ?? [];
  const columns = sample?.rows.length ? Object.keys(sample.rows[0]!) : [];
  return <div className="add-data-detail">
    {groups ? <div className="add-data-fields">
      {groups.measures.length ? <section><h4>Measures</h4><p>{groups.measures.map((field) => <span key={field.name} className="chip"><span className="sigma" aria-hidden="true">Σ</span> {humanize(field.name)}</span>)}</p></section> : null}
      {groups.time.length ? <section><h4>Time</h4><p>{groups.time.map((field) => <span key={field.name} className="chip"><CalendarDays size={11} aria-hidden="true" /> {humanize(field.name)}</span>)}</p></section> : null}
      {groups.dimensions.length ? <section><h4>Dimensions</h4><p>{groups.dimensions.map((field) => <span key={field.name} className="chip">{field.kind === 'physical' && field.role === 'key' ? <Hash size={11} aria-hidden="true" /> : null} {humanize(field.name)}</span>)}</p></section> : null}
      {groups.review.length ? <section><h4>Needs review</h4><p>{groups.review.map((field) => <span key={field.name} className="chip muted">{humanize(field.name)}</span>)}</p></section> : null}
      {descriptor?.result ? <small className="add-data-muted">{SAVED_QUERY_FIELDS_NOTE}</small> : null}
    </div> : <div className="add-data-fields">
      <section><h4>Columns</h4><p>{outputs.length ? outputs.map((column) => <span key={column} className="chip">{humanize(column)}</span>) : <small>No columns listed yet.</small>}</p></section>
      {fieldRead?.state === 'reading' ? <small className="add-data-muted" role="status">Reading its columns…</small> : null}
      {fieldRead?.state === 'failed' ? <small className="add-data-muted" role="status">ZLens couldn’t read its columns as fields: {fieldRead.error} You can still add it; it shows as it is (a table, chart or KPI).</small> : null}
      {!fieldsEnabled ? <small className="add-data-muted">It shows as it is: a table, chart or KPI.</small> : null}
    </div>}
    {sampleQuery ? <div className="add-data-sample">
      {!sample ? <button type="button" className="link" disabled={sampling} onClick={showSample}>{sampling ? 'Reading rows…' : 'Show 10 sample rows'}</button> : null}
      {sample?.error ? <p className="add-data-error" role="alert">{sample.error}</p> : null}
      {sample && !sample.error ? (sample.rows.length ? <div className="add-data-sample-table"><table><thead><tr>{columns.map((column) => <th key={column}>{humanize(column)}</th>)}</tr></thead><tbody>{sample.rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{formatSampleValue(row[column])}</td>)}</tr>)}</tbody></table></div> : <p className="add-data-muted">No rows.</p>) : null}
    </div> : null}
  </div>;
}

function formatSampleValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
