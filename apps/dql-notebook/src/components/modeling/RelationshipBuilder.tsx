// The relationship builder.
//
// A relationship reads as a sentence — "Each Order belongs to one Customer,
// matched on Order.customer_id = Customer.customer_id" — with the model named
// beside every column. Choosing the columns runs the warehouse check, which
// proposes the cardinality from the data; the person confirms it and picks
// what Ask may do with the relationship (Draft, Validated, Certified). Nothing
// is silently downgraded: a level that cannot be saved says why.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Loader2, Plus, RefreshCw, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { DEFAULT_MODEL_AREA_ID } from '@zlens/core/modeling-ids';
import type { DbtNodeAuthoringDetail, ManifestModelArea, ManifestModelRelationship, RelationshipAuthoringInput } from '@zlens/core';
import { api, type ContextAuthoringProposalV1, type DbtFirstModelingResponse, type RelationshipKeySuggestion } from '../../api/client';
import type { themes } from '../../themes/notebook-theme';
import { Modal, SearchPicker, iconButtonStyle, inputStyle, linkButton } from './modeling-controls';
import type { ModelingSearchOption } from './modeling-search';
import {
  CARDINALITY_CHOICES,
  discardEditWords,
  RELATIONSHIP_LEVELS,
  fanoutForCardinality,
  levelOfRelationship,
  lifecycleForLevel,
  nextRelationshipLocalId,
  proofSignature,
  relationshipProfileLines,
  relationshipSaveBlockers,
  relationshipSentence,
  type RelationshipCardinality,
  type RelationshipEvidence,
  type RelationshipLevel,
} from './relationship-builder-model';

type Theme = (typeof themes)['dark'];
type KeyPair = { from: string; to: string };

export type RelationshipBuilderDraft = { from: string; to: string; fromColumn?: string; toColumn?: string };

const csv = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
const SOURCE_LABEL: Record<RelationshipKeySuggestion['source'], string> = { dbt_test: 'dbt test', same_name: 'same name', named_for_table: 'named for the table' };

export function RelationshipBuilder({ data, relationship, draft, selectedDomain, selectedArea, t, onClose, onProposal, onFixWithAi }: {
  data: DbtFirstModelingResponse;
  relationship?: ManifestModelRelationship;
  draft?: RelationshipBuilderDraft;
  selectedDomain: string | null;
  selectedArea?: ManifestModelArea;
  t: Theme;
  onClose: () => void;
  onProposal: (proposal: ContextAuthoringProposalV1) => void;
  onFixWithAi: (relationshipId: string | null, evidence: unknown) => void;
}) {
  const existing = relationship;
  const entities = data.modeling.entities;
  const [from, setFrom] = useState(existing?.from ?? draft?.from ?? '');
  const [to, setTo] = useState(existing?.to ?? draft?.to ?? '');
  const [keys, setKeys] = useState<KeyPair[]>(() => existing?.keys.length
    ? existing.keys.map((key) => ({ ...key }))
    : [{ from: draft?.fromColumn ?? '', to: draft?.toColumn ?? '' }]);
  const [keysTouched, setKeysTouched] = useState(Boolean(existing || (draft?.fromColumn && draft?.toColumn)));
  const [cardinality, setCardinality] = useState<RelationshipCardinality>(existing?.cardinality ?? 'unknown');
  const [cardinalityTouched, setCardinalityTouched] = useState(Boolean(existing && existing.cardinality !== 'unknown'));
  const derivedFanout = fanoutForCardinality(cardinality);
  const [fanoutOverride, setFanoutOverride] = useState<RelationshipAuthoringInput['fanout'] | ''>(existing && existing.fanout !== fanoutForCardinality(existing.cardinality) ? existing.fanout : '');
  const fanout = fanoutOverride || derivedFanout;
  const [level, setLevel] = useState<RelationshipLevel>(levelOfRelationship(existing));
  const [retired, setRetired] = useState(existing?.status === 'deprecated');
  const [evidence, setEvidence] = useState<RelationshipEvidence | undefined>(existing?.validation);
  const [evidenceSignature, setEvidenceSignature] = useState<string | undefined>(existing?.validation ? proofSignature({ from: existing.from, to: existing.to, keys: existing.keys, cardinality: existing.cardinality, fanout: existing.fanout }) : undefined);
  const [proposed, setProposed] = useState<RelationshipCardinality | undefined>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<RelationshipKeySuggestion[]>([]);
  const [details, setDetails] = useState<Record<string, DbtNodeAuthoringDetail | undefined>>({});
  const ownerDomainOf = (item: ManifestModelRelationship) => item.ownerDomain ?? item.qualifiedId.split('::')[0] ?? '';
  const [domain, setDomain] = useState(() => (existing ? ownerDomainOf(existing) : '') || entities[from]?.domain || selectedDomain || Object.keys(data.modeling.packages)[0] || '');
  const [areaId, setAreaId] = useState(data.modeling.areas[existing?.areaId ?? '']?.localId ?? selectedArea?.localId ?? DEFAULT_MODEL_AREA_ID);
  const [id, setId] = useState(existing?.localId ?? '');
  const [idTouched, setIdTouched] = useState(Boolean(existing));
  const [verb, setVerb] = useState(existing?.verb ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [owner, setOwner] = useState(existing?.owner ?? '');
  const [joinTypes, setJoinTypes] = useState(existing?.joinTypes?.join(', ') ?? 'left');
  const [fromRole, setFromRole] = useState(existing?.roles?.from ?? '');
  const [toRole, setToRole] = useState(existing?.roles?.to ?? '');
  const [fromOptionality, setFromOptionality] = useState<'required' | 'optional' | 'unknown'>(existing?.optionality?.from ?? 'unknown');
  const [toOptionality, setToOptionality] = useState<'required' | 'optional' | 'unknown'>(existing?.optionality?.to ?? 'unknown');
  const [measureSources, setMeasureSources] = useState(existing?.aggregation?.measuresFrom.join(', ') ?? '');
  const [dimensionSources, setDimensionSources] = useState(existing?.aggregation?.dimensionsFrom.join(', ') ?? '');
  const [importRefs, setImportRefs] = useState(existing?.importRefs?.join(', ') ?? '');
  const [attributionBlock, setAttributionBlock] = useState(existing?.attributionBlock ?? '');
  const [evidenceExpiresAt, setEvidenceExpiresAt] = useState(existing?.evidenceExpiresAt ?? '');
  const [showDetails, setShowDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const initialSnapshot = useRef<string | null>(null);

  const fromEntity = entities[from];
  const toEntity = entities[to];
  const nameOf = (recordKey: string) => entities[recordKey]?.businessName || entities[recordKey]?.localId || 'this model';
  const fromName = from ? nameOf(from) : 'a model';
  const toName = to ? nameOf(to) : 'a model';
  const keysComplete = keys.length > 0 && keys.every((key) => key.from && key.to);
  const currentSignature = proofSignature({ from, to, keys, cardinality, fanout });
  const profileKey = from && to && keysComplete ? JSON.stringify([from, to, keys.map((key) => [key.from, key.to])]) : '';
  const lastProfiled = useRef<string>(existing?.validation && existing.keys.length ? JSON.stringify([existing.from, existing.to, existing.keys.map((key) => [key.from, key.to])]) : '');

  // Unsaved input is compared against what the builder opened with.
  const snapshot = JSON.stringify([from, to, keys, cardinality, fanoutOverride, level, retired, domain, areaId, id, verb, description, owner, joinTypes, fromRole, toRole, fromOptionality, toOptionality, measureSources, dimensionSources, importRefs, attributionBlock, evidenceExpiresAt]);
  if (initialSnapshot.current === null) initialSnapshot.current = snapshot;
  const dirty = snapshot !== initialSnapshot.current;
  const requestClose = () => { if (dirty && !busy) setConfirmDiscard(true); else onClose(); };

  useEffect(() => {
    const missing = [fromEntity?.dbtUniqueId, toEntity?.dbtUniqueId].filter((uniqueId): uniqueId is string => Boolean(uniqueId) && !details[uniqueId!]);
    if (!missing.length) return;
    let cancelled = false;
    void api.getDbtModelingNodes(missing).then(({ details: loaded }) => {
      if (!cancelled) setDetails((current) => ({ ...current, ...Object.fromEntries(loaded.map((detail) => [detail.uniqueId, detail])) }));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [fromEntity?.dbtUniqueId, toEntity?.dbtUniqueId]);

  // A short id per domain; a second relationship between the same models gets `_2`.
  useEffect(() => {
    if (idTouched || !fromEntity || !toEntity) return;
    const taken = Object.values(data.modeling.relationships).filter((item) => ownerDomainOf(item) === domain).map((item) => item.localId);
    setId(nextRelationshipLocalId(fromEntity.localId, toEntity.localId, taken));
  }, [from, to, domain, idTouched]);

  useEffect(() => {
    if (!from || !to) { setSuggestions([]); return; }
    let cancelled = false;
    void api.getRelationshipKeySuggestions(from, to).then(({ suggestions: next }) => {
      if (cancelled) return;
      setSuggestions(next);
      if (!keysTouched && next[0]) setKeys(next[0].keys.map((key) => ({ ...key })));
    }).catch(() => { if (!cancelled) setSuggestions([]); });
    return () => { cancelled = true; };
  }, [from, to]);

  const relationshipValue = (): RelationshipAuthoringInput => {
    const currentEvidence = evidence && evidenceSignature === currentSignature ? evidence : undefined;
    const status = retired ? 'deprecated' : lifecycleForLevel(level);
    return {
      id,
      domain,
      areaId: areaId || undefined,
      from,
      to,
      keys,
      cardinality,
      fanout,
      status,
      owner: owner || undefined,
      ownerDomain: domain,
      verb: verb || undefined,
      description: description || undefined,
      roles: fromRole || toRole ? { from: fromRole || undefined, to: toRole || undefined } : undefined,
      optionality: { from: fromOptionality, to: toOptionality },
      joinTypes: csv(joinTypes) as Array<'left' | 'inner'>,
      aggregation: measureSources || dimensionSources ? { measuresFrom: csv(measureSources), dimensionsFrom: csv(dimensionSources), requiresPreAggregation: fanout !== 'safe' } : undefined,
      attributionBlock: attributionBlock || undefined,
      importRefs: csv(importRefs),
      evidenceExpiresAt: evidenceExpiresAt || undefined,
      crossDomain: fromEntity?.domain !== toEntity?.domain,
      validation: currentEvidence,
      certifiedAgainst: status === 'certified' && fromEntity?.grain && toEntity?.grain
        ? { from: { grain: fromEntity.grain, keys: fromEntity.keys }, to: { grain: toEntity.grain, keys: toEntity.keys } }
        : undefined,
    };
  };

  /** Validate a cardinality the person chose over the proposal, so the evidence matches what is saved. */
  const validateChosen = async (chosen: RelationshipCardinality, chosenFanout: RelationshipAuthoringInput['fanout']) => {
    if (!from || !to || !keysComplete || !id) return;
    setChecking(true);
    setCheckError(null);
    try {
      const next = await api.validateModelingRelationship({ ...relationshipValue(), cardinality: chosen, fanout: chosenFanout }, data.snapshotId);
      setEvidence(next);
      setEvidenceSignature(proofSignature({ from, to, keys, cardinality: chosen, fanout: chosenFanout }));
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  const runProfile = async () => {
    if (!profileKey) return;
    lastProfiled.current = profileKey;
    setChecking(true);
    setCheckError(null);
    try {
      const profile = await api.profileModelingRelationship({ from, to, keys }, data.snapshotId);
      setProposed(profile.proposed.cardinality);
      if (!cardinalityTouched || cardinality === 'unknown' || cardinality === profile.proposed.cardinality) {
        setCardinality(profile.proposed.cardinality);
        setFanoutOverride('');
        setEvidence(profile.evidence);
        setEvidenceSignature(proofSignature({ from, to, keys, cardinality: profile.proposed.cardinality, fanout: profile.proposed.fanout }));
      } else {
        setChecking(false);
        await validateChosen(cardinality, fanout);
        return;
      }
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  // Choosing the columns runs the check; nobody has to find a Validate button.
  useEffect(() => {
    if (!profileKey || profileKey === lastProfiled.current) return;
    const timer = window.setTimeout(() => { void runProfile(); }, 450);
    return () => window.clearTimeout(timer);
  }, [profileKey]);

  const changeCardinality = (next: RelationshipCardinality) => {
    setCardinality(next);
    setCardinalityTouched(true);
    setFanoutOverride('');
    void validateChosen(next, fanoutForCardinality(next));
  };

  const swap = () => {
    setFrom(to);
    setTo(from);
    setKeys((current) => current.map((key) => ({ from: key.to, to: key.from })));
    setCardinality((current) => (current === 'many_to_one' ? 'one_to_many' : current === 'one_to_many' ? 'many_to_one' : current));
    setEvidence(undefined);
    setEvidenceSignature(undefined);
    lastProfiled.current = '';
  };

  const updateKey = (index: number, side: 'from' | 'to', value: string) => {
    setKeysTouched(true);
    setKeys((current) => current.map((key, keyIndex) => (keyIndex === index ? { ...key, [side]: value } : key)));
  };

  const blockers = relationshipSaveBlockers({
    level: retired ? 'draft' : level,
    keysComplete: Boolean(from && to) && keysComplete,
    evidence,
    evidenceSignature,
    currentSignature,
    fromName,
    toName,
    fromGrain: fromEntity?.grain,
    toGrain: toEntity?.grain,
    fromKeys: fromEntity?.keys,
    toKeys: toEntity?.keys,
  });
  if (!from || !to) blockers.unshift('Choose both models.');
  if (!id) blockers.push('The relationship needs an id.');

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const value = relationshipValue();
      const proposal = await api.createContextProposal({
        origin: 'manual',
        expectedSnapshotId: data.snapshotId,
        operations: [{
          id: `manual:upsert_relationship:${id}`,
          kind: 'modeling_change',
          change: { operation: 'upsert_relationship', value },
          evidence: ['Relationship builder', ...(value.validation ? [`warehouse check ${value.validation.status} ${value.validation.checkedAt}`] : [])],
        }],
      });
      onProposal(proposal);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const entityOptions: ModelingSearchOption[] = useMemo(() => Object.entries(entities).map(([recordKey, entity]) => {
    const node = data.dbtProvenance.nodes[entity.dbtUniqueId];
    return { value: recordKey, label: entity.businessName || entity.localId || entity.id, description: `${entity.domain} · ${node?.relation ?? node?.name ?? entity.dbtUniqueId}`, keywords: [entity.qualifiedId, entity.businessContext ?? ''] };
  }), [entities, data.dbtProvenance.nodes]);
  const columnsOf = (recordKey: string) => details[entities[recordKey]?.dbtUniqueId ?? '']?.columns ?? [];
  const columnsLoaded = (recordKey: string) => Boolean(details[entities[recordKey]?.dbtUniqueId ?? '']);
  const areas = Object.values(data.modeling.areas).filter((area) => area.domain === domain);
  const evidenceIsCurrent = Boolean(evidence && evidenceSignature === currentSignature);

  return (
    <Modal title={existing ? 'Edit relationship' : 'New relationship'} t={t} onClose={requestClose} width={760}>
      <div style={{ display: 'grid', gap: 14 }}>
        {confirmDiscard ? (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px', borderRadius: 8, border: '1px solid var(--status-warning)', fontSize: 11.5 }}>
            {/* Closing only drops the edit; the label says so (new-user round 2, problem 10). */}
            <span style={{ flex: 1 }}>{discardEditWords(Boolean(existing)).question}</span>
            <button type="button" onClick={onClose} style={buttonStyle(t, 'danger')}>{discardEditWords(Boolean(existing)).action}</button>
            <button type="button" onClick={() => setConfirmDiscard(false)} style={buttonStyle(t)}>Keep editing</button>
          </div>
        ) : null}

        <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--accent-dim)', color: t.textPrimary, fontSize: 14, fontWeight: 650, lineHeight: 1.45 }}>
          {from && to ? relationshipSentence(cardinality, fromName, toName) : 'Choose the two models this relationship connects.'}
          {from && to && keysComplete ? <div style={{ marginTop: 4, fontSize: 11.5, fontWeight: 500, color: t.textSecondary }}>Matched on {keys.map((key) => `${fromName}.${key.from} = ${toName}.${key.to}`).join(' and ')}</div> : null}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr) auto', gap: 8, alignItems: 'end' }}>
          <Labeled label="Each" t={t}>
            <SearchPicker ariaLabel="From model" value={from} onChange={(value) => { setFrom(value); setEvidence(undefined); }} options={entityOptions} placeholder="Search models…" t={t} />
          </Labeled>
          <Labeled label=" " t={t}>
            <select aria-label="How they relate" value={cardinality === 'unknown' ? '' : cardinality} onChange={(event) => changeCardinality(event.target.value as RelationshipCardinality)} style={{ ...inputStyle(t), width: 'auto' }}>
              <option value="" disabled>relates to</option>
              {CARDINALITY_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}{proposed === choice.value ? ' (from the data)' : ''}</option>)}
            </select>
          </Labeled>
          <Labeled label=" " t={t}>
            <SearchPicker ariaLabel="To model" value={to} onChange={(value) => { setTo(value); setEvidence(undefined); }} options={entityOptions.filter((option) => option.value !== from)} placeholder="Search models…" t={t} />
          </Labeled>
          <button type="button" aria-label="Swap the two models" title="Swap the two models" onClick={swap} disabled={!from || !to} style={{ ...iconButtonStyle(t), height: 33 }}><ArrowLeftRight size={14} /></button>
        </div>

        <section aria-label="Matching columns" style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700 }}>Matched on</div>
          {keys.map((key, index) => (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 18px minmax(0, 1fr) 30px', gap: 7, alignItems: 'center' }}>
              <ColumnSelect label={`${fromName} column ${index + 1}`} modelName={fromName} value={key.from} columns={columnsOf(from)} loaded={columnsLoaded(from)} disabled={!from} onChange={(value) => updateKey(index, 'from', value)} t={t} />
              <span aria-hidden="true" style={{ textAlign: 'center', color: t.textMuted }}>=</span>
              <ColumnSelect label={`${toName} column ${index + 1}`} modelName={toName} value={key.to} columns={columnsOf(to)} loaded={columnsLoaded(to)} disabled={!to} onChange={(value) => updateKey(index, 'to', value)} t={t} />
              <button type="button" aria-label={`Remove column pair ${index + 1}`} title="Remove" disabled={keys.length === 1} onClick={() => { setKeysTouched(true); setKeys((current) => current.filter((_, keyIndex) => keyIndex !== index)); }} style={iconButtonStyle(t)}><XCircle size={14} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => { setKeysTouched(true); setKeys((current) => [...current, { from: '', to: '' }]); }} disabled={!from || !to} style={linkButton(t)}><Plus size={12} /> Add another column pair</button>
            {suggestions.filter((suggestion) => JSON.stringify(suggestion.keys) !== JSON.stringify(keys)).slice(0, 3).map((suggestion) => (
              <button key={JSON.stringify(suggestion.keys)} type="button" title={suggestion.reason} onClick={() => { setKeysTouched(true); setKeys(suggestion.keys.map((pair) => ({ ...pair }))); }} style={{ ...linkButton(t), display: 'inline-flex', alignItems: 'center', gap: 4, border: `1px solid ${t.headerBorder}`, borderRadius: 999, padding: '3px 9px' }}>
                <Sparkles size={11} /> {suggestion.keys.map((pair) => `${pair.from} = ${pair.to}`).join(', ')} · {SOURCE_LABEL[suggestion.source]}
              </button>
            ))}
          </div>
        </section>

        <section aria-label="Warehouse check" style={{ border: `1px solid ${evidenceIsCurrent ? (evidence?.status === 'passed' ? '#2e9b6355' : '#c94b5555') : t.headerBorder}`, borderRadius: 9, padding: '10px 12px', background: t.cellBg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={14} color={evidenceIsCurrent && evidence?.status === 'passed' ? '#2e9b63' : t.textMuted} />
            <b style={{ fontSize: 11.5 }}>
              {checking ? 'Checking in the warehouse…' : evidenceIsCurrent ? (evidence?.status === 'passed' ? 'Safe to join' : 'Not safe to join as described') : 'Warehouse check'}
            </b>
            {checking ? <Loader2 size={13} /> : null}
            <button type="button" onClick={() => void runProfile()} disabled={!profileKey || checking} style={{ ...linkButton(t), marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}><RefreshCw size={11} /> Check again</button>
          </div>
          {checkError ? <div role="alert" style={{ marginTop: 6, color: t.error, fontSize: 11 }}>{checkError}</div> : null}
          {!checking && !checkError && evidenceIsCurrent && evidence ? (
            <>
              <ul style={{ margin: '7px 0 0', paddingLeft: 17, color: t.textSecondary, fontSize: 11, lineHeight: 1.55 }}>
                {relationshipProfileLines(evidence, fromName, toName).map((line) => <li key={line}>{line}</li>)}
              </ul>
              {proposed && proposed !== cardinality ? <div style={{ marginTop: 6, fontSize: 11, color: 'var(--status-warning)' }}>The data says each {fromName} {CARDINALITY_CHOICES.find((choice) => choice.value === proposed)?.label} {toName}. <button type="button" onClick={() => changeCardinality(proposed)} style={linkButton(t)}>Use that</button></div> : null}
              {evidence.status !== 'passed' ? <button type="button" onClick={() => onFixWithAi(existing?.qualifiedId ?? null, evidence)} style={{ ...linkButton(t), marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Sparkles size={12} /> Ask Modeling AI how to fix it</button> : null}
            </>
          ) : !checking && !checkError ? (
            <div style={{ marginTop: 5, color: t.textMuted, fontSize: 11 }}>{profileKey ? 'The keys changed since the last check.' : 'Choose the matching columns and the join is checked in the warehouse automatically.'}</div>
          ) : null}
        </section>

        <section aria-label="Save as" style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700 }}>What Ask may do with it</div>
          <div role="radiogroup" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
            {RELATIONSHIP_LEVELS.map((choice) => {
              const active = level === choice.value && !retired;
              return (
                <button key={choice.value} type="button" role="radio" aria-checked={active} onClick={() => { setLevel(choice.value); setRetired(false); }} style={{ textAlign: 'left', border: `1.5px solid ${active ? t.accent : t.headerBorder}`, borderRadius: 9, padding: '9px 10px', background: active ? 'var(--accent-dim)' : t.cellBg, color: t.textPrimary, cursor: 'pointer' }}>
                  <b style={{ fontSize: 11.5 }}>{choice.label}</b>
                  <div style={{ marginTop: 3, fontSize: 10.5, color: t.textSecondary, lineHeight: 1.4 }}>{choice.meaning}</div>
                </button>
              );
            })}
          </div>
          {blockers.length ? (
            <ul style={{ margin: 0, paddingLeft: 17, color: 'var(--status-warning)', fontSize: 11, lineHeight: 1.5 }}>
              {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          ) : null}
          {fromEntity && toEntity && fromEntity.domain !== toEntity.domain ? <div style={{ fontSize: 11, color: t.textSecondary }}>These models are in different domains ({fromEntity.domain} and {toEntity.domain}). Ask joins them only for a purpose the providing domain approves.</div> : null}
        </section>

        <button type="button" onClick={() => setShowDetails((value) => !value)} style={{ ...linkButton(t), justifySelf: 'start', padding: 0 }}>{showDetails ? 'Hide details' : 'More details (name, description, advanced rules)'}</button>
        {showDetails ? (
          <div style={{ display: 'grid', gap: 10, padding: 12, border: `1px solid ${t.headerBorder}`, borderRadius: 9 }}>
            <div style={twoColumns}>
              <Labeled label="Business verb" t={t}><input value={verb} onChange={(event) => setVerb(event.target.value)} placeholder="placed by" style={inputStyle(t)} /></Labeled>
              <Labeled label="Id" t={t}><input value={id} onChange={(event) => { setIdTouched(true); setId(event.target.value.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase()); }} disabled={Boolean(existing)} style={{ ...inputStyle(t), fontFamily: t.fontMono }} /></Labeled>
            </div>
            <Labeled label="Description" t={t}><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Why this relationship exists and when to use it" style={inputStyle(t)} /></Labeled>
            <div style={twoColumns}>
              <Labeled label="Domain" t={t}>
                <select value={domain} disabled={Boolean(existing)} onChange={(event) => setDomain(event.target.value)} style={inputStyle(t)}>
                  {Object.keys(data.modeling.packages).map((pkg) => <option key={pkg} value={pkg}>{pkg}</option>)}
                </select>
              </Labeled>
              <Labeled label="Subject area" t={t}>
                <select value={areaId} onChange={(event) => setAreaId(event.target.value)} style={inputStyle(t)}>
                  {areas.length === 0 ? <option value={areaId}>{areaId}</option> : null}
                  {areas.map((area) => <option key={area.localId} value={area.localId}>{area.name}</option>)}
                </select>
              </Labeled>
            </div>
            <div style={twoColumns}>
              <Labeled label="When rows repeat" t={t}>
                <select value={fanoutOverride} onChange={(event) => { const next = event.target.value as RelationshipAuthoringInput['fanout'] | ''; setFanoutOverride(next); void validateChosen(cardinality, next || derivedFanout); }} style={inputStyle(t)}>
                  <option value="">Follow the cardinality ({derivedFanout})</option>
                  <option value="dedupe_required">Deduplicate before joining</option>
                  <option value="attribution_required">Needs an attribution block</option>
                  <option value="forbidden">Never join automatically</option>
                </select>
              </Labeled>
              <Labeled label="Allowed join types" t={t}><input value={joinTypes} onChange={(event) => setJoinTypes(event.target.value)} placeholder="left, inner" style={inputStyle(t)} /></Labeled>
            </div>
            <div style={twoColumns}>
              <Labeled label={`${fromName} role`} t={t}><input value={fromRole} onChange={(event) => setFromRole(event.target.value)} style={inputStyle(t)} /></Labeled>
              <Labeled label={`${toName} role`} t={t}><input value={toRole} onChange={(event) => setToRole(event.target.value)} style={inputStyle(t)} /></Labeled>
            </div>
            <div style={twoColumns}>
              <Labeled label={`Every ${fromName} has a ${toName}?`} t={t}><Optionality value={fromOptionality} onChange={setFromOptionality} t={t} /></Labeled>
              <Labeled label={`Every ${toName} has a ${fromName}?`} t={t}><Optionality value={toOptionality} onChange={setToOptionality} t={t} /></Labeled>
            </div>
            <div style={twoColumns}>
              <Labeled label="Measures may come from" t={t}><input value={measureSources} onChange={(event) => setMeasureSources(event.target.value)} placeholder="order" style={inputStyle(t)} /></Labeled>
              <Labeled label="Dimensions may come from" t={t}><input value={dimensionSources} onChange={(event) => setDimensionSources(event.target.value)} placeholder="customer" style={inputStyle(t)} /></Labeled>
            </div>
            <div style={twoColumns}>
              <Labeled label="Required import" t={t}><input value={importRefs} onChange={(event) => setImportRefs(event.target.value)} placeholder="commerce.customer@1" style={inputStyle(t)} /></Labeled>
              <Labeled label="Attribution block" t={t}><input value={attributionBlock} onChange={(event) => setAttributionBlock(event.target.value)} placeholder="growth.revenue_by_channel" style={inputStyle(t)} /></Labeled>
            </div>
            <div style={twoColumns}>
              <Labeled label="Check expires on" t={t}><input value={evidenceExpiresAt} onChange={(event) => setEvidenceExpiresAt(event.target.value)} placeholder="2026-12-31" style={inputStyle(t)} /></Labeled>
              <Labeled label="Owner" t={t}><input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="team@company.com" style={inputStyle(t)} /></Labeled>
            </div>
            {existing ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11 }}>
                <input type="checkbox" checked={retired} onChange={(event) => setRetired(event.target.checked)} /> Retire this relationship (Ask ignores it)
              </label>
            ) : null}
          </div>
        ) : null}

        {message ? <div role="alert" style={{ color: t.error, fontSize: 11.5 }}>{message}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={requestClose} disabled={busy} style={buttonStyle(t)}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy || checking || blockers.length > 0} style={{ ...buttonStyle(t, 'primary'), opacity: busy || checking || blockers.length ? 0.55 : 1 }}>
            {busy ? <Loader2 size={13} /> : null} Review change
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ColumnSelect({ label, modelName, value, columns, loaded, disabled, onChange, t }: { label: string; modelName: string; value: string; columns: Array<{ name: string; type?: string }>; loaded: boolean; disabled: boolean; onChange: (value: string) => void; t: Theme }) {
  const names = columns.map((column) => column.name);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', alignItems: 'center', border: `1px solid ${t.headerBorder}`, borderRadius: 6, background: t.cellBg, overflow: 'hidden', opacity: disabled ? 0.6 : 1 }}>
      <span style={{ padding: '0 7px', fontSize: 10.5, color: t.textMuted, fontFamily: t.fontMono, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelName}.</span>
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} style={{ ...inputStyle(t), border: 'none', borderRadius: 0, fontFamily: t.fontMono }}>
        <option value="">{columns.length ? 'column…' : loaded ? 'no columns found' : 'loading columns…'}</option>
        {value && !names.includes(value) ? <option value={value}>{value}</option> : null}
        {columns.map((column) => <option key={column.name} value={column.name}>{column.name}{column.type ? `  (${column.type.toLowerCase()})` : ''}</option>)}
      </select>
    </div>
  );
}

function Optionality({ value, onChange, t }: { value: 'required' | 'optional' | 'unknown'; onChange: (value: 'required' | 'optional' | 'unknown') => void; t: Theme }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as 'required' | 'optional' | 'unknown')} style={inputStyle(t)}>
      <option value="unknown">Not sure</option>
      <option value="required">Always</option>
      <option value="optional">Not always</option>
    </select>
  );
}

function Labeled({ label, t, children }: { label: string; t: Theme; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 5, fontSize: 10.5, fontWeight: 650, color: t.textSecondary, minWidth: 0 }}>
      {label}
      {children}
    </label>
  );
}

const twoColumns: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 };

function buttonStyle(t: Theme, tone: 'primary' | 'danger' | 'default' = 'default'): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${tone === 'danger' ? t.error : tone === 'primary' ? t.accent : t.headerBorder}`,
    background: tone === 'danger' ? t.error : tone === 'primary' ? t.accent : t.appBg,
    color: tone === 'default' ? t.textPrimary : '#fff',
    borderRadius: 6,
    padding: '7px 11px',
    fontSize: 11,
    fontWeight: 650,
    cursor: 'pointer',
  };
}
