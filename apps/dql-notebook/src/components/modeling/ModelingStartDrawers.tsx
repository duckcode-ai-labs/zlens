import React, { useEffect, useMemo, useState } from 'react';
import { FileSearch, FolderOpen, Loader2, Search, Upload, X } from 'lucide-react';
import { api, type ContextAuthoringOperation, type ContextAuthoringProposalV1, type DbtFirstModelingResponse, type DbtModelInventoryItem, type ModelingImportSession } from '../../api/client';
import { DEFAULT_MODEL_AREA_ID } from '@zlens/core/modeling-ids';
import type { Theme } from '../../themes/notebook-theme';

/**
 * UI-019: the scope a new model lands in. Every model still belongs to exactly
 * one Domain and subject area, but an author who has not chosen one gets a
 * sensible prefilled default instead of a disabled button. The server creates
 * whichever part of the scope does not exist yet, inside the same reviewable
 * proposal.
 */
const DEFAULT_AREA_ID = DEFAULT_MODEL_AREA_ID;

function useAuthoringScope(data: DbtFirstModelingResponse, domain: string | null, areaId: string | null) {
  const existingArea = data.modeling.areas[areaId ?? ''];
  const domains = Object.keys(data.modeling.packages ?? {});
  const defaultDomain = domain
    ?? (domains.length === 1 ? domains[0]! : slug(data.dbtProvenance?.projectName ?? '').replace(/-/g, '_') || 'analytics');
  const [scopeDomain, setScopeDomain] = useState(defaultDomain);
  // The default area (`core`) shows as an empty box, "Not in an area yet" (simplification plan Z3).
  const [areaInput, setScopeArea] = useState(existingArea && existingArea.localId !== DEFAULT_AREA_ID ? existingArea.localId ?? existingArea.id : '');
  const scopeArea = areaInput.trim() || DEFAULT_AREA_ID;
  const domainIsNew = !domains.includes(scopeDomain);
  const areaIsNew = !Object.values(data.modeling.areas ?? {}).some(
    (candidate) => candidate.domain === scopeDomain && (candidate.localId === scopeArea || candidate.id === scopeArea),
  );
  return { scopeDomain, setScopeDomain, scopeArea, areaInput, setScopeArea, domains, domainIsNew, areaIsNew };
}

function ScopeFields({ scope, theme }: { scope: ReturnType<typeof useAuthoringScope>; theme: Theme }): JSX.Element {
  return <>
    <label style={label(theme)}>Domain
      <input aria-label="Domain" list="dql-scope-domains" value={scope.scopeDomain} onChange={(event) => scope.setScopeDomain(event.target.value)} style={input(theme)} />
      <datalist id="dql-scope-domains">{scope.domains.map((value) => <option key={value} value={value} />)}</datalist>
      <small style={{ color: scope.domainIsNew ? 'var(--status-warning)' : theme.textMuted }}>{scope.domainIsNew ? 'Will be created with these models.' : 'Existing Domain.'}</small>
    </label>
    <label style={label(theme)}>Area
      <input aria-label="Area" value={scope.areaInput} placeholder="Not in an area yet" onChange={(event) => scope.setScopeArea(event.target.value)} style={input(theme)} />
      <small style={{ color: scope.areaIsNew ? 'var(--status-warning)' : theme.textMuted }}>
        {!scope.areaInput.trim() ? 'Leave it empty and these tables stay in the Domain, not in an area yet.' : scope.areaIsNew ? 'Will be created with these tables.' : 'Existing area.'} An area is one focused diagram inside the Domain — it organizes source and sharpens retrieval, and never changes what an agent is allowed to use.
      </small>
    </label>
  </>;
}

export function AddModelsDrawer({ data, domain, areaId, theme, onClose, onProposal }: DrawerContextProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<DbtModelInventoryItem[]>([]);
  const [itemById, setItemById] = useState<Record<string, DbtModelInventoryItem>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useAuthoringScope(data, domain, areaId);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void api.getDbtModelInventory({ q: query, limit: 100, physicalOnly: true })
        .then((result) => {
          if (!active) return;
          const unbound = result.items.filter((item) => !item.binding);
          setItems(unbound);
          setItemById((current) => ({ ...current, ...Object.fromEntries(unbound.map((item) => [item.uniqueId, item])) }));
        })
        .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query]);

  const selectedItems = selected.flatMap((id) => itemById[id] ? [itemById[id]!] : []);
  const operations = useMemo(
    () => buildEntityOperations(data, scope.scopeDomain, scope.scopeArea, selectedItems),
    [data, scope.scopeArea, scope.scopeDomain, selectedItems],
  );
  const preview = async () => {
    setBusy(true); setError(null);
    try {
      const proposal = await api.createContextProposal({ origin: 'dbt_discovery', expectedSnapshotId: data.snapshot?.id, operations });
      onProposal(proposal);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <DrawerShell title="Add models" subtitle={`Step ${step} of 3 · ${step === 1 ? 'Select dbt models' : step === 2 ? 'Assign ownership' : 'Review proposal inputs'}`} theme={theme} busy={busy} onClose={onClose}>
    {step === 1 ? <>
      <div style={{ position: 'relative' }}><Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: theme.textMuted }} /><input autoFocus aria-label="Search dbt models" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search model name, package, or relation" style={{ ...input(theme), width: '100%', paddingLeft: 32 }} /></div>
      <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
        {items.map((item) => <label key={item.uniqueId} style={choice(theme)}><input type="checkbox" checked={selected.includes(item.uniqueId)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.uniqueId] : current.filter((id) => id !== item.uniqueId))} /><span style={{ flex: 1 }}><b style={{ display: 'block', fontSize: 11.5 }}>{item.name}</b><code style={{ color: theme.textMuted, fontSize: 9.5 }}>{item.uniqueId}</code></span><small style={{ color: theme.textMuted }}>{item.packageName}</small></label>)}
        {!items.length ? <Note theme={theme}>No unbound dbt models match this search.</Note> : null}
      </div>
    </> : step === 2 ? <>
      <ScopeFields scope={scope} theme={theme} />
      <Note theme={theme}>Every table gets exactly one Domain and at most one area. ZLens stores the dbt unique ID and business overlay; dbt-owned columns, SQL, tests, descriptions, and lineage remain in dbt.</Note>
    </> : <>
      <Note theme={theme}>{operations.length} sparse entity-binding patch{operations.length === 1 ? '' : 'es'} will be prepared. No source changes occur until the exact proposal is reviewed and explicitly saved.</Note>
      {selectedItems.map((item) => <div key={item.uniqueId} style={choice(theme)}><span style={{ flex: 1 }}><b style={{ display: 'block', fontSize: 11 }}>{item.name}</b><code style={{ fontSize: 9.5, color: theme.textMuted }}>{item.uniqueId}</code></span><span style={{ fontSize: 10, color: theme.textMuted }}>{scope.scopeDomain} / {scope.scopeArea}</span></div>)}
    </>}
    {error ? <div role="alert" style={{ color: 'var(--status-error)', fontSize: 11, marginTop: 10 }}>{error}</div> : null}
    <DrawerActions theme={theme} busy={busy} back={step > 1 ? () => setStep((step - 1) as 1 | 2) : undefined} next={step < 3 ? () => setStep((step + 1) as 2 | 3) : () => void preview()} nextLabel={step < 3 ? 'Continue' : 'Create review proposal'} disabled={selected.length === 0 || !scope.scopeDomain.trim() || !scope.scopeArea.trim()} />
  </DrawerShell>;
}

export function ModelingYamlImportDrawer({ data, domain, areaId, theme, onClose, onProposal }: DrawerContextProps): JSX.Element {
  const [mode, setMode] = useState<'current_project' | 'path' | 'upload' | 'paste'>('current_project');
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('modeling.yml');
  const [session, setSession] = useState<ModelingImportSession | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useAuthoringScope(data, domain, areaId);

  const discover = async () => {
    setBusy(true); setError(null);
    try {
      const next = await api.createModelingImport({ mode, ...(mode === 'path' ? { path } : {}), ...(mode === 'paste' || mode === 'upload' ? { content, filename } : {}) });
      setSession(next);
      setSelected(next.candidates.filter((candidate) => candidate.action === 'import').map((candidate) => candidate.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const preview = async () => {
    if (!session) return;
    setBusy(true); setError(null);
    try {
      const result = await api.previewModelingImport(session.id, { selectedCandidateIds: selected, domain: scope.scopeDomain, areaId: scope.scopeArea, expectedSnapshotId: data.snapshot?.id ?? '' });
      onProposal(result.proposal);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const readFile = (file?: File) => {
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => setContent(String(reader.result ?? ''));
    reader.onerror = () => setError('Could not read the selected YAML file.');
    reader.readAsText(file);
  };

  return <DrawerShell title="Import modeling YAML" subtitle={session ? 'Classify, select, and review' : 'Choose a safe import source'} theme={theme} busy={busy} onClose={onClose}>
    {!session ? <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {(['current_project', 'path', 'upload', 'paste'] as const).map((value) => <button key={value} type="button" onClick={() => setMode(value)} style={{ ...secondary(theme), ...(mode === value ? { borderColor: theme.accent, color: theme.accent, background: 'var(--accent-dim)' } : {}) }}>{value === 'current_project' ? 'Project' : value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
      {mode === 'current_project' ? <Note theme={theme}><FolderOpen size={13} style={{ verticalAlign: -2, marginRight: 5 }} />Search the current project for DQL and dbt YAML. Existing DQL source opens in place and is not copied.</Note> : null}
      {mode === 'path' ? <label style={label(theme)}>Local file or directory<input aria-label="Local YAML path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="models or domains/sales" style={input(theme)} /><small>Loopback-only and confined to the current approved project root.</small></label> : null}
      {mode === 'upload' ? <label style={{ ...choice(theme), marginTop: 12 }}><Upload size={15} /><span style={{ flex: 1 }}>Choose a YAML file</span><input type="file" accept=".yml,.yaml,text/yaml" onChange={(event) => readFile(event.target.files?.[0])} /></label> : null}
      {mode === 'paste' ? <label style={label(theme)}>Paste DQL or dbt YAML<textarea aria-label="Paste modeling YAML" value={content} onChange={(event) => setContent(event.target.value)} rows={14} style={{ ...input(theme), resize: 'vertical', fontFamily: theme.fontMono }} /></label> : null}
      <DrawerActions theme={theme} busy={busy} next={() => void discover()} nextLabel="Discover YAML" disabled={(mode === 'path' && !path.trim()) || ((mode === 'paste' || mode === 'upload') && !content.trim())} />
    </> : <>
      <Note theme={theme}><FileSearch size={13} style={{ verticalAlign: -2, marginRight: 5 }} />DQL modeling becomes a reviewed copy; dbt YAML becomes a sparse overlay. Generic YAML is not imported.</Note>
      <div style={{ display: 'grid', gap: 7 }}>
        {session.candidates.map((candidate) => <label key={candidate.id} style={{ ...choice(theme), opacity: candidate.action === 'import' ? 1 : .72 }}><input type="checkbox" disabled={candidate.action !== 'import'} checked={selected.includes(candidate.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} /><span style={{ flex: 1 }}><b style={{ display: 'block', fontSize: 11 }}>{candidate.name}</b><span style={{ display: 'block', marginTop: 2, color: theme.textMuted, fontSize: 9.5 }}>{candidate.dialect.replace(/_/g, ' ')} · {candidate.summary}</span>{candidate.warnings.map((warning) => <small key={warning} style={{ display: 'block', color: 'var(--status-warning)', marginTop: 3 }}>{warning}</small>)}</span><span style={{ fontSize: 9.5, color: theme.textMuted }}>{candidate.action.replace(/_/g, ' ')}</span></label>)}
      </div>
      <ScopeFields scope={scope} theme={theme} />
      <DrawerActions theme={theme} busy={busy} back={() => { setSession(null); setSelected([]); }} next={() => void preview()} nextLabel="Review exact patches" disabled={!selected.length || !scope.scopeDomain.trim() || !scope.scopeArea.trim()} />
    </>}
    {error ? <div role="alert" style={{ color: 'var(--status-error)', fontSize: 11, marginTop: 10 }}>{error}</div> : null}
  </DrawerShell>;
}

interface DrawerContextProps { data: DbtFirstModelingResponse; domain: string | null; areaId: string | null; theme: Theme; onClose: () => void; onProposal: (proposal: ContextAuthoringProposalV1) => void }

function buildEntityOperations(data: DbtFirstModelingResponse, domain: string, areaId: string, items: DbtModelInventoryItem[]): ContextAuthoringOperation[] {
  if (!domain.trim() || !areaId.trim()) return [];
  const used = new Set(Object.values(data.modeling.entities).filter((entity) => entity.domain === domain).map((entity) => entity.localId || entity.id));
  return [...items].sort((a, b) => a.uniqueId.localeCompare(b.uniqueId)).map((item) => {
    const base = slug(item.name) || 'model';
    let id = base;
    if (used.has(id)) id = `${base}-${item.identityFingerprint.slice(0, 6).toLowerCase()}`;
    let index = 2;
    while (used.has(id)) id = `${base}-${index++}`;
    used.add(id);
    return { id: `bind:${item.uniqueId}`, kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id, domain, areaId, dbtModel: item.uniqueId, businessName: title(item.name), status: 'draft' } }, evidence: [`dbt unique id ${item.uniqueId}`, `manifest fingerprint ${item.identityFingerprint}`] };
  });
}

function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64); }
function title(value: string) { return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }

function DrawerShell({ title, subtitle, theme, busy, onClose, children }: { title: string; subtitle: string; theme: Theme; busy: boolean; onClose: () => void; children: React.ReactNode }) {
  return <div onClick={() => !busy && onClose()} style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(8,10,16,.46)', display: 'flex', justifyContent: 'flex-end' }}><aside role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()} style={{ width: 'min(600px, 96vw)', height: '100%', background: theme.appBg, borderLeft: '1px solid var(--border-default)', boxShadow: '-16px 0 45px rgba(0,0,0,.22)', display: 'flex', flexDirection: 'column' }}><header style={{ minHeight: 58, padding: '0 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 9 }}><div style={{ flex: 1 }}><b style={{ display: 'block', fontSize: 14 }}>{title}</b><small style={{ color: theme.textMuted }}>{subtitle}</small></div><button aria-label="Close" disabled={busy} onClick={onClose} style={{ ...secondary(theme), width: 30, padding: 0 }}><X size={14} /></button></header><div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 18 }}>{children}</div></aside></div>;
}
function DrawerActions({ theme, busy, back, next, nextLabel, disabled = false }: { theme: Theme; busy: boolean; back?: () => void; next: () => void; nextLabel: string; disabled?: boolean }) { return <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>{back ? <button type="button" onClick={back} disabled={busy} style={secondary(theme)}>Back</button> : null}<button type="button" onClick={next} disabled={busy || disabled} style={{ ...primary(theme), opacity: busy || disabled ? .55 : 1 }}>{busy ? <Loader2 size={13} /> : null}{nextLabel}</button></div>; }
function Note({ theme, children }: { theme: Theme; children: React.ReactNode }) { return <div style={{ margin: '12px 0', padding: '10px 11px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-1)', color: theme.textSecondary, fontSize: 10.5, lineHeight: 1.5 }}>{children}</div>; }
function Field({ label: fieldLabel, value, theme }: { label: string; value: string; theme: Theme }) { return <div style={{ ...choice(theme), marginBottom: 8 }}><b style={{ width: 72, fontSize: 11 }}>{fieldLabel}</b><span style={{ color: theme.textSecondary, fontSize: 11 }}>{value}</span></div>; }
const input = (theme: Theme): React.CSSProperties => ({ boxSizing: 'border-box', border: '1px solid var(--border-default)', background: theme.inputBg, color: theme.textPrimary, borderRadius: 7, padding: '8px 9px', outline: 'none' });
const label = (theme: Theme): React.CSSProperties => ({ display: 'grid', gap: 6, marginTop: 12, color: theme.textSecondary, fontSize: 11 });
const choice = (theme: Theme): React.CSSProperties => ({ display: 'flex', gap: 9, alignItems: 'center', border: '1px solid var(--border-subtle)', borderRadius: 8, background: theme.cellBg, padding: '9px 10px' });
const secondary = (theme: Theme): React.CSSProperties => ({ minHeight: 31, border: '1px solid var(--border-default)', borderRadius: 7, background: theme.cellBg, color: theme.textPrimary, padding: '0 11px', cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'center' });
const primary = (theme: Theme): React.CSSProperties => ({ ...secondary(theme), background: theme.accent, borderColor: theme.accent, color: 'var(--accent-fg)', fontWeight: 650 });
