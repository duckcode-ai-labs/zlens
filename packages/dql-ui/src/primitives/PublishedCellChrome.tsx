// v1.3 Track 11 — read-only dashboard/App-mode card.
//
// PublishedCellChrome emits the same card shell as CellChrome minus the
// authoring affordances (no run button, no overflow menu, no type pill).
// Shared between notebook App mode and the dashboard HTML emitter so the
// preview and the published artifact render byte-identical DOM structure.

import React from 'react';
import type { TrustState } from './TrustBadge.js';

export interface PublishedCellChromeProps {
  /** Optional title shown in the card header (left-aligned). */
  title?: React.ReactNode;
  /** Small caption under the title (e.g., block binding / source). */
  caption?: React.ReactNode;
  /** Trust state hint. v1.4 plug slot; renders a colored dot when provided. */
  trustState?: TrustState;
  /** Main body (chart, KPI, pivot, table). */
  children?: React.ReactNode;
  /** Optional footer slot for metadata strip. */
  footer?: React.ReactNode;

  background?: string;
  idleBorder?: string;
  className?: string;
  style?: React.CSSProperties;
}

const TRUST_DOT: Record<NonNullable<TrustState>, string> = {
  // Canonical vocabulary (mirrors dql-core).
  certified: 'var(--color-accent-green, #3fb950)',
  governed: 'var(--color-accent-blue, #58a6ff)',
  reviewed: 'var(--color-accent-blue, #58a6ff)',
  ai_generated: 'var(--color-accent-yellow, #e3b341)',
  insufficient_context: 'var(--color-text-muted, #9aa4b2)',
  conflict: 'var(--color-accent-red, #f85149)',
  // Legacy lifecycle states.
  draft: 'var(--color-text-muted, #9aa4b2)',
  pending: 'var(--color-accent-yellow, #e3b341)',
  review: 'var(--color-accent-yellow, #e3b341)',
  uncertified: 'var(--color-accent-yellow, #e3b341)',
  deprecated: 'var(--color-accent-red, #f85149)',
  no_answer: 'var(--color-accent-red, #f85149)',
};

export function PublishedCellChrome({
  title,
  caption,
  trustState,
  children,
  footer,
  background,
  idleBorder,
  className,
  style,
}: PublishedCellChromeProps) {
  const bg = background ?? 'var(--color-bg-1, rgba(22,27,34,0.5))';
  const border = idleBorder ?? 'var(--color-border-subtle, rgba(148,163,184,0.18))';

  return (
    <div
      className={className}
      style={{
        borderRadius: 8,
        border: `1px solid ${border}`,
        background: bg,
        overflow: 'hidden',
        ...style,
      }}
    >
      {(title !== undefined || caption !== undefined || trustState) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderBottom: `1px solid ${border}`,
          }}
        >
          {trustState && (
            <span
              title={trustState}
              aria-label={`trust state: ${trustState}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: TRUST_DOT[trustState],
                flexShrink: 0,
              }}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            {title !== undefined && (
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--color-text-primary, #e6edf3)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {title}
              </div>
            )}
            {caption !== undefined && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-muted, #9aa4b2)',
                  marginTop: 2,
                }}
              >
                {caption}
              </div>
            )}
          </div>
        </div>
      )}
      <div style={{ padding: 12 }}>{children}</div>
      {footer !== undefined && (
        <div
          style={{
            padding: '8px 12px',
            borderTop: `1px solid ${border}`,
            fontSize: 11,
            color: 'var(--color-text-muted, #9aa4b2)',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
