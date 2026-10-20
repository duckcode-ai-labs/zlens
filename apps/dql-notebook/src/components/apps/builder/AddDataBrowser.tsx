import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronDown, Database, FileText, Hash, Plus, Search, ShieldCheck, Table2, X } from 'lucide-react';
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
import {
  TABLE_BECOMES_DATASET_HINT,
  addDataCatalogRequest,
  addDataDomainChips,
  addNeedsReviewChoice,
  datasetSampleQuery,
  isAddedToApp,
  needsReview,
  sourceCatalogKindLabel,
  splitAddDataCatalog,
  tilesUsingSource,
  trustLabel,
  type AddDataTab,
} from './app-data';

type DraftSources = AppStudioBuildDraft['sources'];
type SourcePolicy = AppStudioBuildDraft['sourcePolicy'];
type CatalogLoader = (input: ReturnType<typeof addDataCatalogRequest>, signal: AbortSignal) => Promise<AppSourceCandidatePage>;

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
  initialTab?: AddDataTab;
  /** First rows to show before the catalog answers (and in tests). */
  initialItems?: AppBlockRecommendation[];
  loadCatalog?: CatalogLoader;
  /** Connect one source to the App. Resolves to false when it was not added. */
  onAdd: (sourceId: string, options: { allowReview: boolean }) => Promise<boolean>;
  onRemove: (sourceId: string) => void;
  onChangePolicy: (policy: SourcePolicy) => void;
  /** Field-based tiles are on, so a saved query can get fields (default on). */
  fieldsEnabled?: boolean;
  /** A saved query got fields; the App refreshes its copy when the saved query is already in it. */
  onFieldsAdded?: (sourceId: string, status: 'certified' | 'review' | 'draft') => void;
}

/**
 * Add data (design D3): one place to connect data to an App. Datasets and
 * Metrics have fields; saved queries are used as they are; a database table
 * becomes a Dataset after ZLens checks it once. Used as the Data step before
 * the canvas and as the canvas **+ Add data** dialog.
 */
export function AddDataBrowser({
  draftId,
  draft,
  sourcePolicy,
  appDomain,
  domainOptions = [],
  disabled = false,
  initialTab = 'datasets',
  initialItems = [],
  loadCatalog,
  onAdd,
  onRemove,
  onChangePolicy,
  fieldsEnabled = true,
  onFieldsAdded,
}: AddDataBrowserProps): JSX.Element {
  const [tab, setTab] = useState<AddDataTab>(initialTab);
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState(appDomain ?? '');
  const [items, setItems] = useState<AppBlockRecommendation[]>(initialItems);
  const [catalogDomains, setCatalogDomains] = useState<Record<string, number>>({});
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [tables, setTables] = useState<WarehouseTableSummary[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [checkingTable, setCheckingTable] = useState<WarehouseTableSummary | null>(null);
  const [addingFieldsTo, setAddingFieldsTo] = useState<AppBlockRecommendation | null>(null);
  const load = useRef<CatalogLoader>(loadCatalog ?? ((input, signal) => api.listAppSourceCandidates(draftId, input, signal)));
  load.current = loadCatalog ?? ((input, signal) => api.listAppSourceCandidates(draftId, input, signal));

  useEffect(() => {
    if (tab === 'tables') return;
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
  }, [query, domain, sourcePolicy, reloadNonce, tab === 'tables']);

  useEffect(() => {
    if (tab !== 'tables' || tables) return;
    let active = true;
    void api.listWarehouseTables().then((response) => {
      if (!active) return;
      if (response.ok) setTables(response.tables);
      else setTablesError(response.error ?? 'ZLens could not read the tables in your database.');
    });
    return () => { active = false; };
  }, [tab, tables]);

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
  const split = useMemo(() => splitAddDataCatalog(items), [items]);
  const rows = tab === 'queries' ? split.queries : split.datasets;
  const noCertifiedData = !loading && !error && !query.trim() && items.every((item) => needsReview(item));
  const tableNeedle = query.trim().toLowerCase();
  const shownTables = (tables ?? []).filter((table) => !tableNeedle || `${table.schema ?? ''}.${table.name}`.toLowerCase().includes(tableNeedle)).slice(0, 200);

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

  const tableCreated = async (sourceId: string | undefined) => {
    setCheckingTable(null);
    setTab('datasets');
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

  const fieldsAdded = (sourceId: string, status: 'certified' | 'review' | 'draft') => {
    setAddingFieldsTo(null);
    // It is a Dataset now: it lists with Datasets & Metrics, open on its fields.
    setTab('datasets');
    setQuery('');
    setReloadNonce((current) => current + 1);
    setHighlightId(sourceId);
    setExpandedId(sourceId);
    onFieldsAdded?.(sourceId, status);
  };

  const tabs: Array<[AddDataTab, string, number | null]> = [
    ['datasets', 'Datasets & Metrics', split.datasets.length],
    ['queries', 'Saved queries', split.queries.length],
    ['tables', 'Database tables', tables ? tables.length : null],
  ];
  const searchLabel = tab === 'tables' ? 'Search tables' : 'Search Datasets, Metrics and saved queries';

  return <section className="add-data-browser" aria-label="Add data">
    <div className="add-data-controls">
      <label className="add-data-search">
        <Search size={15} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
        {query ? <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button> : null}
      </label>
      {tab !== 'tables' ? <div className="add-data-domains" role="group" aria-label="Domain">
        <button type="button" aria-pressed={domain === ''} className={domain === '' ? 'on' : ''} onClick={() => setDomain('')}>All</button>
        {chips.map((chip) => <button key={chip.value} type="button" aria-pressed={domain === chip.value} className={domain === chip.value ? 'on' : ''} onClick={() => setDomain(chip.value)}>{chip.label}</button>)}
      </div> : null}
      <p className="add-data-rule"><ShieldCheck size={13} aria-hidden="true" /><span>Data rule: <strong>{sourcePolicy === 'governed_only' ? 'Only certified data' : 'Also allow data that needs review'}</strong></span><button type="button" className="link" disabled={disabled} onClick={() => onChangePolicy(sourcePolicy === 'governed_only' ? 'include_review_required' : 'governed_only')}>Change</button></p>
    </div>

    <div className="add-data-tabs" role="tablist" aria-label="Kind of data">
      {tabs.map(([id, label, count]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}{count !== null && id !== 'tables' && !loading ? <small>{count}</small> : null}</button>)}
    </div>

    {tab !== 'tables' ? <div className="add-data-list" role="tabpanel" aria-label={tab === 'queries' ? 'Saved queries' : 'Datasets & Metrics'}>
      {noCertifiedData ? <div className="add-data-empty" role="status">
        <Database size={18} aria-hidden="true" />
        <div><strong>No certified data yet.</strong><p>Start from a database table, or allow data that needs review.</p></div>
        <span className="add-data-empty-actions">
          <button type="button" className="primary" onClick={() => setTab('tables')}><Table2 size={13} /> Start from a database table</button>
          {sourcePolicy === 'governed_only' ? <button type="button" disabled={disabled} onClick={() => onChangePolicy('include_review_required')}>Allow data that needs review</button> : null}
        </span>
      </div> : null}
      {loading && !rows.length ? <p className="add-data-muted" role="status">Finding data…</p> : null}
      {error ? <p className="add-data-error" role="alert">{error}</p> : null}
      {!loading && !error && !rows.length && !noCertifiedData ? <p className="add-data-muted">{query.trim() || domain ? 'Nothing matches. Clear the search or choose All.' : tab === 'queries' ? 'No saved queries yet.' : 'No Datasets or Metrics yet.'}</p> : null}
      {rows.map((item) => <AddDataRow
        key={item.id}
        item={item}
        draft={draft}
        sourcePolicy={sourcePolicy}
        disabled={disabled}
        expanded={expandedId === (item.sourceId ?? item.id)}
        highlighted={highlightId === (item.sourceId ?? item.id)}
        adding={addingId === (item.sourceId ?? item.id)}
        onToggle={() => setExpandedId((current) => current === (item.sourceId ?? item.id) ? null : (item.sourceId ?? item.id))}
        onAdd={(allowReview) => void add(item, allowReview)}
        onRemove={() => onRemove(item.sourceId ?? item.id)}
        {...(fieldsEnabled && sourceCatalogKindLabel(item) === 'Saved query' ? { onAddFields: () => setAddingFieldsTo(item) } : {})}
      />)}
      {nextCursor ? <button type="button" className="add-data-more" disabled={loading} onClick={loadMore}>{loading ? 'Loading…' : 'Show more'}</button> : null}
    </div> : <div className="add-data-list" role="tabpanel" aria-label="Database tables">
      <p className="add-data-hint"><Table2 size={13} aria-hidden="true" /> {TABLE_BECOMES_DATASET_HINT}</p>
      {tablesError ? <p className="add-data-error" role="alert">{tablesError}</p> : null}
      {!tables && !tablesError ? <p className="add-data-muted" role="status">Reading your database…</p> : null}
      {tables && !tables.length ? <p className="add-data-muted">No tables found. Check the connection in Settings.</p> : null}
      {shownTables.map((table) => <article key={table.id} className="add-data-row table">
        <div className="add-data-summary static">
          <span className="add-data-mark"><Table2 size={14} /></span>
          <div><strong>{table.name}</strong><small>{['Database table', table.schema, `${table.columnCount} columns`, table.rowCountEstimate !== undefined ? `~${table.rowCountEstimate.toLocaleString()} rows` : ''].filter(Boolean).join(' · ')}</small></div>
        </div>
        <div className="add-data-action"><button type="button" disabled={disabled} onClick={() => setCheckingTable(table)} aria-label={`Check ${table.name} and add it as a Dataset`}><Plus size={13} /> Check and add</button></div>
      </article>)}
    </div>}
    {checkingTable ? <TableDatasetDialog
      initialTable={checkingTable}
      {...(domain || appDomain ? { domain: domain || appDomain } : {})}
      onClose={() => setCheckingTable(null)}
      onCreated={(sourceId) => void tableCreated(sourceId)}
    /> : null}
    {addingFieldsTo ? <SavedQueryFieldsDialog
      sourceId={addingFieldsTo.sourceId ?? addingFieldsTo.id}
      name={addingFieldsTo.name}
      onClose={() => setAddingFieldsTo(null)}
      onAdded={fieldsAdded}
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
  onToggle,
  onAdd,
  onRemove,
  onAddFields,
}: {
  item: AppBlockRecommendation;
  draft: Pick<AppStudioBuildDraft, 'sources' | 'pages'>;
  sourcePolicy: SourcePolicy;
  disabled: boolean;
  expanded: boolean;
  highlighted: boolean;
  adding: boolean;
  onToggle: () => void;
  onAdd: (allowReview: boolean) => void;
  onRemove: () => void;
  /** A saved query: open "Add fields". */
  onAddFields?: () => void;
}): JSX.Element {
  const sourceId = item.sourceId ?? item.id;
  const added = isAddedToApp(draft.sources, item);
  const reviewChoice = addNeedsReviewChoice(item, sourcePolicy);
  const certified = !needsReview(item);
  const type = sourceCatalogKindLabel(item);
  const meta = [type, trustLabel(certified ? 'certified' : 'review'), item.domain && item.domain !== 'Unassigned' ? humanize(item.domain) : '', item.owner ?? ''].filter(Boolean).join(' · ');
  return <article className={`add-data-row ${highlighted ? 'highlight' : ''} ${added ? 'added' : ''}`} data-source-id={sourceId}>
    <button type="button" className="add-data-summary" aria-expanded={expanded} onClick={onToggle} aria-label={`${expanded ? 'Hide' : 'Show'} details for ${humanize(item.name)}`}>
      <span className={`add-data-mark ${certified ? 'certified' : 'review'}`}>{certified ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
      <div><strong title={item.name}>{humanize(item.name)}</strong><small>{meta}</small>{item.description ? <p>{item.description}</p> : null}</div>
      <ChevronDown size={14} className="chevron" aria-hidden="true" />
    </button>
    <div className="add-data-action">
      {onAddFields ? <button type="button" className="add-fields" disabled={disabled} onClick={onAddFields} aria-label={`Add fields to ${humanize(item.name)}`} title="Give this saved query Measures and Dimensions">Add fields</button> : null}
      {added
        ? <><span className="add-data-added"><Check size={13} /> Added</span><RemoveDataButton name={humanize(item.name)} tileCount={tilesUsingSource(draft, sourceId).length} disabled={disabled} onRemove={onRemove} /></>
        : <button type="button" className={reviewChoice ? 'review' : 'primary'} disabled={disabled || adding} onClick={() => onAdd(reviewChoice)} aria-label={`${reviewChoice ? 'Allow data that needs review and add' : 'Add to App'}: ${humanize(item.name)}`}>{adding ? 'Adding…' : reviewChoice ? 'Allow data that needs review & add' : <><Plus size={13} /> Add to App</>}</button>}
    </div>
    {expanded ? <AddDataDetail item={item} /> : null}
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

function AddDataDetail({ item }: { item: AppBlockRecommendation }): JSX.Element {
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
      {groups.dimensions.length ? <section><h4>Dimensions</h4><p>{groups.dimensions.map((field) => <span key={field.name} className="chip">{field.kind === 'physical' && field.role === 'key' ? <Hash size={11} aria-hidden="true" /> : null} {humanize(field.name)}</span>)}</p></section> : null}
      {groups.time.length ? <section><h4>Time</h4><p>{groups.time.map((field) => <span key={field.name} className="chip"><CalendarDays size={11} aria-hidden="true" /> {humanize(field.name)}</span>)}</p></section> : null}
      {groups.review.length ? <section><h4>Needs review</h4><p>{groups.review.map((field) => <span key={field.name} className="chip muted">{humanize(field.name)}</span>)}</p></section> : null}
    </div> : <div className="add-data-fields">
      <section><h4>Columns</h4><p>{outputs.length ? outputs.map((column) => <span key={column} className="chip">{humanize(column)}</span>) : <small>Run it once to see its columns.</small>}</p></section>
      <small className="add-data-muted">A saved query is used as it is: no fields to pick until you add fields.</small>
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
