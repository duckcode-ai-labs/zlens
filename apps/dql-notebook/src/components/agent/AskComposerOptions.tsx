/**
 * The Ask composer's controls, kept quiet: two icons by default — answer
 * settings and Research — and one small panel when the settings icon is
 * opened, holding the connected model, how hard the model thinks, and the
 * Research options. The database is the project's connection; it is not a
 * per-question choice here.
 */
import React, { useEffect, useRef, useState } from 'react';
import { FileSearch, SlidersHorizontal } from 'lucide-react';
import { api, type AgentThinkingMode, type ProviderSettings } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';

export const THINKING_OPTIONS: Array<{ mode: AgentThinkingMode; label: string; hint: string }> = [
  { mode: 'auto', label: 'Auto', hint: 'Adapts per question: fast for lookups, thorough for hard ones.' },
  { mode: 'low', label: 'Low', hint: 'Fastest. Less thinking and no extra verification.' },
  { mode: 'medium', label: 'Medium', hint: 'Balanced. More thinking, still skips the heavy verification.' },
  { mode: 'high', label: 'High', hint: 'Most thorough. Cross-checks the number, so it is slower.' },
];

export interface AskComposerOptionsProps {
  t: Theme;
  thinkingMode: AgentThinkingMode;
  onThinkingMode: (mode: AgentThinkingMode) => void;
  research: boolean;
  onResearch: (enabled: boolean) => void;
  researchRows: boolean;
  onResearchRows: (enabled: boolean) => void;
  researchRowsTitle?: string;
  /** Open the panel on first render (tests and previews). */
  defaultOpen?: boolean;
  /** Which edge the panel lines up with: the icons' left edge, or their right edge when they sit at the right of a narrow panel. */
  align?: 'start' | 'end';
}

export function AskComposerOptions({ t, thinkingMode, onThinkingMode, research, onResearch, researchRows, onResearchRows, researchRowsTitle, defaultOpen = false, align = 'start' }: AskComposerOptionsProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getProviderSettings()
      .then(({ providers }) => { if (!cancelled) setProvider(providers.find((entry) => entry.active) ?? null); })
      .catch(() => { /* the model line is informational */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const active = THINKING_OPTIONS.find((option) => option.mode === thinkingMode) ?? THINKING_OPTIONS[0]!;
  const modelLabel = provider?.label ?? undefined;
  // Cortex: the model Ask really uses (after a region fallback it is not the default), never silently.
  const modelName = provider?.modelInUse ?? provider?.model ?? undefined;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <button
        type="button"
        className="dql-ask-ghost"
        aria-label="Answer settings"
        aria-expanded={open}
        title={`Answer settings · Thinking: ${active.label}`}
        onClick={() => setOpen((current) => !current)}
        style={iconButtonStyle(t, open)}
      >
        <SlidersHorizontal size={15} />
        {thinkingMode !== 'auto' ? <span aria-hidden="true" style={{ position: 'absolute', top: 5, right: 5, width: 6, height: 6, borderRadius: 999, background: t.accent }} /> : null}
      </button>
      <button
        type="button"
        className="dql-ask-ghost"
        aria-label="Research mode"
        aria-pressed={research}
        title={research ? 'Research is on: investigates what changed, with the query behind every figure (up to 3 minutes)' : 'Research: investigate what changed, with the query behind every figure'}
        onClick={() => onResearch(!research)}
        style={{ ...iconButtonStyle(t, research), ...(research ? { width: 'auto', padding: '0 9px', gap: 5 } : {}) }}
      >
        <FileSearch size={15} />
        {research ? <span style={{ fontSize: 12, fontWeight: 600 }}>Research</span> : null}
      </button>

      {open ? (
        <div role="dialog" aria-label="Answer settings" style={panelStyle(t, align)}>
          <div style={labelStyle(t)}>Model</div>
          <div style={{ display: 'grid', gridTemplateColumns: '7px minmax(0, 1fr)', columnGap: 8, alignItems: 'center' }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: modelLabel ? t.success : t.textMuted }} />
            <span style={{ fontSize: 12.5, color: modelLabel ? t.textPrimary : t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={modelLabel}>{modelLabel ?? 'No model connected'}</span>
            {modelName ? <span style={{ gridColumn: 2, fontSize: 11.5, color: t.textMuted, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelName}</span> : null}
          </div>

          <div style={{ ...labelStyle(t), marginTop: 14 }}>Thinking</div>
          <div role="radiogroup" aria-label="Thinking" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2, padding: 2, borderRadius: 9, background: 'var(--bg-1)', border: '1px solid var(--border-subtle)' }}>
            {THINKING_OPTIONS.map((option) => {
              const selected = option.mode === thinkingMode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onThinkingMode(option.mode)}
                  style={{ height: 28, border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: t.font, fontSize: 12, fontWeight: selected ? 650 : 500, background: selected ? 'var(--bg-2)' : 'transparent', color: selected ? t.textPrimary : t.textMuted, boxShadow: selected ? '0 1px 2px rgba(26,26,26,0.08)' : 'none' }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.45, color: t.textMuted }}>{active.hint}</div>

          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '14px 0 12px' }} />

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary }}>Research mode</div>
              <div style={{ marginTop: 2, fontSize: 11.5, lineHeight: 1.45, color: t.textMuted }}>Compares the period you ask about with the one before and a year earlier, checks the data covers both, and reports the change with the query behind every figure. Takes up to 3 minutes.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={research}
              aria-label="Research mode"
              onClick={() => onResearch(!research)}
              style={{ position: 'relative', width: 32, height: 18, flexShrink: 0, marginTop: 2, borderRadius: 999, border: 'none', cursor: 'pointer', background: research ? t.accent : 'var(--bg-4)', transition: 'background .15s ease' }}
            >
              <span aria-hidden="true" style={{ position: 'absolute', top: 2, left: research ? 16 : 2, width: 14, height: 14, borderRadius: 999, background: '#fff', transition: 'left .15s ease', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
            </button>
          </div>
          {research ? (
            <label title={researchRowsTitle} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginTop: 10, fontSize: 11.5, lineHeight: 1.45, color: t.textSecondary, cursor: 'pointer' }}>
              <input
                type="checkbox"
                aria-label="Let the AI word the Research summary from the computed figures for this run"
                checked={researchRows}
                onChange={(event) => onResearchRows(event.target.checked)}
                style={{ marginTop: 2 }}
              />
              Let the AI word the summary from the computed figures
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function iconButtonStyle(t: Theme, active: boolean): React.CSSProperties {
  return {
    position: 'relative',
    width: 32,
    height: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    border: 'none',
    cursor: 'pointer',
    fontFamily: t.font,
    background: active ? 'var(--accent-dim)' : 'transparent',
    color: active ? 'var(--accent)' : t.textMuted,
  };
}

function panelStyle(t: Theme, align: 'start' | 'end'): React.CSSProperties {
  return {
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    ...(align === 'end' ? { right: 0 } : { left: 0 }),
    zIndex: 40,
    width: 300,
    maxWidth: 'calc(100vw - 32px)',
    padding: 14,
    borderRadius: 12,
    background: 'var(--bg-2)',
    border: '1px solid var(--border-default)',
    boxShadow: '0 12px 32px rgba(26,26,26,0.16)',
    fontFamily: t.font,
  };
}

function labelStyle(t: Theme): React.CSSProperties {
  return { fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, marginBottom: 6 };
}
