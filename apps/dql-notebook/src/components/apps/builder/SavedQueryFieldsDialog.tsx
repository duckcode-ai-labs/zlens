import { useEffect, useState } from 'react';
import { FileText, ShieldCheck, X } from 'lucide-react';
import { api, type SavedQueryDatasetDraft, type SavedQueryDatasetResult } from '../../../api/client';
import { DatasetNumbersCheck, initialNumberChoices, type NumberChoice } from './TableDatasetDialog';
import { humanize, messageOf } from './studio-ui';

/** Shown before the author confirms, when the saved query is certified. */
export const MAKE_ROW_LEVEL_SENDS_BACK_FOR_REVIEW = 'Making it row-level sends this saved query back for review.';

export type SavedQueryFieldsApi = {
  draft: (sourceId: string) => Promise<SavedQueryDatasetDraft>;
  create: typeof api.createSavedQueryDataset;
};

const defaultApi: SavedQueryFieldsApi = {
  draft: (sourceId) => api.draftSavedQueryDataset(sourceId),
  create: (input) => api.createSavedQueryDataset(input),
};

/** What the dialog says once the server answered a create. */
export function savedQueryFieldsOutcome(result: SavedQueryDatasetResult, name: string): { kind: 'certified' | 'review' | 'refused' | 'error'; message: string } {
  if (result.ok && result.status === 'certified') {
    return { kind: 'certified', message: `${name} is row-level now and certified: its checks passed.` };
  }
  if (result.ok) {
    return { kind: 'review', message: `${name} is row-level now. It needs review: it did not pass its checks yet.` };
  }
  if (result.code === 'SAVED_QUERY_REVIEW_REQUIRED') {
    return { kind: 'refused', message: `${name} is certified, and made row-level it did not pass its checks, so nothing changed yet.` };
  }
  return { kind: 'error', message: result.error ?? 'ZLens could not make this saved query row-level.' };
}

export type SavedQueryFieldsSubmission =
  | { kind: 'added'; status: 'certified' | 'review' | 'draft'; sourceId: string; message: string; blockers: string[] }
  | { kind: 'refused'; message: string; blockers: string[] }
  | { kind: 'error'; message: string };

/**
 * One "Check and make row-level" press: write the author's numbers onto the saved
 * query and say what happened. `allowReview` is the explicit second press
 * that sends a certified saved query back for review after a failed check.
 */
export async function submitSavedQueryFields(client: SavedQueryFieldsApi, input: {
  sourceId: string;
  name: string;
  draft: SavedQueryDatasetDraft;
  choices: NumberChoice[];
  allowReview?: boolean;
}): Promise<SavedQueryFieldsSubmission> {
  const result = await client.create({
    sourceId: input.sourceId,
    ...(input.draft.source?.sourceRevision ? { sourceRevision: input.draft.source.sourceRevision } : {}),
    measures: input.choices,
    ...(input.allowReview ? { allowReview: true } : {}),
  });
  const outcome = savedQueryFieldsOutcome(result, input.name);
  if (outcome.kind === 'refused') return { kind: 'refused', message: outcome.message, blockers: result.blockers ?? [] };
  if (outcome.kind === 'error') return { kind: 'error', message: outcome.message };
  return { kind: 'added', status: result.status ?? 'review', sourceId: result.sourceId ?? input.sourceId, message: outcome.message, blockers: result.blockers ?? [] };
}

/**
 * Make a saved query row-level (design D1; formerly "Add fields"). A saved
 * query already shows its result's columns as fields; this is only needed for
 * row-safe measures (distinct counts, averages over rows). The same "Check the numbers" step
 * as "Start from a table", for an existing saved query: ZLens reads its
 * columns, checks what one row is against its rows, and writes the fields
 * onto the same saved query file. The same certification check as the table
 * path then runs: when it passes the saved query is a certified Dataset; when
 * it does not, it stays Needs review. A certified saved query goes back for
 * review, and is only changed after a failed check if the author sends it.
 */
export function SavedQueryFieldsDialog({
  sourceId,
  name,
  onClose,
  onAdded,
  client = defaultApi,
  initialDraft,
}: {
  sourceId: string;
  /** The saved query's name, shown while its proposal loads. */
  name: string;
  onClose: () => void;
  /** The fields are written; `status` says whether it is certified or needs review. */
  onAdded: (sourceId: string, status: 'certified' | 'review' | 'draft') => void;
  client?: SavedQueryFieldsApi;
  /** A proposal already read (tests); otherwise the dialog reads it on open. */
  initialDraft?: SavedQueryDatasetDraft;
}): JSX.Element {
  const label = humanize(name);
  const [draft, setDraft] = useState<SavedQueryDatasetDraft | null>(initialDraft ?? null);
  const [choices, setChoices] = useState<NumberChoice[]>(initialDraft?.proposal ? initialNumberChoices(initialDraft.proposal) : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string[] | null>(null);
  const [done, setDone] = useState<{ status: 'certified' | 'review' | 'draft'; sourceId: string; message: string; blockers: string[] } | null>(null);

  useEffect(() => {
    if (initialDraft) return undefined;
    let active = true;
    void client.draft(sourceId).then((response) => {
      if (!active) return;
      if (!response.ok || !response.proposal) {
        setError(response.error ?? 'ZLens could not read this saved query.');
        return;
      }
      setDraft(response);
      setChoices(initialNumberChoices(response.proposal));
    }).catch((cause) => { if (active) setError(messageOf(cause)); });
    return () => { active = false; };
  }, [client, sourceId, initialDraft]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose, saving]);

  const setChoice = (measure: string, patch: Partial<NumberChoice>) => setChoices((current) => current.map((choice) => (choice.name === measure ? { ...choice, ...patch } : choice)));
  const save = (allowReview = false) => {
    if (!draft?.proposal) return;
    setSaving(true);
    setError(null);
    void submitSavedQueryFields(client, { sourceId, name: label, draft, choices, allowReview }).then((submission) => {
      setSaving(false);
      if (submission.kind === 'refused') {
        setRefusal(submission.blockers);
        return;
      }
      if (submission.kind === 'error') {
        setError(submission.message);
        return;
      }
      setRefusal(null);
      setDone({ status: submission.status, sourceId: submission.sourceId, message: submission.message, blockers: submission.blockers });
    }).catch((cause) => {
      setSaving(false);
      setError(messageOf(cause));
    });
  };

  const proposal = draft?.proposal;
  const keptCount = choices.filter((choice) => choice.include).length;
  const sendsBack = Boolean(draft?.sendsBackForReview);

  return (
    <div className="proposal-scrim" role="dialog" aria-modal="true" aria-labelledby="saved-query-fields-title">
      <section className="table-dataset-card saved-query-fields-card">
        <header>
          <span className="table-dataset-icon"><FileText size={17} aria-hidden="true" /></span>
          <div>
            <h2 id="saved-query-fields-title">{done ? 'Row-level now' : 'Check the numbers'}</h2>
            <p>{proposal ? `Make ${label} row-level · ${(draft?.rows ?? 0).toLocaleString()} rows` : `Make ${label} row-level`}</p>
          </div>
          <button type="button" className="icon" onClick={onClose} disabled={saving} aria-label="Close"><X size={15} /></button>
        </header>

        <div className="table-dataset-body">
          {!proposal && !error ? <p className="table-dataset-muted" role="status">Reading {label} and checking its rows…</p> : null}
          {done ? (
            <div className={`saved-query-fields-done ${done.status === 'certified' ? 'certified' : 'review'}`} role="status">
              {done.status === 'certified' ? <ShieldCheck size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
              <div>
                <strong>{done.message}</strong>
                <small>Its row-level Measures and Dimensions are in the Data pane.{done.blockers.length ? ` Why it needs review: ${done.blockers.join(' ')}` : ''}</small>
              </div>
            </div>
          ) : proposal ? (
            <>
              {sendsBack ? <p className="saved-query-fields-notice" role="note"><strong>{MAKE_ROW_LEVEL_SENDS_BACK_FOR_REVIEW}</strong> ZLens runs its certification checks right away: if they pass, it is certified again.</p> : null}
              <DatasetNumbersCheck proposal={proposal} rows={draft?.rows ?? 0} choices={choices} onChoice={setChoice} groupByKey noKeyMessage={`No column in ${label} is filled and different on every row, so ZLens cannot count its rows safely. Add an id column to the saved query first.`} />
              {proposal.skipped?.length ? <p className="table-dataset-muted">Left out (names ZLens cannot use): {proposal.skipped.join(', ')}.</p> : null}
              {refusal ? <div className="table-dataset-error" role="alert">
                <p>{label} is certified, and made row-level it did not pass its checks, so nothing changed yet.{refusal.length ? ` ${refusal.join(' ')}` : ''}</p>
                <button type="button" disabled={saving} onClick={() => save(true)}>Send for review and make row-level</button>
              </div> : null}
            </>
          ) : null}
          {error ? <p className="table-dataset-error" role="alert">{error}</p> : null}
        </div>

        <footer>
          {done ? <span /> : <button type="button" onClick={onClose} disabled={saving}>Cancel</button>}
          {!done && proposal ? <small>ZLens writes a row-level definition into this saved query's file (same name, same place) and checks it compiles and runs.</small> : null}
          {done
            ? <button type="button" className="primary" onClick={() => onAdded(done.sourceId, done.status)}>Use its fields</button>
            : proposal ? <button type="button" className="primary" disabled={saving || !proposal.key || keptCount === 0} onClick={() => save(false)}>{saving ? 'Checking…' : 'Check and make row-level'}</button> : null}
        </footer>
      </section>
    </div>
  );
}
