import { useEffect, useMemo, useState } from 'react';
import { Check, CalendarDays, Copy, Hash, Search, Table2, X } from 'lucide-react';
import { applyTableDuplicateChoices, duplicateColumnsQuestion, type TableDatasetProposal, type TableDuplicateChoice } from '@zlens/core/datasets/table-draft';
import { api, type CertificationByline, type WarehouseTableSummary } from '../../../api/client';
import { messageOf } from './studio-ui';

export type NumberChoice = { name: string; include: boolean; format: 'number' | 'currency' | 'percent'; currency?: string };
type Choice = NumberChoice;

/** The proposal's numbers as the author's starting choices. */
export function initialNumberChoices(proposal: TableDatasetProposal): NumberChoice[] {
  return proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format, ...(measure.currency ? { currency: measure.currency } : {}) }));
}

/**
 * "Check the numbers": what one row is (checked against the rows), which
 * numbers to keep and how to show them, and what tiles can group and filter
 * by. Shared by "Start from a table" and "Add fields" on a saved query.
 */
export function DatasetNumbersCheck({
  proposal,
  rows,
  choices,
  onChoice,
  noKeyMessage,
  groupByKey = false,
}: {
  proposal: TableDatasetProposal;
  rows: number;
  choices: NumberChoice[];
  onChoice: (measure: string, patch: Partial<NumberChoice>) => void;
  noKeyMessage: string;
  /** A saved query's row identity is often its grouping (a region, a customer name): list it too. */
  groupByKey?: boolean;
}): JSX.Element {
  const dates = proposal.fields.filter((field) => field.role === 'time');
  const groups = proposal.fields.filter((field) => field.role === 'dimension' || (groupByKey && field.role === 'key'));
  return <>
    {proposal.key ? (
      <p className="table-dataset-row"><Check size={14} aria-hidden="true" /><span>Each row is one <strong>{proposal.key.timeGrain ?? proposal.key.entity.replace(/_/g, ' ')}</strong>: <code>{proposal.key.column}</code> is filled and different on all {rows.toLocaleString()} rows, so rows can be counted safely.</span></p>
    ) : (
      <p className="table-dataset-error" role="alert">{noKeyMessage}</p>
    )}
    <fieldset className="table-dataset-numbers">
      <legend>Numbers</legend>
      {proposal.measures.map((measure) => {
        const choice = choices.find((entry) => entry.name === measure.name);
        return (
          <div key={measure.name} className={`table-dataset-number ${choice?.include ? '' : 'off'}`}>
            <label htmlFor={`number-${measure.name}`}>
              <input id={`number-${measure.name}`} type="checkbox" checked={Boolean(choice?.include)} onChange={(event) => onChoice(measure.name, { include: event.target.checked })} />
              <Hash size={12} aria-hidden="true" />
              <strong>{measure.label}</strong>
              <span>{measure.reason}</span>
              {measure.unitNote ? <small className="table-dataset-unit">{measure.unitNote}</small> : null}
            </label>
            {measure.aggregation === 'sum' ? (
              <select aria-label={`Show ${measure.label} as`} value={choice?.format ?? measure.format} disabled={!choice?.include} onChange={(event) => onChoice(measure.name, { format: event.target.value as NumberChoice['format'], ...(event.target.value === 'currency' ? { currency: choice?.currency ?? 'USD' } : {}) })}>
                <option value="number">Number</option>
                <option value="currency" disabled={Boolean(measure.minorUnits)}>Money</option>
                <option value="percent">Percent</option>
              </select>
            ) : null}
          </div>
        );
      })}
    </fieldset>
    {groups.length || dates.length ? (
      <div className="table-dataset-groups">
        <span>Group and filter by</span>
        <p>
          {dates.map((field) => <span key={field.name} className="chip"><CalendarDays size={11} aria-hidden="true" /> {field.label}</span>)}
          {groups.map((field) => <span key={field.name} className="chip">{field.label}</span>)}
        </p>
      </div>
    ) : null}
  </>;
}

/**
 * One question per table for every column stored twice (new-user round 3,
 * problem 8): "These columns are stored twice, in dollars and in cents:
 * Subtotal, Tax paid and Order total. ZLens will use the dollar columns and
 * hide the cents copies." [OK] [Show both]. OK is chosen first; Show both
 * keeps the cents copies as plain numbers.
 */
export function DuplicateColumnQuestions({
  proposal,
  mode,
  onMode,
}: {
  proposal: TableDatasetProposal;
  mode: DuplicateMode;
  onMode: (mode: DuplicateMode) => void;
}): JSX.Element | null {
  const asked = duplicateColumnsQuestion(proposal.duplicates ?? []);
  if (!asked) return null;
  return (
    <section className="table-dataset-duplicate" role="group" aria-label="Duplicate columns">
      <p><Copy size={12} aria-hidden="true" /> <strong>{asked.question}</strong> {mode === 'ok' ? asked.ok : asked.both}</p>
      <span className="table-dataset-duplicate-actions">
        <button type="button" aria-pressed={mode === 'ok'} className={mode === 'ok' ? 'on' : ''} onClick={() => onMode('ok')}>OK</button>
        <button type="button" aria-pressed={mode === 'both'} className={mode === 'both' ? 'on' : ''} onClick={() => onMode('both')}>Show both</button>
      </span>
    </section>
  );
}

/** The answer to the one duplicate-columns question. */
export type DuplicateMode = 'ok' | 'both';

/** The per-pair choices an answer stands for. */
export function duplicateChoicesFor(proposal: TableDatasetProposal, mode: DuplicateMode): TableDuplicateChoice[] {
  const asked = duplicateColumnsQuestion(proposal.duplicates ?? []);
  if (!asked) return [];
  return mode === 'both' ? asked.bothChoices : asked.okChoices;
}

/** Number choices for every measure a proposal now has: kept ones as chosen, new ones as proposed. */
export function numberChoicesFor(proposal: TableDatasetProposal, choices: NumberChoice[]): NumberChoice[] {
  return proposal.measures.map((measure) => choices.find((choice) => choice.name === measure.name)
    ?? { name: measure.name, include: measure.include, format: measure.format, ...(measure.currency ? { currency: measure.currency } : {}) });
}

/**
 * Start from a table (RFC 0009, "15-minute first page"). Pick a table; DQL
 * proposes what it can add up and count and what one row is, checked
 * against the table; "Check and use" saves it as a Dataset the author owns
 * after the same checks as Block Studio's Certify (compiles, runs, owner).
 * It is checked, **Not certified yet**, never certified here (design Q1):
 * tiles work right away, and someone certifies it on purpose before the App
 * is published. No dbt, no modeling vocabulary: numbers, groupings and dates.
 */
export function TableDatasetDialog({
  domain,
  initialTable,
  onClose,
  onCreated,
}: {
  /** The App's area, so the new Dataset sits beside its other data. */
  domain?: string;
  /** A table already chosen in the Add data browser: open straight on its check. */
  initialTable?: WarehouseTableSummary;
  onClose: () => void;
  /** Who checked it and what the check found come back with it (design Q1). */
  onCreated: (sourceId: string | undefined, name: string, check?: CertificationByline) => void;
}): JSX.Element {
  const [tables, setTables] = useState<WarehouseTableSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<WarehouseTableSummary | null>(initialTable ?? null);
  const [draft, setDraft] = useState<{ proposal: TableDatasetProposal; rows: number } | null>(null);
  // A table picked in the Add data list opens straight on its check, never on the table list (new-user round 3).
  const [checking, setChecking] = useState(Boolean(initialTable));
  const [name, setName] = useState('');
  const [choices, setChoices] = useState<Choice[]>([]);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode>('ok');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.listWarehouseTables().then((response) => {
      if (!active) return;
      if (response.ok) setTables(response.tables);
      else setListError(response.error ?? 'ZLens could not read the tables in your database.');
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose, saving]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (tables ?? []).filter((table) => !needle || `${table.schema ?? ''}.${table.name}`.toLowerCase().includes(needle)).slice(0, 200);
  }, [tables, search]);

  const pick = (table: WarehouseTableSummary) => {
    setPicked(table);
    setDraft(null);
    setError(null);
    setChecking(true);
    void api.draftTableDataset(table.id).then((response) => {
      setChecking(false);
      if (!response.ok || !response.proposal) {
        setError(response.error ?? 'ZLens could not read this table.');
        return;
      }
      setDraft({ proposal: response.proposal, rows: response.rows ?? 0 });
      setName(response.proposal.name);
      setDuplicateMode('ok');
      // Number choices are keyed by the kept field's name, the same for either answer; Show both adds the cents copies.
      setChoices(initialNumberChoices(applyTableDuplicateChoices(response.proposal, duplicateChoicesFor(response.proposal, 'ok'))));
    });
  };
  useEffect(() => {
    if (initialTable) pick(initialTable);
    // Only the table the dialog opened with; later picks come from the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTable?.id]);
  const setChoice = (measure: string, patch: Partial<Choice>) => setChoices((current) => {
    const all = proposal ? numberChoicesFor(proposal, current) : current;
    return all.map((choice) => (choice.name === measure ? { ...choice, ...patch } : choice));
  });
  const save = () => {
    if (!picked || !draft) return;
    setSaving(true);
    setError(null);
    const duplicates = duplicateChoicesFor(draft.proposal, duplicateMode);
    void api.createTableDataset({ tableId: picked.id, name: name.trim() || draft.proposal.name, ...(domain ? { domain } : {}), measures: proposal ? numberChoicesFor(proposal, choices) : choices, ...(duplicates.length ? { duplicates } : {}) }).then((response) => {
      setSaving(false);
      if (!response.ok) {
        setError(response.error ?? 'ZLens could not save this data.');
        return;
      }
      if (response.status !== 'checked') {
        setError(`Saved as a draft: it did not pass its checks yet. ${(response.blockers ?? []).join(' ') || 'Run it once to see why.'}`);
        return;
      }
      onCreated(response.sourceId, name.trim() || draft.proposal.name, response.check);
    }).catch((cause) => {
      setSaving(false);
      setError(messageOf(cause));
    });
  };

  // What the check shows follows the duplicate answer (design Q1.4, new-user round 3).
  const proposal = useMemo(() => (draft ? applyTableDuplicateChoices(draft.proposal, duplicateChoicesFor(draft.proposal, duplicateMode)) : undefined), [draft, duplicateMode]);
  const shownChoices = proposal ? numberChoicesFor(proposal, choices) : choices;
  const keptCount = shownChoices.filter((choice) => choice.include).length;
  const openedOnTable = Boolean(initialTable && picked?.id === initialTable.id && !draft);

  return (
    <div className="proposal-scrim" role="dialog" aria-modal="true" aria-labelledby="table-dataset-title">
      <section className="table-dataset-card">
        <header>
          <span className="table-dataset-icon"><Table2 size={17} aria-hidden="true" /></span>
          <div>
            <h2 id="table-dataset-title">{proposal || openedOnTable ? 'Check the numbers' : 'Start from a table'}</h2>
            <p>{proposal ? `From ${picked?.schema ? `${picked.schema}.` : ''}${picked?.name} · ${draft!.rows.toLocaleString()} rows` : openedOnTable ? `Checking ${picked?.name ?? ''}…` : 'Pick a table from your database. ZLens suggests what to add up, count and group by.'}</p>
          </div>
          <button type="button" className="icon" onClick={onClose} disabled={saving} aria-label="Close"><X size={15} /></button>
        </header>

        {!proposal && openedOnTable ? (
          <div className="table-dataset-body">
            {checking ? <p className="table-dataset-muted" role="status">Reading {picked?.name} to see what one row is and which numbers to add up…</p> : null}
            {error ? <p className="table-dataset-error" role="alert">{error}</p> : null}
          </div>
        ) : !proposal ? (
          <div className="table-dataset-body">
            <label className="field-search">
              <Search size={14} aria-hidden="true" />
              <input id="table-dataset-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tables" aria-label="Search tables" autoFocus />
            </label>
            {listError ? <p className="table-dataset-error" role="alert">{listError}</p> : null}
            {!tables && !listError ? <p className="table-dataset-muted" role="status">Reading your database…</p> : null}
            {tables && !tables.length ? <p className="table-dataset-muted">No tables found. Check the connection in Settings.</p> : null}
            <ul className="table-dataset-list" aria-label="Tables">
              {shown.map((table) => (
                <li key={table.id}>
                  <button type="button" disabled={checking} aria-busy={checking && picked?.id === table.id} onClick={() => pick(table)}>
                    <strong>{table.name}</strong>
                    <span>{[table.schema, `${table.columnCount} columns`, table.rowCountEstimate !== undefined ? `~${table.rowCountEstimate.toLocaleString()} rows` : ''].filter(Boolean).join(' · ')}</span>
                    {checking && picked?.id === table.id ? <em>Checking…</em> : null}
                  </button>
                </li>
              ))}
            </ul>
            {error ? <p className="table-dataset-error" role="alert">{error}</p> : null}
          </div>
        ) : (
          <div className="table-dataset-body">
            <label className="table-dataset-name" htmlFor="table-dataset-name">
              <span>Name</span>
              <input id="table-dataset-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </label>
            {draft ? <DuplicateColumnQuestions proposal={draft.proposal} mode={duplicateMode} onMode={setDuplicateMode} /> : null}
            <DatasetNumbersCheck proposal={proposal} rows={draft!.rows} choices={shownChoices} onChoice={setChoice} noKeyMessage="No column is filled and different on every row, so ZLens cannot count this table's rows safely. Choose a table with an id column." />
            {proposal.skipped?.length ? <p className="table-dataset-muted">Left out (names ZLens cannot use): {proposal.skipped.join(', ')}.</p> : null}
            {error ? <p className="table-dataset-error" role="alert">{error}</p> : null}
          </div>
        )}

        <footer>
          {proposal ? <button type="button" onClick={() => { setDraft(null); setPicked(null); setError(null); }} disabled={saving}>Back</button> : <span />}
          {proposal ? <small>ZLens saves it as a file in your project and checks it compiles and runs. You can build tiles right away; it is <strong>Not certified yet</strong> until someone certifies it.</small> : null}
          {proposal ? (
            <button type="button" className="primary" disabled={saving || !proposal.key || keptCount === 0} onClick={save}>{saving ? 'Checking…' : 'Check and use'}</button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
