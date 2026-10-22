import { useEffect, useMemo, useState } from 'react';
import { Check, CalendarDays, Copy, Hash, Search, Table2, X } from 'lucide-react';
import { applyTableDuplicateChoices, duplicateColumnWords, type TableDatasetProposal, type TableDuplicateChoice } from '@zlens/core/datasets/table-draft';
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
 * One question per pair of columns that hold the same number in different
 * units (design Q1.4): "Use Order total in dollars?" The recommended answer
 * (the column whose name says its unit, read in dollars) is chosen first;
 * the other column is hidden from the fields.
 */
export function DuplicateColumnQuestions({
  proposal,
  choices,
  onChoice,
}: {
  proposal: TableDatasetProposal;
  choices: TableDuplicateChoice[];
  onChoice: (name: string, use: TableDuplicateChoice['use']) => void;
}): JSX.Element | null {
  const pairs = proposal.duplicates ?? [];
  if (!pairs.length) return null;
  return <>
    {pairs.map((pair) => {
      const use = choices.find((choice) => choice.name === pair.name)?.use ?? 'minor';
      // Worded for what the check found (new-user round 2, problem 7): "Subtotal is stored twice: Subtotal (dollars) and Subtotal cents."
      const words = duplicateColumnWords(pair);
      return (
        <fieldset key={pair.name} className="table-dataset-duplicate" aria-label={words.question}>
          <legend><Copy size={12} aria-hidden="true" /> {words.question}</legend>
          <p className="table-dataset-muted">{words.detail}</p>
          <label>
            <input type="radio" name={`duplicate-${pair.name}`} checked={use === 'minor'} onChange={() => onChoice(pair.name, 'minor')} />
            <span><strong>{words.recommended.title}</strong> <em>Recommended</em><small>{words.recommended.detail}</small></span>
          </label>
          <label>
            <input type="radio" name={`duplicate-${pair.name}`} checked={use === 'plain'} onChange={() => onChoice(pair.name, 'plain')} />
            <span><strong>{words.alternative.title}</strong><small>{words.alternative.detail}</small></span>
          </label>
        </fieldset>
      );
    })}
  </>;
}

/**
 * Start from a table (RFC 0009, "15-minute first page"). Pick a table; DQL
 * proposes what it can add up and count and what one row is, checked
 * against the table; "Check and use" saves it as a Dataset the author owns
 * after the same checks as Block Studio's Certify (compiles, runs, owner).
 * It is **Checked · Needs certifying**, never certified here (design Q1):
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
  const [picked, setPicked] = useState<WarehouseTableSummary | null>(null);
  const [draft, setDraft] = useState<{ proposal: TableDatasetProposal; rows: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState('');
  const [choices, setChoices] = useState<Choice[]>([]);
  const [duplicateChoices, setDuplicateChoices] = useState<TableDuplicateChoice[]>([]);
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
      setDuplicateChoices([]);
      // Number choices are keyed by the kept field's name, which is the same for either duplicate answer.
      setChoices(initialNumberChoices(applyTableDuplicateChoices(response.proposal)));
    });
  };
  useEffect(() => {
    if (initialTable) pick(initialTable);
    // Only the table the dialog opened with; later picks come from the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTable?.id]);
  const setChoice = (measure: string, patch: Partial<Choice>) => setChoices((current) => current.map((choice) => (choice.name === measure ? { ...choice, ...patch } : choice)));
  const save = () => {
    if (!picked || !draft) return;
    setSaving(true);
    setError(null);
    const duplicates = (draft.proposal.duplicates ?? []).map((pair) => ({ name: pair.name, use: duplicateChoices.find((choice) => choice.name === pair.name)?.use ?? 'minor' as const }));
    void api.createTableDataset({ tableId: picked.id, name: name.trim() || draft.proposal.name, ...(domain ? { domain } : {}), measures: choices, ...(duplicates.length ? { duplicates } : {}) }).then((response) => {
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

  // What the check shows follows the duplicate answers (design Q1.4).
  const proposal = useMemo(() => (draft ? applyTableDuplicateChoices(draft.proposal, duplicateChoices) : undefined), [draft, duplicateChoices]);
  const keptCount = choices.filter((choice) => choice.include).length;
  const chooseDuplicate = (pairName: string, use: TableDuplicateChoice['use']) => setDuplicateChoices((current) => [...current.filter((choice) => choice.name !== pairName), { name: pairName, use }]);

  return (
    <div className="proposal-scrim" role="dialog" aria-modal="true" aria-labelledby="table-dataset-title">
      <section className="table-dataset-card">
        <header>
          <span className="table-dataset-icon"><Table2 size={17} aria-hidden="true" /></span>
          <div>
            <h2 id="table-dataset-title">{proposal ? 'Check the numbers' : 'Start from a table'}</h2>
            <p>{proposal ? `From ${picked?.schema ? `${picked.schema}.` : ''}${picked?.name} · ${draft!.rows.toLocaleString()} rows` : 'Pick a table from your database. ZLens suggests what to add up, count and group by.'}</p>
          </div>
          <button type="button" className="icon" onClick={onClose} disabled={saving} aria-label="Close"><X size={15} /></button>
        </header>

        {!proposal ? (
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
            {draft ? <DuplicateColumnQuestions proposal={draft.proposal} choices={duplicateChoices} onChoice={chooseDuplicate} /> : null}
            <DatasetNumbersCheck proposal={proposal} rows={draft!.rows} choices={choices} onChoice={setChoice} noKeyMessage="No column is filled and different on every row, so ZLens cannot count this table's rows safely. Choose a table with an id column." />
            {proposal.skipped?.length ? <p className="table-dataset-muted">Left out (names ZLens cannot use): {proposal.skipped.join(', ')}.</p> : null}
            {error ? <p className="table-dataset-error" role="alert">{error}</p> : null}
          </div>
        )}

        <footer>
          {proposal ? <button type="button" onClick={() => { setDraft(null); setPicked(null); setError(null); }} disabled={saving}>Back</button> : <span />}
          {proposal ? <small>ZLens saves it as a file in your project and checks it compiles and runs. You can build tiles right away; it is <strong>Checked · Needs certifying</strong> until someone certifies it, before you publish.</small> : null}
          {proposal ? (
            <button type="button" className="primary" disabled={saving || !proposal.key || keptCount === 0} onClick={save}>{saving ? 'Checking…' : 'Check and use'}</button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
