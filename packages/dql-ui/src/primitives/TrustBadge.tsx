// Shared trust-state badge for notebook, App, and review surfaces.

import React from 'react';
import { StatusPill } from './PanelFrame.js';

type Tone = React.ComponentProps<typeof StatusPill>['tone'];

/**
 * Canonical trust-label vocabulary.
 *
 * This MIRRORS the single source of truth in
 * `@zlens/core` (`src/trust/labels.ts`): the same six base
 * labels (Certified · Governed · Reviewed · AI-Generated ·
 * Insufficient-Context · Conflict), each with a base label + optional qualifier shape and a color
 * token. `dql-ui` is a browser-only leaf package with no ZLens workspace
 * dependencies, so it cannot import dql-core (which carries node-only deps)
 * without bloating the UI bundle — hence this intentional mirror. Keep the two
 * in sync; the ids and base labels must match exactly.
 *
 * Color tokens map to `StatusPill` tones here. Unknown labels degrade to a
 * safe default rather than throwing, matching dql-core's `resolveTrustLabel`.
 */
export type CanonicalTrustLabelId =
  | 'certified'
  | 'governed'
  | 'reviewed'
  | 'ai_generated'
  | 'insufficient_context'
  | 'conflict';

const CANONICAL_TRUST_LABELS: Record<CanonicalTrustLabelId, { base: string; tone: Tone }> = {
  certified: { base: 'Certified', tone: 'success' },
  governed: { base: 'Governed', tone: 'info' },
  reviewed: { base: 'Reviewed', tone: 'info' },
  ai_generated: { base: 'AI-Generated', tone: 'warning' },
  insufficient_context: { base: 'Insufficient-Context', tone: 'neutral' },
  conflict: { base: 'Conflict', tone: 'error' },
};

const DEFAULT_CANONICAL_TRUST_LABEL_ID: CanonicalTrustLabelId = 'insufficient_context';

/**
 * Legacy lifecycle states, retained for backward compatibility. Existing
 * callers passing these keep working; new code should prefer the canonical ids.
 */
export type LegacyTrustState =
  | 'draft'
  | 'pending'
  | 'review'
  | 'deprecated'
  | 'uncertified'
  | 'no_answer';

export type TrustState = CanonicalTrustLabelId | LegacyTrustState;

export interface TrustBadgeProps {
  state?: TrustState;
  /**
   * Optional downgrade/composition qualifier appended as `base · qualifier`,
   * e.g. `state="certified" qualifier="invariant violated"` →
   * "Certified · invariant violated". Ignored when an explicit `label` is set.
   */
  qualifier?: string;
  label?: React.ReactNode;
}

export function TrustBadge({ state, qualifier, label }: TrustBadgeProps) {
  if (!state) return null;

  const config = TRUST_BADGE_CONFIG[state] ?? TRUST_BADGE_CONFIG[DEFAULT_CANONICAL_TRUST_LABEL_ID];
  const composed = qualifier ? `${config.label} · ${qualifier}` : config.label;
  return <StatusPill tone={config.tone}>{label ?? composed}</StatusPill>;
}

const TRUST_BADGE_CONFIG: Record<TrustState, { tone: Tone; label: string }> = {
  // Canonical vocabulary (mirrors dql-core).
  certified: { tone: CANONICAL_TRUST_LABELS.certified.tone, label: CANONICAL_TRUST_LABELS.certified.base },
  governed: { tone: CANONICAL_TRUST_LABELS.governed.tone, label: CANONICAL_TRUST_LABELS.governed.base },
  reviewed: { tone: CANONICAL_TRUST_LABELS.reviewed.tone, label: CANONICAL_TRUST_LABELS.reviewed.base },
  ai_generated: { tone: CANONICAL_TRUST_LABELS.ai_generated.tone, label: CANONICAL_TRUST_LABELS.ai_generated.base },
  insufficient_context: { tone: CANONICAL_TRUST_LABELS.insufficient_context.tone, label: CANONICAL_TRUST_LABELS.insufficient_context.base },
  conflict: { tone: CANONICAL_TRUST_LABELS.conflict.tone, label: CANONICAL_TRUST_LABELS.conflict.base },
  // Legacy lifecycle states (unchanged behavior).
  draft: { tone: 'warning', label: 'Draft' },
  pending: { tone: 'warning', label: 'Pending review' },
  review: { tone: 'warning', label: 'Review' },
  uncertified: { tone: 'warning', label: 'Uncertified' },
  deprecated: { tone: 'neutral', label: 'Deprecated' },
  no_answer: { tone: 'error', label: 'No answer' },
};
