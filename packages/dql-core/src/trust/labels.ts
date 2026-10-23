/**
 * Canonical trust-label vocabulary.
 *
 * DQL's three-tier trust routing implies labels everywhere — the MCP server's
 * answer contract, the agent answer-loop source tiers, and the UI badge. This
 * module defines that vocabulary **once** so every surface speaks the same
 * language. It is intentionally a pure, dependency-free module (no node-only
 * imports) so it can be mirrored into the browser-only `dql-ui` package without
 * pulling the rest of `dql-core` into a UI bundle.
 *
 * Each label is structured as a **base label + optional qualifier** so that
 * downgrade/composition states stay representable. For example, a sibling
 * change elsewhere may emit a "Certified · invariant violated" downgrade: that
 * is base `Certified` plus the qualifier `invariant violated`. Consumers can
 * render the base alone, or `base · qualifier` when a qualifier is present,
 * without inventing new top-level labels.
 *
 * The vocabulary is **additive and backward compatible**: existing manifests,
 * route values, and `status` strings keep working, and any unrecognized label
 * id degrades to a safe default (`Insufficient-Context`) rather than throwing.
 */

/** The canonical base trust labels. */
export type TrustLabelId =
  | 'certified'
  | 'governed'
  | 'reviewed'
  | 'ai_generated'
  | 'insufficient_context'
  | 'conflict';

/** Severity drives ordering and the UI color/tone mapping. Higher = worse. */
export type TrustLabelSeverity = 'ok' | 'info' | 'caution' | 'blocked';

/**
 * A semantic color token. Kept abstract (not a hex/CSS value) so each surface
 * can map it to its own palette — `dql-ui` maps it to a `StatusPill` tone, the
 * MCP/agent surfaces use it as a stable machine-readable hint.
 */
export type TrustLabelColor = 'green' | 'blue' | 'amber' | 'slate' | 'red';

/** Display metadata for a canonical base label. */
export interface TrustLabelDefinition {
  /** Stable machine id. */
  id: TrustLabelId;
  /** Human-facing base label, e.g. "Certified". */
  base: string;
  /** Severity bucket (drives color + ordering). */
  severity: TrustLabelSeverity;
  /** Abstract color token consumers map to their own palette. */
  color: TrustLabelColor;
  /** One-line description of what the label means. */
  description: string;
}

/**
 * A resolved, possibly-composed trust label: a canonical base plus an optional
 * free-form qualifier. Surfaces render `display` (already composed as
 * `base · qualifier` when a qualifier is present).
 */
export interface ResolvedTrustLabel {
  id: TrustLabelId;
  base: string;
  /** Optional downgrade/composition qualifier, e.g. "invariant violated". */
  qualifier?: string;
  severity: TrustLabelSeverity;
  color: TrustLabelColor;
  /** `base` or `base · qualifier`. */
  display: string;
}

/** Canonical vocabulary, defined once. Order is the trust hierarchy (best → worst). */
export const TRUST_LABELS: Record<TrustLabelId, TrustLabelDefinition> = {
  certified: {
    id: 'certified',
    base: 'Certified',
    severity: 'ok',
    color: 'green',
    description: 'Governed, human-certified artifact answering at the requested grain.',
  },
  governed: {
    id: 'governed',
    base: 'Governed',
    severity: 'info',
    color: 'blue',
    description: 'Compiled from governed semantic metrics and dimensions, not certified; the Ask page shows it as "Governed answer".',
  },
  reviewed: {
    id: 'reviewed',
    base: 'Reviewed',
    severity: 'info',
    color: 'blue',
    description: 'Human-reviewed but not certified; safe as trusted context.',
  },
  ai_generated: {
    id: 'ai_generated',
    base: 'AI-Generated',
    severity: 'caution',
    color: 'amber',
    description: 'AI-drafted answer that requires human review before stakeholder use.',
  },
  insufficient_context: {
    id: 'insufficient_context',
    base: 'Insufficient-Context',
    severity: 'caution',
    color: 'slate',
    description: 'Not enough governed metadata to answer safely; clarification needed.',
  },
  conflict: {
    id: 'conflict',
    base: 'Conflict',
    severity: 'blocked',
    color: 'red',
    description: 'Two governed definitions claim the same concept but disagree; a human must pick the winner.',
  },
};

/** Ordered list of canonical labels (best → worst). */
export const TRUST_LABEL_ORDER: TrustLabelId[] = [
  'certified',
  'governed',
  'reviewed',
  'ai_generated',
  'insufficient_context',
  'conflict',
];

/** Convenience display qualifier shown when a certified artifact is downgraded. */
export const TRUST_QUALIFIER_INVARIANT_VIOLATED = 'invariant violated';

/**
 * Freshness-aware-trust qualifiers. These compose with a base label exactly
 * like {@link TRUST_QUALIFIER_INVARIANT_VIOLATED}: a certified block whose
 * upstream data is stale renders "Certified · stale data"; one whose upstream
 * dbt run failed renders "Certified · upstream failed".
 *
 * `data freshness unknown` is intentionally NOT surfaced as a downgrade — a
 * missing `run_results.json` should degrade silently to the plain base label
 * (see {@link dataStateQualifier}), so projects that have not wired dbt run
 * artifacts keep showing "Certified".
 */
export const TRUST_QUALIFIER_STALE_DATA = 'stale data';
export const TRUST_QUALIFIER_UPSTREAM_FAILED = 'upstream failed';

/** The data-health axis, mirrored from `manifest/types.ts` `DbtDataState`. */
export type DataStateLike = 'fresh' | 'stale' | 'failed' | 'unknown' | undefined;

/**
 * Map a data-health state to its trust qualifier, or `undefined` when the data
 * axis should not downgrade the label. `fresh` and `unknown` both return
 * `undefined` so a healthy (or un-instrumented) block shows the plain base
 * label; only `stale` and `failed` produce a visible "· …" qualifier.
 */
export function dataStateQualifier(dataState: DataStateLike): string | undefined {
  switch (dataState) {
    case 'failed':
      return TRUST_QUALIFIER_UPSTREAM_FAILED;
    case 'stale':
      return TRUST_QUALIFIER_STALE_DATA;
    default:
      return undefined;
  }
}

/**
 * Compose the effective trust label for an artifact, folding the data-freshness
 * axis into a base trust label. When `dataState` is `stale`/`failed` the
 * returned label is `<base> · <freshness qualifier>`; otherwise it is the base
 * label unchanged. An explicit `existingQualifier` (e.g. "invariant violated")
 * takes precedence so the two downgrade features never fight over the one
 * qualifier slot — invariant violations are a stronger signal than staleness.
 *
 * Pure and dependency-free; safe to call from any surface (MCP, agent, UI).
 */
export function composeEffectiveTrust(input: {
  id: string | undefined;
  dataState?: DataStateLike;
  existingQualifier?: string;
}): ResolvedTrustLabel {
  const qualifier =
    input.existingQualifier?.trim() || dataStateQualifier(input.dataState);
  return resolveTrustLabel(input.id, qualifier);
}

/** The safe default for any unknown/unmapped label id. */
export const DEFAULT_TRUST_LABEL_ID: TrustLabelId = 'insufficient_context';

const QUALIFIER_SEPARATOR = ' · ';

/**
 * Resolve a canonical label by id, composing an optional qualifier into a ready
 * display string. An unknown id degrades to the safe default rather than
 * throwing, so older/forward manifests never break a consumer.
 */
export function resolveTrustLabel(
  id: string | undefined,
  qualifier?: string,
): ResolvedTrustLabel {
  const def = (id && TRUST_LABELS[id as TrustLabelId]) || TRUST_LABELS[DEFAULT_TRUST_LABEL_ID];
  const trimmedQualifier = qualifier?.trim() || undefined;
  return {
    id: def.id,
    base: def.base,
    qualifier: trimmedQualifier,
    severity: def.severity,
    color: def.color,
    display: trimmedQualifier ? `${def.base}${QUALIFIER_SEPARATOR}${trimmedQualifier}` : def.base,
  };
}

/**
 * Map an agent/MCP answer route to its canonical trust label id. Additive: an
 * unrecognized route degrades to the safe default.
 */
export function trustLabelIdForRoute(route: string | undefined): TrustLabelId {
  switch (route) {
    case 'certified':
      return 'certified';
    case 'conflict':
      return 'conflict';
    case 'semantic':
    case 'semantic_answer':
    case 'semantic_compile':
      return 'governed';
    case 'generated_sql':
      return 'ai_generated';
    case 'research':
      return 'reviewed';
    case 'clarify':
      return 'insufficient_context';
    default:
      return DEFAULT_TRUST_LABEL_ID;
  }
}

/**
 * Map a legacy artifact `status` / trust-tier string (as found on manifests and
 * catalog objects) to a canonical label id. Additive and lenient: unknown
 * statuses degrade to the safe default.
 */
export function trustLabelIdForStatus(status: string | undefined): TrustLabelId {
  switch (status) {
    case 'certified':
    case 'approved':
      return 'certified';
    case 'governed':
    case 'grounded':
      return 'governed';
    case 'reviewed':
    case 'review':
    case 'research':
      return 'reviewed';
    case 'ai_generated':
    case 'generated':
    case 'draft':
    case 'draft_ready':
    case 'pending':
    case 'pending_recertification':
    case 'analyst_review_required':
    case 'review_required':
      return 'ai_generated';
    case 'conflict':
      return 'conflict';
    case 'mixed':
    case 'unknown':
    case 'uncertified':
    case 'none':
      return 'insufficient_context';
    default:
      return DEFAULT_TRUST_LABEL_ID;
  }
}
