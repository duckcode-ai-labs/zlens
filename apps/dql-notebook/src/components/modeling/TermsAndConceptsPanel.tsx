// Terms & concepts: the business words Ask understands.
//
// A term teaches Ask a word ("sales" means the Revenue metric) with its rules
// and caveats. A concept names one business thing stored in more than one
// model ("customer" lives in stg_customers and customers), so Ask asks which
// one you mean instead of guessing. Terms save straight to their `.dql` file;
// a concept binds models, so it goes through the same reviewed proposal as
// every other modeling change.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { BookOpen, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { hostReadOnly, useHostUi } from '../../host/host-ui';
import { api, type BusinessTerm, type BusinessTermInput, type ContextAuthoringProposalV1, type DbtFirstModelingResponse } from '../../api/client';
import type { themes } from '../../themes/notebook-theme';

type Theme = (typeof themes)['dark'];
type ManifestBusinessConcept = NonNullable<DbtFirstModelingResponse['modeling']['concepts']>[string];

const TERM_KINDS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'metric', label: 'Metric', hint: 'A number people measure, like Revenue.' },
  { value: 'dimension', label: 'Dimension', hint: 'A way to group or filter, like Region.' },
  { value: 'entity', label: 'Business thing', hint: 'Something the business counts or tracks, like Customer.' },
  { value: '', label: 'Other', hint: 'Any other word with a business meaning.' },
];

/** Domains are written as ids or names ("commerce", "Commerce"): compare them the way the server does. */
export function sameDomain(left: string | undefined | null, right: string | undefined | null): boolean {
  const key = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return Boolean(left && right && key(left) === key(right));
}

/** What a term still needs before Ask can use it, in plain words. Empty means ready. */
export function termReadiness(term: Pick<BusinessTerm, 'synonyms' | 'metricRefs' | 'description' | 'termType'>): string[] {
  const gaps: string[] = [];
  if (!term.description?.trim()) gaps.push('Add a description so Ask can explain what the word means.');
  if (!(term.synonyms ?? []).length) gaps.push('Add the words people use, so Ask recognizes this term in a question.');
  if (term.termType === 'metric' && !(term.metricRefs ?? []).length) gaps.push('Link the metric this word means, so Ask measures the governed definition.');
  return gaps;
}

/** Why a term whose file says certified counts as a draft. */
export function certificationIssueText(issue: NonNullable<BusinessTerm['certificationIssue']>): string {
  return issue === 'changed'
    ? 'Edited after it was certified, so it counts as a draft. Certify it again once it is reviewed.'
    : 'Its file says certified, but nobody certified it, so it counts as a draft. Open it and click Certify.';
}

function certifiedLine(certification: NonNullable<BusinessTerm['certification']>): string {
  const who = certification.certifiedByName || certification.certifiedBy;
  const when = new Date(certification.certifiedAt);
  return Number.isNaN(when.getTime()) ? who : `${who} · ${when.toLocaleDateString()}`;
}

export function conceptLocalId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function TermsAndConceptsPanel({ data, domain, t, onProposal }: {
  data: DbtFirstModelingResponse;
  domain: string | null;
  t: Theme;
  onProposal: (proposal: ContextAuthoringProposalV1) => void;
}) {
  const [terms, setTerms] = useState<BusinessTerm[]>([]);
  const [metrics, setMetrics] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [termForm, setTermForm] = useState<{ term?: BusinessTerm } | null>(null);
  const [conceptForm, setConceptForm] = useState<{ concept?: ManifestBusinessConcept } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void api.getTerms()
      .then((result) => setTerms(result.terms ?? []))
      .catch((error) => { setTerms([]); setLoadError(error instanceof Error ? error.message : 'Could not load terms.'); })
      .finally(() => setLoading(false));
    void api.getSkillOptions().then((options) => setMetrics(Array.isArray(options?.metrics) ? options.metrics : [])).catch(() => setMetrics([]));
  }, []);
  useEffect(() => load(), [load]);

  const domainTerms = domain ? terms.filter((term) => sameDomain(term.domain, domain)) : terms;
  const projectWideTerms = domain ? terms.filter((term) => !term.domain) : [];
  const concepts = useMemo(
    () => Object.values(data.modeling.concepts ?? {}).filter((concept) => !domain || concept.domain === domain).sort((a, b) => a.name.localeCompare(b.name)),
    [data.modeling.concepts, domain],
  );
  const domainLabel = domain ?? 'all domains';
  const readOnly = hostReadOnly(useHostUi(), 'domains');

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Terms &amp; concepts</h2>
          <p style={{ margin: '6px 0 0', color: t.textSecondary, fontSize: 11.5, lineHeight: 1.55, maxWidth: 760 }}>
            <b>Terms</b> teach Ask your business words — "sales" means the Revenue metric — with the rules and caveats that go with them.{' '}
            <b>Concepts</b> name one business thing that is stored in more than one model, so Ask asks which one you mean instead of guessing.
          </p>
        </div>
      </div>

      <Section
        title={`Terms in ${domainLabel}`}
        count={domainTerms.length}
        action={readOnly ? undefined : <button type="button" onClick={() => setTermForm({})} style={primaryButton(t)}><Plus size={13} /> New term</button>}
        t={t}
      >
        {loading ? <Empty text="Loading terms…" t={t} /> : loadError ? <Empty text={loadError} t={t} tone="error" /> : domainTerms.length ? (
          <div style={grid}>{domainTerms.map((term) => <TermCard key={term.filePath} term={term} t={t} onEdit={readOnly ? undefined : () => setTermForm({ term })} />)}</div>
        ) : <Empty text={domain ? `No terms in ${domain} yet. Add the words people use when they ask about this domain.` : 'No terms yet.'} t={t} />}
      </Section>

      {projectWideTerms.length ? (
        <Section title="Project-wide terms" count={projectWideTerms.length} detail="These have no domain, so they apply to every question." t={t}>
          <div style={grid}>{projectWideTerms.map((term) => <TermCard key={term.filePath} term={term} t={t} onEdit={readOnly ? undefined : () => setTermForm({ term })} />)}</div>
        </Section>
      ) : null}

      <Section
        title={`Concepts in ${domainLabel}`}
        count={concepts.length}
        detail="Changes to a concept open a review before they are saved."
        action={readOnly ? undefined : <button type="button" onClick={() => setConceptForm({})} disabled={!Object.keys(data.modeling.entities).length} title={Object.keys(data.modeling.entities).length ? undefined : 'Add models to the map first'} style={secondaryButton(t)}><Plus size={13} /> New concept</button>}
        t={t}
      >
        {concepts.length ? (
          <div style={grid}>{concepts.map((concept) => <ConceptCard key={concept.qualifiedId} concept={concept} data={data} t={t} onEdit={readOnly ? undefined : () => setConceptForm({ concept })} />)}</div>
        ) : <Empty text="No concepts yet. Add one when the same business thing lives in several models." t={t} />}
      </Section>

      {termForm ? (
        <TermDrawer
          term={termForm.term}
          domain={domain}
          domains={Object.keys(data.modeling.packages)}
          metrics={metrics}
          t={t}
          onClose={() => setTermForm(null)}
          onSaved={() => { setTermForm(null); load(); }}
        />
      ) : null}
      {conceptForm ? (
        <ConceptDrawer
          concept={conceptForm.concept}
          domain={domain}
          data={data}
          t={t}
          onClose={() => setConceptForm(null)}
          onProposal={(proposal) => { setConceptForm(null); onProposal(proposal); }}
        />
      ) : null}
    </div>
  );
}

function TermCard({ term, t, onEdit }: { term: BusinessTerm; t: Theme; onEdit?: () => void }) {
  const gaps = termReadiness(term);
  const kind = TERM_KINDS.find((item) => item.value === (term.termType ?? ''))?.label ?? term.termType;
  return (
    <article style={card(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <BookOpen size={14} color={t.accent} />
        <b style={{ fontSize: 12.5 }}>{term.name}</b>
        {kind ? <Pill t={t}>{kind}</Pill> : null}
        <Pill t={t} tone={term.status === 'certified' ? 'good' : 'muted'}>{term.status ?? 'draft'}</Pill>
        {onEdit ? <button type="button" onClick={onEdit} aria-label={`Edit term ${term.name}`} title="Edit" style={{ ...iconButton(t), marginLeft: 'auto' }}><Pencil size={13} /></button> : null}
      </div>
      {term.description ? <p style={{ margin: '7px 0 0', color: t.textSecondary, fontSize: 11, lineHeight: 1.5 }}>{term.description}</p> : null}
      {(term.synonyms ?? []).length ? <Line label="Words people use" t={t}>{(term.synonyms ?? []).join(', ')}</Line> : null}
      {(term.metricRefs ?? []).length ? <Line label="Measured by" t={t}><code>{(term.metricRefs ?? []).join(', ')}</code></Line> : null}
      {(term.businessRules ?? []).length ? <Line label="Rules" t={t}>{(term.businessRules ?? []).length}</Line> : null}
      {term.certification ? <Line label="Certified by" t={t}>{certifiedLine(term.certification)}</Line> : null}
      {term.certificationIssue ? <div style={{ marginTop: 8, color: 'var(--status-warning)', fontSize: 10.5, lineHeight: 1.45 }}>{certificationIssueText(term.certificationIssue)}</div> : null}
      {!term.certificationIssue && gaps.length ? <div style={{ marginTop: 8, color: 'var(--status-warning)', fontSize: 10.5, lineHeight: 1.45 }}>{gaps[0]}</div> : null}
      <code style={{ display: 'block', marginTop: 8, color: t.textMuted, fontSize: 9.5 }}>{term.filePath}</code>
    </article>
  );
}

function ConceptCard({ concept, data, t, onEdit }: { concept: ManifestBusinessConcept; data: DbtFirstModelingResponse; t: Theme; onEdit?: () => void }) {
  return (
    <article style={card(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <b style={{ fontSize: 12.5 }}>{concept.name}</b>
        <Pill t={t} tone={concept.status === 'certified' ? 'good' : 'muted'}>{concept.status === 'review' ? 'reviewed' : concept.status}</Pill>
        {onEdit ? <button type="button" onClick={onEdit} aria-label={`Edit concept ${concept.name}`} title="Edit" style={{ ...iconButton(t), marginLeft: 'auto' }}><Pencil size={13} /></button> : null}
      </div>
      {concept.description ? <p style={{ margin: '7px 0 0', color: t.textSecondary, fontSize: 11, lineHeight: 1.5 }}>{concept.description}</p> : null}
      <Line label="Stored in" t={t}>
        {concept.bindings.map((binding) => {
          const entity = data.modeling.entities[binding.entity];
          return `${entity?.businessName || entity?.localId || binding.entity}${binding.role === 'canonical' ? ' (main)' : ''}`;
        }).join(', ') || 'no models'}
      </Line>
      {concept.synonyms.length ? <Line label="Words people use" t={t}>{concept.synonyms.join(', ')}</Line> : null}
      {concept.bindings.length < 2 ? <div style={{ marginTop: 8, color: t.textMuted, fontSize: 10.5 }}>Bound to one model: Ask treats it like a term.</div> : null}
    </article>
  );
}

function TermDrawer({ term, domain, domains, metrics, t, onClose, onSaved }: {
  term?: BusinessTerm;
  domain: string | null;
  domains: string[];
  metrics: string[];
  t: Theme;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(term);
  const [draft, setDraft] = useState<BusinessTermInput>(() => term
    ? { ...term }
    : { name: '', domain: domain ?? undefined, termType: 'metric', status: 'draft', synonyms: [], metricRefs: [], businessRules: [], caveats: [] });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const set = <K extends keyof BusinessTermInput>(key: K, value: BusinessTermInput[K]) => {
    setDirty(true);
    setDraft((previous) => ({ ...previous, [key]: value }));
  };
  const certified = term?.status === 'certified';
  const canCertify = Boolean(term) && !certified && term?.status !== 'deprecated';
  const gaps = termReadiness(draft);
  const kindHint = TERM_KINDS.find((item) => item.value === (draft.termType ?? ''))?.hint;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (term) await api.updateTerm(term.filePath, draft);
      else await api.createTerm(draft);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  // Certify the saved term (never unsaved edits): the server checks it and writes its receipt.
  const certify = async () => {
    if (!term) return;
    setBusy(true);
    setError(null);
    try {
      await api.certifyTerm(term.filePath, term.name);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!term) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTerm(term.filePath);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={editing ? `Edit ${term?.name}` : 'New term'} t={t} busy={busy} onClose={onClose}
      footer={<>
        {editing ? (confirmDelete
          ? <span style={{ marginRight: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 11.5 }}>Delete this term? <button type="button" onClick={() => void remove()} disabled={busy} style={dangerButton(t)}>Delete</button><button type="button" onClick={() => setConfirmDelete(false)} style={secondaryButton(t)}>Keep</button></span>
          : <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy} style={{ ...secondaryButton(t), marginRight: 'auto', color: t.error }}><Trash2 size={13} /> Delete</button>) : null}
        <button type="button" onClick={onClose} disabled={busy} style={secondaryButton(t)}>Cancel</button>
        {canCertify ? <button type="button" onClick={() => void certify()} disabled={busy || dirty} title={dirty ? 'Save your changes first: Certify certifies the saved term.' : 'Check the term and certify it'} style={{ ...secondaryButton(t), opacity: busy || dirty ? 0.55 : 1 }}>Certify</button> : null}
        <button type="button" onClick={() => void save()} disabled={busy || !draft.name.trim()} style={{ ...primaryButton(t), opacity: busy || !draft.name.trim() ? 0.55 : 1 }}>{busy ? <Loader2 size={13} /> : null}{editing ? 'Save term' : 'Create term'}</button>
      </>}
    >
      <Field label="Name" t={t}><input autoFocus value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder="Revenue" style={input(t)} /></Field>
      <Field label="What kind of word is it?" hint={kindHint} t={t}>
        <select value={draft.termType ?? ''} onChange={(event) => set('termType', event.target.value || undefined)} style={input(t)}>
          {TERM_KINDS.map((kind) => <option key={kind.value || 'other'} value={kind.value}>{kind.label}</option>)}
        </select>
      </Field>
      <Field label="Domain" hint={draft.domain ? undefined : 'No domain: the term applies to every question.'} t={t}>
        <select value={draft.domain ?? ''} onChange={(event) => set('domain', event.target.value || undefined)} style={input(t)}>
          <option value="">Project-wide</option>
          {domains.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </Field>
      <Field label="Meaning" t={t}><textarea value={draft.description ?? ''} onChange={(event) => set('description', event.target.value)} rows={3} placeholder="Gross money paid for orders, including tax." style={textarea(t)} /></Field>
      <Field label="Words people use" hint="Ask recognizes the term when a question uses any of these. Press Enter after each." t={t}>
        <ListInput values={draft.synonyms ?? []} onChange={(next) => set('synonyms', next)} placeholder="sales, gross revenue…" t={t} />
      </Field>
      <Field label="Measured by metric" hint={metrics.length ? 'The governed metric Ask uses when someone says this word.' : 'This project has no semantic metrics to link. A skill can point Ask at a certified saved query instead.'} t={t}>
        {metrics.length ? (
          <>
            <ListInput values={draft.metricRefs ?? []} onChange={(next) => set('metricRefs', next)} placeholder="Add a metric…" suggestions={metrics} t={t} />
          </>
        ) : null}
      </Field>
      <Field label="Business rules" hint="One per line. Ask shows these with answers that use the term." t={t}>
        <textarea value={(draft.businessRules ?? []).join('\n')} onChange={(event) => set('businessRules', event.target.value.split('\n'))} rows={3} placeholder="Use orders.order_total for gross revenue." style={textarea(t)} />
      </Field>
      <Field label="Caveats" hint="One per line." t={t}>
        <textarea value={(draft.caveats ?? []).join('\n')} onChange={(event) => set('caveats', event.target.value.split('\n'))} rows={2} placeholder="Product revenue excludes tax." style={textarea(t)} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Field label="Owner" t={t}><input value={draft.owner ?? ''} onChange={(event) => set('owner', event.target.value)} placeholder="analytics@company.com" style={input(t)} /></Field>
        <Field label="Status" hint={certified ? 'Changing the term makes it a draft until someone certifies it again.' : 'Save the term, then click Certify.'} t={t}>
          <select value={draft.status ?? 'draft'} onChange={(event) => set('status', event.target.value)} style={input(t)}>
            <option value="draft">Draft</option>
            {certified ? <option value="certified">Certified</option> : null}
            <option value="deprecated">Retired</option>
          </select>
        </Field>
      </div>
      {term?.certification ? <div style={{ fontSize: 11, color: t.textSecondary }}>Certified by {certifiedLine(term.certification)}</div> : null}
      {term?.certificationIssue ? <div style={{ fontSize: 11, color: 'var(--status-warning)', lineHeight: 1.5 }}>{certificationIssueText(term.certificationIssue)}</div> : null}
      {gaps.length ? <div style={{ border: '1px solid var(--status-warning)', borderRadius: 8, padding: '9px 11px', fontSize: 11, lineHeight: 1.5, color: t.textSecondary }}><b>Before Ask can rely on this term</b><ul style={{ margin: '5px 0 0', paddingLeft: 17 }}>{gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></div> : null}
      {error ? <div role="alert" style={{ color: t.error, fontSize: 11.5 }}>{error}</div> : null}
    </Drawer>
  );
}

function ConceptDrawer({ concept, domain, data, t, onClose, onProposal }: {
  concept?: ManifestBusinessConcept;
  domain: string | null;
  data: DbtFirstModelingResponse;
  t: Theme;
  onClose: () => void;
  onProposal: (proposal: ContextAuthoringProposalV1) => void;
}) {
  const packages = Object.keys(data.modeling.packages);
  const [conceptDomain, setConceptDomain] = useState(concept?.domain ?? domain ?? packages[0] ?? '');
  const [name, setName] = useState(concept?.name ?? '');
  const [description, setDescription] = useState(concept?.description ?? '');
  const [synonyms, setSynonyms] = useState<string[]>(concept?.synonyms ?? []);
  const [rule, setRule] = useState(concept?.rule ?? '');
  const [status, setStatus] = useState<string>(concept?.status === 'certified' ? 'certified' : 'draft');
  const [bindings, setBindings] = useState<Array<{ entity: string; role: 'canonical' | 'conformed' }>>(
    concept?.bindings.map((binding) => ({ entity: binding.entity, role: binding.role })) ?? [{ entity: '', role: 'canonical' }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entities = Object.entries(data.modeling.entities)
    .map(([recordKey, entity]) => ({ recordKey, entity }))
    .sort((a, b) => (a.entity.domain === conceptDomain ? 0 : 1) - (b.entity.domain === conceptDomain ? 0 : 1) || (a.entity.businessName || a.entity.localId).localeCompare(b.entity.businessName || b.entity.localId));
  const id = concept?.localId ?? conceptLocalId(name);
  const ready = Boolean(conceptDomain && id && bindings.some((binding) => binding.entity));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = {
        id,
        domain: conceptDomain,
        name: name.trim() || id,
        description: description.trim() || undefined,
        synonyms,
        bindings: bindings.filter((binding) => binding.entity).map((binding) => {
          const entity = data.modeling.entities[binding.entity];
          // Same-domain bindings use the local id the source file is written with.
          return { entity: entity && entity.domain === conceptDomain ? entity.localId : binding.entity, role: binding.role };
        }),
        rule: rule.trim() || undefined,
        status: status as 'draft' | 'certified',
        origin: 'manual' as const,
      };
      const proposal = await api.createContextProposal({
        origin: 'manual',
        expectedSnapshotId: data.snapshotId,
        operations: [{ id: `manual:upsert_concept:${id}`, kind: 'modeling_change', change: { operation: 'upsert_concept', value }, evidence: ['Terms & concepts tab'] }],
      });
      onProposal(proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={concept ? `Edit ${concept.name}` : 'New concept'} t={t} busy={busy} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy} style={secondaryButton(t)}>Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={busy || !ready} style={{ ...primaryButton(t), opacity: busy || !ready ? 0.55 : 1 }}>{busy ? <Loader2 size={13} /> : null}Review change</button>
      </>}
    >
      <Field label="Name" t={t}><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Customer" style={input(t)} /></Field>
      {!concept && id ? <div style={{ color: t.textMuted, fontSize: 10.5, marginTop: -8 }}>id: <code>{id}</code></div> : null}
      <Field label="Domain" t={t}>
        <select value={conceptDomain} disabled={Boolean(concept)} onChange={(event) => setConceptDomain(event.target.value)} style={input(t)}>
          {packages.map((pkg) => <option key={pkg} value={pkg}>{pkg}</option>)}
        </select>
      </Field>
      <Field label="Meaning" t={t}><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="A person who has placed at least one order." style={textarea(t)} /></Field>
      <Field label="Words people use" t={t}><ListInput values={synonyms} onChange={setSynonyms} placeholder="shopper, buyer…" t={t} /></Field>
      <Field label="Stored in" hint="Every model that holds this thing. Mark the one Ask should prefer as the main one." t={t}>
        <div style={{ display: 'grid', gap: 7 }}>
          {bindings.map((binding, index) => (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 130px 30px', gap: 7, alignItems: 'center' }}>
              <select aria-label={`Model ${index + 1}`} value={binding.entity} onChange={(event) => setBindings((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, entity: event.target.value } : item))} style={input(t)}>
                <option value="">Choose a model…</option>
                {entities.map(({ recordKey, entity }) => <option key={recordKey} value={recordKey}>{entity.businessName || entity.localId}{entity.domain !== conceptDomain ? ` (${entity.domain})` : ''}</option>)}
              </select>
              <select aria-label={`Role of model ${index + 1}`} value={binding.role} onChange={(event) => setBindings((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value as 'canonical' | 'conformed' } : item))} style={input(t)}>
                <option value="canonical">Main</option>
                <option value="conformed">Also stored here</option>
              </select>
              <button type="button" aria-label={`Remove model ${index + 1}`} onClick={() => setBindings((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={bindings.length === 1} style={iconButton(t)}><X size={13} /></button>
            </div>
          ))}
          <button type="button" onClick={() => setBindings((current) => [...current, { entity: '', role: 'conformed' }])} style={{ ...secondaryButton(t), justifySelf: 'start' }}><Plus size={13} /> Add a model</button>
        </div>
      </Field>
      <Field label="How the copies relate (optional)" t={t}><input value={rule} onChange={(event) => setRule(event.target.value)} placeholder="customers is the cleaned version of stg_customers" style={input(t)} /></Field>
      <Field label="Status" hint="Certifying still opens a review before anything is saved." t={t}>
        <select value={status} onChange={(event) => setStatus(event.target.value)} style={input(t)}>
          <option value="draft">Draft</option>
          <option value="certified">Certified</option>
        </select>
      </Field>
      {error ? <div role="alert" style={{ color: t.error, fontSize: 11.5 }}>{error}</div> : null}
    </Drawer>
  );
}

function ListInput({ values, onChange, placeholder, suggestions, t }: { values: string[]; onChange: (next: string[]) => void; placeholder: string; suggestions?: string[]; t: Theme }) {
  const [query, setQuery] = useState('');
  const listId = useMemo(() => `terms-suggest-${Math.random().toString(36).slice(2)}`, []);
  const add = (raw: string) => {
    const additions = raw.split(',').map((value) => value.trim()).filter(Boolean).filter((value) => !values.includes(value));
    if (additions.length) onChange([...values, ...additions]);
    setQuery('');
  };
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {values.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {values.map((value) => (
            <span key={value} style={chip(t)}>
              {value}
              <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((item) => item !== value))} style={chipRemove(t)}><X size={11} /></button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        value={query}
        list={suggestions ? listId : undefined}
        onChange={(event) => {
          const next = event.target.value;
          // Picking from the datalist fills the whole value at once: take it.
          if (suggestions?.includes(next)) add(next);
          else setQuery(next);
        }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(query); } }}
        onBlur={() => add(query)}
        placeholder={placeholder}
        style={input(t)}
      />
      {suggestions ? <datalist id={listId}>{suggestions.filter((value) => !values.includes(value)).map((value) => <option key={value} value={value} />)}</datalist> : null}
    </div>
  );
}

function Drawer({ title, t, busy, onClose, footer, children }: { title: string; t: Theme; busy: boolean; onClose: () => void; footer: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.42)', display: 'flex', justifyContent: 'flex-end', zIndex: 120 }} onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }} style={{ width: 'min(560px, 100%)', height: '100%', background: t.appBg, borderLeft: `1px solid ${t.headerBorder}`, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 28px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${t.headerBorder}` }}>
          <b style={{ fontSize: 14 }}>{title}</b>
          <button type="button" aria-label="Close" onClick={() => !busy && onClose()} style={iconButton(t)}><X size={14} /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 18px', display: 'grid', gap: 15, alignContent: 'start' }}>{children}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: `1px solid ${t.headerBorder}`, flexWrap: 'wrap' }}>{footer}</div>
      </div>
    </div>
  );
}

function Section({ title, count, detail, action, t, children }: { title: string; count: number; detail?: string; action?: React.ReactNode; t: Theme; children: React.ReactNode }) {
  return (
    <section aria-label={title} style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 750 }}>{title}</h3>
        <small style={{ color: t.textMuted }}>{count}</small>
        {detail ? <span style={{ color: t.textMuted, fontSize: 10.5 }}>{detail}</span> : null}
        <span style={{ marginLeft: 'auto' }}>{action}</span>
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, t, children }: { label: string; hint?: string; t: Theme; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <label style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{label}</label>
      {hint ? <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.45 }}>{hint}</div> : null}
      {children}
    </div>
  );
}

function Line({ label, t, children }: { label: string; t: Theme; children: React.ReactNode }) {
  return <div style={{ marginTop: 6, fontSize: 10.5, color: t.textSecondary, lineHeight: 1.45 }}><span style={{ color: t.textMuted }}>{label}: </span>{children}</div>;
}

function Pill({ children, t, tone = 'muted' }: { children: React.ReactNode; t: Theme; tone?: 'good' | 'muted' }) {
  return <span style={{ fontSize: 9.5, fontWeight: 700, borderRadius: 999, padding: '1px 7px', border: `1px solid ${tone === 'good' ? 'var(--status-success)' : t.headerBorder}`, color: tone === 'good' ? 'var(--status-success)' : t.textMuted }}>{children}</span>;
}

function Empty({ text, t, tone }: { text: string; t: Theme; tone?: 'error' }) {
  return <div style={{ border: `1px dashed ${t.headerBorder}`, borderRadius: 9, padding: 16, color: tone === 'error' ? t.error : t.textMuted, fontSize: 11.5 }}>{text}</div>;
}

const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 };
const card = (t: Theme): CSSProperties => ({ border: `1px solid ${t.headerBorder}`, borderRadius: 10, padding: '11px 12px', background: t.cellBg, minWidth: 0 });
const input = (t: Theme): CSSProperties => ({ width: '100%', border: `1px solid ${t.btnBorder}`, borderRadius: 7, background: t.cellBg, color: t.textPrimary, fontSize: 12.5, fontFamily: t.font, padding: '8px 10px', boxSizing: 'border-box' });
const textarea = (t: Theme): CSSProperties => ({ ...input(t), resize: 'vertical', lineHeight: 1.5 });
const primaryButton = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 7, border: `1px solid ${t.accent}`, background: t.accent, color: '#ffffff', fontSize: 12, fontWeight: 700, fontFamily: t.font, cursor: 'pointer' });
const secondaryButton = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', borderRadius: 7, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textSecondary, fontSize: 12, fontWeight: 600, fontFamily: t.font, cursor: 'pointer' });
const dangerButton = (t: Theme): CSSProperties => ({ ...primaryButton(t), border: `1px solid ${t.error}`, background: t.error, padding: '4px 10px' });
const iconButton = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textSecondary, cursor: 'pointer', flexShrink: 0 });
const chip = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600, color: t.textPrimary, background: `${t.accent}14`, border: `1px solid ${t.accent}38`, borderRadius: 6, padding: '2px 4px 2px 8px' });
const chipRemove = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', padding: 2 });
