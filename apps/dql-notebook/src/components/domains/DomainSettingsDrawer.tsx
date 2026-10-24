// Domain settings: create, edit, or delete a domain from the Modeling page.
//
// This was the form on the retired "Governed context › Domains" page. It lives
// in Modeling now so a domain is edited in the same place its models, terms,
// skills and blocks are — one place, one set of words.

import React, { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { Boxes, Loader2, Trash2, X } from 'lucide-react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { Theme } from '../../themes/notebook-theme';
import type { Domain } from '../../store/types';

export type DomainSettingsMode = { kind: 'create' } | { kind: 'edit'; domain: Domain };

/** Keep separators while typing so a space visibly becomes "-"; `slugify` settles the value on blur and save. */
function slugifyWhileTyping(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 64);
}

export function slugifyDomainId(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

const trimmedList = (values?: string[]) => (values ?? []).map((value) => value.trim()).filter(Boolean);
const trimmedText = (value?: string) => (value?.trim() ? value.trim() : undefined);

/** The payload the Domains API saves: trimmed text, empty text dropped, lists without blanks. */
export function domainSettingsPayload(draft: Domain): Domain {
  return {
    ...draft,
    id: draft.id.trim(),
    name: draft.name.trim(),
    owner: trimmedText(draft.owner),
    businessOwner: trimmedText(draft.businessOwner),
    parent: trimmedText(draft.parent),
    boundedContext: trimmedText(draft.boundedContext),
    description: trimmedText(draft.description),
    sourceSystems: trimmedList(draft.sourceSystems),
    primaryTerms: trimmedList(draft.primaryTerms),
    tags: trimmedList(draft.tags),
    inScope: trimmedList(draft.inScope),
    outOfScope: trimmedList(draft.outOfScope),
    dbtGroups: trimmedList(draft.dbtGroups),
    dbtPaths: trimmedList(draft.dbtPaths),
    dbtTags: trimmedList(draft.dbtTags),
    semanticDomains: trimmedList(draft.semanticDomains),
    semanticTags: trimmedList(draft.semanticTags),
  };
}

export function DomainSettingsDrawer({
  mode,
  domains,
  t,
  onClose,
  onSaved,
  onDeleted,
}: {
  mode: DomainSettingsMode;
  domains: Domain[];
  t: Theme;
  onClose: () => void;
  onSaved: (domain: Domain) => void;
  onDeleted?: (id: string) => void;
}): JSX.Element {
  const { dispatch } = useNotebook();
  const editing = mode.kind === 'edit';
  const [draft, setDraft] = useState<Domain>(() => (mode.kind === 'edit' ? { ...mode.domain } : { id: '', name: '', sourceSystems: [] }));
  const [idTouched, setIdTouched] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback(<K extends keyof Domain>(key: K, value: Domain[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }, []);

  const idCollision = !editing && draft.id.length > 0 && domains.some((domain) => domain.id === draft.id);
  const canSave = draft.id.trim().length > 0 && draft.name.trim().length > 0 && !idCollision && !saving;

  // Every surface that labels domains reads the store, so it is refreshed after a write.
  const refreshAuthoredDomains = useCallback(async () => {
    try {
      const { domains: next } = await api.getDomains();
      dispatch({ type: 'SET_AUTHORED_DOMAINS', domains: next });
    } catch { /* the list refreshes on the next load */ }
  }, [dispatch]);

  const save = useCallback(async () => {
    const payload = domainSettingsPayload(draft);
    setSaving(true);
    setError(null);
    try {
      const result = editing ? await api.updateDomain(payload.id, payload) : await api.createDomain(payload);
      await refreshAuthoredDomains();
      onSaved(result.domain ?? payload);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save this domain. Try again.');
    } finally {
      setSaving(false);
    }
  }, [draft, editing, onSaved, refreshAuthoredDomains]);

  const remove = useCallback(async () => {
    if (mode.kind !== 'edit') return;
    setSaving(true);
    setError(null);
    try {
      await api.deleteDomain(mode.domain.id);
      await refreshAuthoredDomains();
      onDeleted?.(mode.domain.id);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not delete this domain.');
      setConfirmDelete(false);
    } finally {
      setSaving(false);
    }
  }, [mode, onDeleted, refreshAuthoredDomains]);

  return (
    <div style={scrim} onClick={() => !saving && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Domain settings' : 'New domain'}
        style={panel(t)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape' && !saving) onClose(); }}
      >
        <div style={header(t)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Boxes size={16} strokeWidth={2} color={t.accent} />
            <div style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary }}>{editing ? 'Domain settings' : 'New domain'}</div>
          </div>
          <button type="button" onClick={() => !saving && onClose()} style={iconButton(t)} title="Close" aria-label="Close domain settings">
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 18px', display: 'grid', gap: 16 }}>
          <Field label="Name" t={t} hint={editing ? undefined : 'A short name for this business area, like Revenue or Customers.'}>
            <input
              type="text"
              autoFocus
              value={draft.name}
              onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value, ...(!editing && !idTouched ? { id: slugifyDomainId(event.target.value) } : {}) }))}
              placeholder="Revenue"
              style={input(t)}
            />
          </Field>
          <Field label="ID" t={t} hint={editing ? 'The id names the domain folder, so it cannot change here.' : 'Names the domain folder. Letters, numbers and dashes.'}>
            <input
              type="text"
              value={draft.id}
              disabled={editing}
              onChange={(event) => { setIdTouched(true); set('id', slugifyWhileTyping(event.target.value)); }}
              onBlur={() => set('id', slugifyDomainId(draft.id))}
              placeholder="revenue"
              style={{ ...input(t), fontFamily: t.fontMono, opacity: editing ? 0.7 : 1 }}
            />
            {idCollision ? <Note t={t} tone="error">A domain with this id already exists.</Note> : null}
          </Field>
          <Field label="Parent domain" t={t} hint="Optional. Put this domain inside a broader one.">
            <select value={draft.parent ?? ''} onChange={(event) => set('parent', event.target.value || undefined)} style={input(t)}>
              <option value="">None (top-level domain)</option>
              {domains.filter((domain) => domain.id !== draft.id).map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
            </select>
          </Field>
          <Field label="Description" t={t} hint="What this domain covers and how people use it. Ask reads this to decide whether a question belongs here.">
            <textarea value={draft.description ?? ''} onChange={(event) => set('description', event.target.value)} rows={4} placeholder="Recognized revenue, invoices and the saved queries that report them." style={textarea(t)} />
          </Field>
          <Field label="Covers" t={t} hint="The business boundary in one line.">
            <input type="text" value={draft.boundedContext ?? ''} onChange={(event) => set('boundedContext', event.target.value)} placeholder="Recognized revenue and invoicing" style={input(t)} />
          </Field>
          <Field label="In scope" t={t} hint="Topics that belong here. Press Enter after each.">
            <TagInput t={t} values={draft.inScope ?? []} onChange={(next) => set('inScope', next)} placeholder="Add a topic…" />
          </Field>
          <Field label="Out of scope" t={t} hint="Topics that belong to another domain. Ask uses these to avoid answering from the wrong place.">
            <TagInput t={t} values={draft.outOfScope ?? []} onChange={(next) => set('outOfScope', next)} placeholder="Add a topic…" />
          </Field>
          <Field label="Primary terms" t={t} hint="The business words that identify this domain.">
            <TagInput t={t} values={draft.primaryTerms ?? []} onChange={(next) => set('primaryTerms', next)} placeholder="Add a term…" />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <Field label="Owner" t={t} hint="The data team accountable.">
              <input type="text" value={draft.owner ?? ''} onChange={(event) => set('owner', event.target.value)} placeholder="finance-analytics" style={input(t)} />
            </Field>
            <Field label="Business owner" t={t} hint="Who owns the definitions.">
              <input type="text" value={draft.businessOwner ?? ''} onChange={(event) => set('businessOwner', event.target.value)} placeholder="Revenue Operations" style={input(t)} />
            </Field>
          </div>
          <Field label="Source systems" t={t}>
            <TagInput t={t} values={draft.sourceSystems ?? []} onChange={(next) => set('sourceSystems', next)} placeholder="Add a source system…" />
          </Field>
          <Field label="Tags" t={t}>
            <TagInput t={t} values={draft.tags ?? []} onChange={(next) => set('tags', next)} placeholder="Add a tag…" />
          </Field>
          {error ? <Note t={t} tone="error">{error}</Note> : null}
        </div>

        <div style={footer(t)}>
          {editing && onDeleted ? (
            confirmDelete ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 'auto', fontSize: 11.5, color: t.textSecondary }}>
                Delete {draft.name || draft.id}? Its files stay in Git history.
                <button type="button" onClick={() => void remove()} disabled={saving} style={dangerButton(t)}>Delete</button>
                <button type="button" onClick={() => setConfirmDelete(false)} disabled={saving} style={ghostButton(t)}>Keep</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} disabled={saving} style={{ ...ghostButton(t), marginRight: 'auto', color: t.error }}>
                <Trash2 size={13} /> Delete domain
              </button>
            )
          ) : null}
          <button type="button" onClick={() => !saving && onClose()} style={ghostButton(t)}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={!canSave} style={{ ...primaryButton(t), opacity: canSave ? 1 : 0.55 }}>
            {saving ? <Loader2 size={13} strokeWidth={2} /> : null}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create domain'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TagInput({ t, values, onChange, placeholder }: { t: Theme; values: string[]; onChange: (next: string[]) => void; placeholder: string }): JSX.Element {
  const [query, setQuery] = useState('');
  const add = (value: string) => {
    const next = value.trim();
    if (!next || values.includes(next)) return;
    onChange([...values, next]);
    setQuery('');
  };
  return (
    <div style={{ display: 'grid', gap: 7 }}>
      {values.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {values.map((value) => (
            <span key={value} style={chip(t)}>
              {value}
              <button type="button" onClick={() => onChange(values.filter((item) => item !== value))} style={chipRemove(t)} title={`Remove ${value}`} aria-label={`Remove ${value}`}>
                <X size={11} strokeWidth={2.4} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(query); } }}
        onBlur={() => add(query)}
        placeholder={placeholder}
        style={input(t)}
      />
    </div>
  );
}

function Field({ label, hint, t, children }: { label: string; hint?: string; t: Theme; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{label}</label>
      {hint ? <div style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.45, marginTop: -2 }}>{hint}</div> : null}
      {children}
    </div>
  );
}

function Note({ t, tone, children }: { t: Theme; tone: 'error' | 'muted'; children: React.ReactNode }): JSX.Element {
  return <div role={tone === 'error' ? 'alert' : undefined} style={{ fontSize: 11.5, color: tone === 'error' ? t.error : t.textMuted, lineHeight: 1.45 }}>{children}</div>;
}

const scrim: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.42)', display: 'flex', justifyContent: 'flex-end', zIndex: 120 };
const panel = (t: Theme): CSSProperties => ({ width: 'min(560px, 100%)', height: '100%', background: t.appBg, borderLeft: `1px solid ${t.headerBorder}`, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 28px rgba(0,0,0,0.18)' });
const header = (t: Theme): CSSProperties => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${t.headerBorder}`, flexShrink: 0 });
const footer = (t: Theme): CSSProperties => ({ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '13px 18px', borderTop: `1px solid ${t.headerBorder}`, flexShrink: 0, flexWrap: 'wrap' });
const primaryButton = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 7, border: `1px solid ${t.accent}`, background: t.accent, color: '#ffffff', fontSize: 12.5, fontWeight: 700, fontFamily: t.font, cursor: 'pointer' });
const ghostButton = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 11px', borderRadius: 7, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textSecondary, fontSize: 12, fontWeight: 600, fontFamily: t.font, cursor: 'pointer' });
const dangerButton = (t: Theme): CSSProperties => ({ ...primaryButton(t), border: `1px solid ${t.error}`, background: t.error, padding: '5px 10px', fontSize: 12 });
const iconButton = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 7, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textSecondary, cursor: 'pointer', flexShrink: 0 });
const input = (t: Theme): CSSProperties => ({ width: '100%', border: `1px solid ${t.btnBorder}`, borderRadius: 7, background: t.cellBg, color: t.textPrimary, fontSize: 12.5, fontFamily: t.font, padding: '8px 10px', boxSizing: 'border-box' });
const textarea = (t: Theme): CSSProperties => ({ ...input(t), resize: 'vertical', lineHeight: 1.5, padding: '9px 11px' });
const chip = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600, color: t.textPrimary, background: `${t.accent}14`, border: `1px solid ${t.accent}38`, borderRadius: 6, padding: '3px 4px 3px 9px', fontFamily: t.fontMono });
const chipRemove = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', padding: 2, borderRadius: 4 });
