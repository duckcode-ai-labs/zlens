import React from 'react';
import type { Theme } from '../../themes/notebook-theme';
import type { Cell } from '../../store/types';

interface CellEmptyStateProps {
  theme: Theme;
  accentColor: string;
  cellLabel: string;
  cellName?: string;
  description: string;
  upstreamOptions: Cell[];
  onPick: (name: string) => void;
}

/**
 * Shared empty-state for viz/transform cells (Chart, Pivot, SingleValue, Filter).
 * Teaches the "upstream dataframe" concept and lists nameable upstream cells as clickable chips.
 */
export function CellEmptyState({
  theme: t,
  accentColor,
  cellLabel,
  cellName,
  description,
  upstreamOptions,
  onPick,
}: CellEmptyStateProps) {
  return (
    <div
      style={{
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 6,
        padding: '18px 20px',
        fontFamily: t.font,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span
          style={{
            fontSize: 10,
            fontFamily: t.fontMono,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: accentColor,
            background: `${accentColor}18`,
            padding: '2px 6px',
            borderRadius: 3,
            textTransform: 'uppercase',
          }}
        >
          {cellLabel}
        </span>
        {cellName && (
          <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>{cellName}</span>
        )}
      </div>

      <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 8, lineHeight: 1.5 }}>{description}</div>

      {upstreamOptions.length === 0 ? (
        <div
          style={{
            fontSize: 11,
            color: t.textMuted,
            background: `${accentColor}0A`,
            border: `1px dashed ${t.cellBorder}`,
            borderRadius: 4,
            padding: '10px 12px',
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, color: t.textSecondary, marginBottom: 4 }}>
            No dataframe available yet
          </div>
          <div>
            1. Add a <span style={{ fontFamily: t.fontMono, color: t.textSecondary }}>SQL</span> or{' '}
            <span style={{ fontFamily: t.fontMono, color: t.textSecondary }}>Saved query</span> cell above this one.
            <br />
            2. Run it <span style={{ fontFamily: t.fontMono }}>(⌘↵)</span> and give the cell a name.
            <br />
            3. Come back here — named upstream cells show up as chips you can pick.
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: t.textMuted, fontStyle: 'italic' }}>
            Tip: use <span style={{ fontFamily: t.fontMono }}>@metric(...)</span> and{' '}
            <span style={{ fontFamily: t.fontMono }}>@dim(...)</span> in the upstream SQL and metrics /
            dimensions appear with typed icons in the pickers here.
          </div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 10, color: t.textMuted, marginBottom: 6, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 700 }}>
            Pick an upstream dataframe
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {upstreamOptions.map((c) => (
              <button
                key={c.id}
                onClick={() => c.name && onPick(c.name)}
                style={{
                  fontSize: 11,
                  fontFamily: t.fontMono,
                  color: accentColor,
                  background: `${accentColor}14`,
                  border: `1px solid ${accentColor}55`,
                  borderRadius: 4,
                  padding: '3px 10px',
                  cursor: 'pointer',
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
