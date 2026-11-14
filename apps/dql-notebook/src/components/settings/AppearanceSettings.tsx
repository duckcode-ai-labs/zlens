import React from 'react';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { ThemeMode } from '../../store/types';

/** The three themes, by what they look like. The choice is kept in this browser. */
export const APPEARANCE_CHOICES: ReadonlyArray<{ mode: 'paper' | 'white' | 'obsidian'; label: string; detail: string; swatch: string }> = [
  { mode: 'paper', label: 'Paper', detail: 'Warm light. The default.', swatch: '#f7f4ed' },
  { mode: 'white', label: 'White', detail: 'Plain light.', swatch: '#ffffff' },
  { mode: 'obsidian', label: 'Obsidian', detail: 'Dark.', swatch: '#0d0e11' },
];

/** The theme a stored mode stands for (older names map to the three themes). */
export function appearanceChoice(mode: ThemeMode): 'paper' | 'white' | 'obsidian' {
  if (mode === 'dark' || mode === 'midnight' || mode === 'obsidian') return 'obsidian';
  if (mode === 'arctic' || mode === 'white') return 'white';
  return 'paper';
}

/** Settings » Appearance: the theme (it used to sit in every page's header). */
export function AppearanceSettings() {
  const themeMode = useNotebookStore((state) => state.themeMode);
  const dispatch = useDispatch();
  const t = themes[themeMode];
  const current = appearanceChoice(themeMode);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 680 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, color: t.textPrimary }}>Appearance</div>
        <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5 }}>
          How ZLens looks in this browser.
        </div>
      </div>
      <div role="radiogroup" aria-label="Theme" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        {APPEARANCE_CHOICES.map((choice) => {
          const selected = choice.mode === current;
          return (
            <button
              key={choice.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => dispatch({ type: 'SET_THEME', mode: choice.mode })}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                border: `1.5px solid ${selected ? t.accent : 'var(--border-subtle)'}`,
                background: selected ? 'var(--accent-dim)' : t.cellBg,
                fontFamily: t.font,
              }}
            >
              <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: 7, background: choice.swatch, border: `1px solid ${t.headerBorder}`, flexShrink: 0 }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 650, color: t.textPrimary }}>{choice.label}</span>
                <span style={{ fontSize: 11.5, color: t.textMuted }}>{choice.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
