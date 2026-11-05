// Scope Ask to a domain, subject area and purpose from the question box.
//
// Scoping used to be reachable only from the Modeling page's Ask button, and
// a domain that no longer existed silently answered unscoped while the chip
// still said "Scoped to X". The picker lists what exists and says plainly when
// the saved scope does not.

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Boxes, ChevronDown, X } from 'lucide-react';
import { api, type AskScopeOption } from '../../api/client';
import type { themes } from '../../themes/notebook-theme';
import type { DomainScope } from './domain-scope';
import { scopeLabel, scopeProblem } from './ask-scope-model';

type Theme = (typeof themes)['dark'];

export function AskScopePicker({ scope, onChange, t }: { scope: DomainScope | undefined; onChange: (scope: DomainScope | undefined) => void; t: Theme }) {
  const [options, setOptions] = useState<AskScopeOption[] | null>(null);
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState(scope?.domain ?? '');
  const [area, setArea] = useState(scope?.modelAreaId ?? '');
  const [purpose, setPurpose] = useState(scope?.purpose ?? '');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void api.getAskScopes().then((result) => { if (!cancelled) setOptions(result.domains ?? []); }).catch(() => { if (!cancelled) setOptions(null); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!open) return;
    setDomain(scope?.domain ?? '');
    setArea(scope?.modelAreaId ?? '');
    setPurpose(scope?.purpose ?? '');
    const close = (event: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const problem = scopeProblem(scope, options);
  const chosen = options?.find((option) => option.id === domain);
  const apply = () => {
    onChange(domain ? { domain, ...(area ? { modelAreaId: area } : {}), ...(purpose.trim() ? { purpose: purpose.trim() } : {}) } : undefined);
    setOpen(false);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', width: 'fit-content', maxWidth: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 7px 4px 9px', border: `1px solid ${problem ? 'var(--status-warning)' : 'var(--border-default)'}`, borderRadius: 999, background: 'var(--bg-2)', color: problem ? 'var(--status-warning)' : t.textMuted, fontSize: 11 }}>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label="Ask scope" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 11, maxWidth: 420 }}>
          {problem ? <AlertTriangle size={12} /> : <Boxes size={12} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{problem ?? `Scope: ${scopeLabel(scope, options)}`}</span>
          <ChevronDown size={12} />
        </button>
        {scope ? <button type="button" onClick={() => onChange(undefined)} aria-label="Clear Ask scope" title="Search all domains" style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 1 }}><X size={12} /></button> : null}
      </div>
      {open ? (
        <div role="dialog" aria-label="Choose what Ask searches" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 40, width: 'min(360px, 90vw)', padding: 12, borderRadius: 11, border: `1px solid ${t.headerBorder}`, background: t.cellBg, boxShadow: '0 12px 32px rgba(0,0,0,.18)', display: 'grid', gap: 9 }}>
          <div style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.45 }}>Scoping narrows Ask to one domain's models, terms and skills. Leave it on All domains to search everything.</div>
          {options === null ? <div style={{ fontSize: 11, color: t.textMuted }}>Domains could not be loaded. You can still ask across all domains.</div> : null}
          <label style={labelStyle(t)}>
            Domain
            <select value={domain} onChange={(event) => { setDomain(event.target.value); setArea(''); }} style={selectStyle(t)}>
              <option value="">All domains</option>
              {(options ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          {chosen && chosen.areas.length ? (
            <label style={labelStyle(t)}>
              Area
              <select value={area} onChange={(event) => setArea(event.target.value)} style={selectStyle(t)}>
                <option value="">Whole domain</option>
                {chosen.areas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          ) : null}
          {chosen && chosen.purposes.length ? (
            <label style={labelStyle(t)}>
              Purpose
              <select value={purpose} onChange={(event) => setPurpose(event.target.value)} style={selectStyle(t)}>
                <option value="">No purpose</option>
                {chosen.purposes.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <span style={{ fontWeight: 400, color: t.textMuted }}>Data another domain shares is used only for the purpose it was approved for.</span>
            </label>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button type="button" onClick={() => setOpen(false)} style={buttonStyle(t)}>Cancel</button>
            <button type="button" onClick={apply} style={{ ...buttonStyle(t), background: t.accent, borderColor: t.accent, color: '#fff' }}>Apply</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const labelStyle = (t: Theme): React.CSSProperties => ({ display: 'grid', gap: 4, fontSize: 11, fontWeight: 650, color: t.textSecondary });
const selectStyle = (t: Theme): React.CSSProperties => ({ width: '100%', border: `1px solid ${t.headerBorder}`, borderRadius: 6, background: t.appBg, color: t.textPrimary, fontSize: 11.5, padding: '6px 7px' });
const buttonStyle = (t: Theme): React.CSSProperties => ({ border: `1px solid ${t.headerBorder}`, borderRadius: 6, background: t.appBg, color: t.textPrimary, fontSize: 11, fontWeight: 650, padding: '5px 10px', cursor: 'pointer' });
