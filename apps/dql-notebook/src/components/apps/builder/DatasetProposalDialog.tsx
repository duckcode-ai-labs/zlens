import { useEffect, useMemo, useState } from 'react';
import { FileText, X } from 'lucide-react';
import type { AppBlockRecommendation, DatasetAuthoringChange } from '../../../api/client';
import { datasetAuthoringChangeForDefinition, datasetSourceDefinitionDraft, datasetSourceAuthoringModel, type DatasetCalculatedMeasureCandidate, type DatasetCalculatedMeasureDraft, type DatasetSourceDefinitionDraft } from '../app-dataset-source-authoring';
import { humanize, messageOf } from './studio-ui';

/**
 * The App-side source editor deliberately prepares a Context proposal rather
 * than writing a Dataset source or changing an App binding. It gives authors
 * a concrete definition path while retaining the server as parser, compiler,
 * current-source-hash, and lifecycle authority.
 */
export function DatasetSourceAuthoringDialog({
  source,
  disabled,
  onClose,
  onPreview,
}: {
  source: AppBlockRecommendation;
  disabled: boolean;
  onClose: () => void;
  onPreview: (change: DatasetAuthoringChange) => void;
}): JSX.Element {
  const model = useMemo(() => datasetSourceAuthoringModel(source), [source]);
  const initial = model?.candidates[0];
  const [draft, setDraft] = useState<DatasetCalculatedMeasureDraft>(() => datasetAuthoringDraft(initial));
  const [definition, setDefinition] = useState<DatasetSourceDefinitionDraft>(() => (
    model ? datasetSourceDefinitionDraft(model.descriptor) : emptyDatasetSourceDefinitionDraft()
  ));
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setDraft(datasetAuthoringDraft(initial));
    setDefinition(model ? datasetSourceDefinitionDraft(model.descriptor) : emptyDatasetSourceDefinitionDraft());
    setMessage(null);
  }, [initial?.id, model?.descriptor.sourceRevision, source.sourceRevision]);

  if (!model) {
    return <div className="proposal-scrim" role="dialog" aria-modal="true" aria-label="Field definitions unavailable"><section className="dataset-source-authoring-card"><header><span><FileText size={17} /></span><div><small>DATASET SOURCE</small><h2>Authoring is unavailable</h2></div><button type="button" className="icon" onClick={onClose} aria-label="Close Dataset source authoring"><X size={15} /></button></header><p>Refresh this source from the catalog before authoring a saved query-backed Dataset definition.</p><footer><button type="button" onClick={onClose}>Close</button></footer></section></div>;
  }

  const chooseCandidate = (candidate: DatasetCalculatedMeasureCandidate) => {
    setDraft({
      name: candidate.name,
      expression: candidate.expression,
      aggregation: candidate.aggregation,
      additivity: candidate.additivity,
      format: candidate.format,
      currency: candidate.currency,
    });
    setMessage(`${candidate.label} is a reviewable candidate. ZLens will validate its dependencies and aggregation before source bytes can change.`);
  };

  const preview = () => {
    try {
      const formula = draft.name.trim() || draft.expression.trim() ? draft : undefined;
      onPreview(datasetAuthoringChangeForDefinition(source, model.descriptor, definition, formula));
      setMessage(null);
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  };

  return <div className="proposal-scrim" role="dialog" aria-modal="true" aria-label={`Define fields for ${model.descriptor.label}`}>
    <section className="dataset-source-authoring-card">
      <header>
        <span><FileText size={17} /></span>
        <div><small>FIELDS</small><h2>Define fields</h2><p>{model.descriptor.label}</p></div>
        <button type="button" className="icon" onClick={onClose} disabled={disabled} aria-label="Close field definitions"><X size={15} /></button>
      </header>
      <div className="dataset-source-authoring-body">
        <section className="dataset-source-grain">
          <label>What is one row?</label>
          <p>Say what one row of this data stands for, and which column is unique on every row. This saves for review; ZLens still checks the rows before trusting it.</p>
          <div className="dataset-source-form-grid">
            <label><span>Entities</span><input aria-label="Native grain entities" value={definition.grain.entities} disabled={disabled} onChange={(event) => setDefinition((current) => ({ ...current, grain: { ...current.grain, entities: event.target.value } }))} placeholder="order_line" /></label>
            <label><span>Unique ID column</span><input aria-label="Native grain keys" value={definition.grain.keys} disabled={disabled} onChange={(event) => setDefinition((current) => ({ ...current, grain: { ...current.grain, keys: event.target.value } }))} placeholder="order_line_id" /></label>
            <label><span>Time grain</span><input aria-label="Native time grain" value={definition.grain.timeGrain} disabled={disabled} onChange={(event) => setDefinition((current) => ({ ...current, grain: { ...current.grain, timeGrain: event.target.value } }))} placeholder="day" /></label>
            <label><span>Time bucket field</span><select aria-label="Native time bucket" value={definition.grain.timeBucketBy} disabled={disabled} onChange={(event) => setDefinition((current) => ({ ...current, grain: { ...current.grain, timeBucketBy: event.target.value } }))}><option value="">Not declared</option>{definition.fields.filter((field) => field.role === 'time' && (field.type === 'date' || field.type === 'timestamp')).map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}</select></label>
            <label className="dataset-source-checkbox"><input aria-label="Source is already aggregated" type="checkbox" checked={definition.grain.aggregate} disabled={disabled} onChange={(event) => setDefinition((current) => ({ ...current, grain: { ...current.grain, aggregate: event.target.checked } }))} /><span>Source already contains aggregates</span></label>
          </div>
          <small>{definition.grain.aggregate ? 'Already summarised: rolling it up further needs a check first.' : 'One row per item: ZLens checks the ID column against every row before showing rows.'}</small>
          {/* Ids and proof references, for whoever needs them (D6). */}
          <details className="dql-technical-details">
            <summary>Technical details</summary>
            <p>Source revision <code>{source.sourceRevision?.slice(0, 18)}</code></p>
            <label><span>Key evidence reference</span><input aria-label="Key evidence reference" value={definition.grain.keyEvidence} disabled={disabled} onChange={(event) => setDefinition((current) => ({ ...current, grain: { ...current.grain, keyEvidence: event.target.value } }))} placeholder="proof:source-grain" /></label>
          </details>
        </section>
        <section className="dataset-source-fields">
          <label>Column types</label>
          <p>Columns and their types come from the data. You can say how each column is used and set time details; this cannot add columns or change the SQL.</p>
          <div>{definition.fields.map((field, index) => <span key={field.name} className="dataset-source-field-editor"><strong>{field.name}</strong><small>{field.type} · {field.status}</small><label><span>Role</span><select aria-label={`${field.name} role`} value={field.role} disabled={disabled} onChange={(event) => setDefinition((current) => ({ ...current, fields: current.fields.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, role: event.target.value as DatasetSourceDefinitionDraft['fields'][number]['role'] } : candidate) }))}>{['dimension', 'key', 'time', 'attribute'].map((role) => <option key={role} value={role}>{humanize(role)}</option>)}</select></label>{(field.type === 'date' || field.type === 'timestamp') ? <><label><span>Time grains</span><input aria-label={`${field.name} time grains`} value={field.grains} disabled={disabled} onChange={(event) => setDefinition((current) => ({ ...current, fields: current.fields.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, grains: event.target.value } : candidate) }))} placeholder="day, month" /></label><label className="dataset-source-checkbox"><input aria-label={`${field.name} is primary time`} type="checkbox" checked={field.primary} disabled={disabled} onChange={(event) => setDefinition((current) => ({ ...current, fields: current.fields.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, primary: event.target.checked } : candidate) }))} /><span>Primary time field</span></label></> : null}</span>)}</div>
        </section>
        {model.candidates.length ? <section className="dataset-source-candidates">
          <label>Reviewable calculated-measure candidates</label>
          <p>These suggestions use exact approved physical fields. They are not source approval, additivity proof, or a certificate.</p>
          <div>{model.candidates.map((candidate) => <button key={candidate.id} type="button" disabled={disabled} onClick={() => chooseCandidate(candidate)}><strong>{candidate.label}</strong><code>{candidate.expression}</code><small>{candidate.dependencies.join(', ')} · {candidate.aggregation} · candidate</small></button>)}</div>
        </section> : null}
        <section className="dataset-source-measure-form">
          <label>Calculated measure proposal</label>
          <div className="dataset-source-form-grid">
            <label><span>Name</span><input aria-label="Calculated measure name" value={draft.name} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="gross_margin" /></label>
            <label><span>Declared aggregation</span><select aria-label="Calculated measure aggregation" value={draft.aggregation} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, aggregation: event.target.value as DatasetCalculatedMeasureDraft['aggregation'] }))}>{['sum', 'count', 'count_distinct', 'ratio', 'avg', 'min', 'max'].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></label>
            <label><span>Declared additivity</span><select aria-label="Calculated measure additivity" value={draft.additivity} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, additivity: event.target.value as DatasetCalculatedMeasureDraft['additivity'] }))}>{['non_additive', 'semi_additive', 'additive'].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></label>
            <label><span>Display format</span><select aria-label="Calculated measure format" value={draft.format} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, format: event.target.value as DatasetCalculatedMeasureDraft['format'] }))}>{['number', 'currency', 'percent'].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></label>
            {draft.format === 'currency' ? <label><span>Currency</span><input aria-label="Calculated measure currency" value={draft.currency ?? ''} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, currency: event.target.value.toUpperCase() }))} placeholder="USD" /></label> : null}
          </div>
          <label className="dataset-source-expression"><span>Aggregate formula</span><textarea aria-label="Calculated measure expression" rows={3} value={draft.expression} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, expression: event.target.value }))} placeholder="SUM(approved_field) - SUM(another_approved_field)" /></label>
          <small>Only DQL’s bounded aggregate grammar is accepted: approved physical fields inside supported aggregates, arithmetic, and <code>NULLIF(..., 0)</code>. The server rejects arbitrary SQL, windows, subqueries, unknown functions, row/aggregate mixing, stale sources, and invalid contracts.</small>
          <small>Choosing additive is a declaration for review. It does not permit a rollup until ZLens has current source and component evidence.</small>
        </section>
        {message ? <p className="dataset-source-authoring-message" role="status">{message}</p> : null}
      </div>
      <footer><span>Saving creates a source proposal that needs review. It does not change this App’s data.</span><button type="button" onClick={onClose} disabled={disabled}>Cancel</button><button type="button" className="primary" onClick={preview} disabled={disabled}><FileText size={13} /> Review source change</button></footer>
    </section>
  </div>;
}

function datasetAuthoringDraft(candidate?: DatasetCalculatedMeasureCandidate): DatasetCalculatedMeasureDraft {
  return candidate ? {
    name: candidate.name,
    expression: candidate.expression,
    aggregation: candidate.aggregation,
    additivity: candidate.additivity,
    format: candidate.format,
    currency: candidate.currency,
  } : {
    name: '', expression: '', aggregation: 'sum', additivity: 'non_additive', format: 'number',
  };
}

function emptyDatasetSourceDefinitionDraft(): DatasetSourceDefinitionDraft {
  return {
    grain: { entities: '', keys: '', keyEvidence: '', description: '', timeGrain: '', timeBucketBy: '', aggregate: false },
    fields: [],
  };
}

export function DatasetSourceRebindReviewDialog({
  title,
  disabled,
  onCancel,
  onConfirm,
}: {
  title: string;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return <div className="proposal-scrim" role="dialog" aria-modal="true" aria-label="Allow data that needs review">
    <section className="dataset-source-rebind-card">
      <header><span><FileText size={17} /></span><div><small>NEEDS REVIEW</small><h2>Refresh this data?</h2></div><button type="button" className="icon" onClick={onCancel} disabled={disabled} aria-label="Close data refresh"><X size={15} /></button></header>
      <p><strong>{humanize(title)}</strong> changed and currently needs review. You can explicitly allow data that needs review and refresh this App’s saved source revision.</p>
      <p>This does not certify the data. Existing previews are cleared, and Project publication stays blocked until the data is certified.</p>
      <footer><button type="button" onClick={onCancel} disabled={disabled}>Keep current data</button><button type="button" className="primary" onClick={onConfirm} disabled={disabled}><FileText size={13} /> Allow data that needs review &amp; refresh</button></footer>
    </section>
  </div>;
}
