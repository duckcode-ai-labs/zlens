// "Show your work" — consumer-facing derivation walk panel.
//
// Renders the plain-language story of how a certified (or generated) answer was
// derived: value → block (owner / status / review) → terms → metrics → dbt
// model / source, plus caveats and an optional trust/freshness line.
//
// It deliberately HIDES depth. The walk is collapsed behind a "Why?" affordance
// and, once opened, reveals one step at a time (progressive disclosure) so a
// non-technical consumer is never shown the raw lineage graph. The component is
// presentational and dependency-free: the host assembles the `DerivationWalk`
// payload (via dql-core's `buildDerivationWalk`) and passes it in.

import React from 'react';
import { StatusPill } from './PanelFrame.js';

export type DerivationStepKind =
  | 'value'
  | 'block'
  | 'term'
  | 'metric'
  | 'dimension'
  | 'model'
  | 'source'
  | 'consumer';

export interface DerivationStep {
  kind: DerivationStepKind;
  name: string;
  owner?: string;
  status?: string;
  detail?: string;
}

export interface DerivationWalk {
  value?: string;
  summary: string;
  steps: DerivationStep[];
  trustLabel?: string;
  freshness?: string;
  caveats?: string[];
}

export interface DerivationWalkPanelProps {
  walk: DerivationWalk;
  /** Start expanded. Defaults to false — the "Why?" affordance is collapsed. */
  defaultOpen?: boolean;
  /** Label for the collapsed affordance. Defaults to "Why?". */
  triggerLabel?: React.ReactNode;
}

const STEP_LABEL: Record<DerivationStepKind, string> = {
  value: 'Value',
  block: 'Certified saved query',
  term: 'Business term',
  metric: 'Metric',
  dimension: 'Dimension',
  model: 'dbt model',
  source: 'Source table',
  consumer: 'Used by',
};

function statusTone(status?: string): React.ComponentProps<typeof StatusPill>['tone'] {
  const value = (status ?? '').toLowerCase();
  if (value === 'certified') return 'success';
  if (value === 'deprecated') return 'neutral';
  if (value.includes('review') || value === 'draft' || value === 'pending') return 'warning';
  return 'neutral';
}

/**
 * Progressive-disclosure derivation panel. Depth is collapsed by default;
 * opening reveals the steps one level at a time via "Show more".
 */
export function DerivationWalkPanel({ walk, defaultOpen = false, triggerLabel }: DerivationWalkPanelProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  // Reveal one step at a time. Start by showing the value + block (the first
  // two steps); each "Show more" reveals the next single level.
  const initialVisible = Math.min(walk.steps.length, 2);
  const [visible, setVisible] = React.useState(initialVisible);

  const reset = () => setVisible(initialVisible);
  const shownSteps = walk.steps.slice(0, visible);
  const remaining = walk.steps.length - visible;

  return (
    <div
      style={{
        border: '1px solid var(--border-subtle, rgba(127,127,127,0.25))',
        borderRadius: 8,
        background: 'var(--bg-1, transparent)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (open) reset();
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          border: 0,
          background: 'transparent',
          color: 'var(--text-secondary, inherit)',
          cursor: 'pointer',
          padding: '8px 11px',
          font: 'inherit',
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span aria-hidden style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms', display: 'inline-block' }}>
            ▸
          </span>
          {triggerLabel ?? 'Why?'}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary, inherit)', fontWeight: 600 }}>
          {open ? 'Hide derivation' : 'Show how this was derived'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '2px 11px 11px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-primary, inherit)' }}>
            {walk.summary}
          </div>

          {(walk.trustLabel || walk.freshness) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {walk.trustLabel && <StatusPill tone={statusTone(walk.trustLabel)}>{formatLabel(walk.trustLabel)}</StatusPill>}
              {walk.freshness && (
                <span style={{ fontSize: 11, color: 'var(--text-tertiary, inherit)' }}>
                  Fresh as of {formatFreshness(walk.freshness)}
                </span>
              )}
            </div>
          )}

          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {shownSteps.map((step, index) => (
              <li
                key={`${step.kind}-${step.name}-${index}`}
                style={{
                  display: 'flex',
                  gap: 9,
                  alignItems: 'flex-start',
                  paddingLeft: 2,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    marginTop: 3,
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    flexShrink: 0,
                    background: 'var(--accent, currentColor)',
                    opacity: 0.7,
                  }}
                />
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary, inherit)' }}>
                      {STEP_LABEL[step.kind]}
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary, inherit)', overflowWrap: 'anywhere' }}>
                      {step.name}
                    </span>
                    {step.status && <StatusPill tone={statusTone(step.status)}>{formatLabel(step.status)}</StatusPill>}
                  </div>
                  {(step.owner || step.detail) && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary, inherit)', lineHeight: 1.45 }}>
                      {step.owner && <span>Owner: {step.owner}. </span>}
                      {step.detail}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setVisible((value) => Math.min(walk.steps.length, value + 1))}
              style={{
                alignSelf: 'flex-start',
                border: '1px solid var(--border-default, rgba(127,127,127,0.3))',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--accent, inherit)',
                cursor: 'pointer',
                padding: '4px 9px',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              Show next step ({remaining} more)
            </button>
          )}

          {walk.caveats && walk.caveats.length > 0 && (
            <div
              style={{
                borderLeft: '3px solid var(--status-warning, #d29922)',
                background: 'var(--status-warning-bg, rgba(210,153,34,0.08))',
                borderRadius: 6,
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--status-warning, inherit)' }}>
                Caveats
              </span>
              {walk.caveats.map((caveat, index) => (
                <span key={index} style={{ fontSize: 11.5, color: 'var(--text-secondary, inherit)', lineHeight: 1.45 }}>
                  {caveat}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatLabel(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatFreshness(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}
