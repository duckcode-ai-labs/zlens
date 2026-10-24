import { describe, it, expect } from 'vitest';
import {
  TRUST_LABELS,
  TRUST_LABEL_ORDER,
  TRUST_QUALIFIER_INVARIANT_VIOLATED,
  TRUST_QUALIFIER_STALE_DATA,
  TRUST_QUALIFIER_UPSTREAM_FAILED,
  DEFAULT_TRUST_LABEL_ID,
  resolveTrustLabel,
  trustLabelIdForRoute,
  trustLabelIdForStatus,
  dataStateQualifier,
  composeEffectiveTrust,
  type TrustLabelId,
} from './labels.js';

describe('canonical trust-label vocabulary', () => {
  it('defines exactly the six canonical base labels', () => {
    expect(TRUST_LABEL_ORDER).toEqual([
      'certified',
      'governed',
      'reviewed',
      'ai_generated',
      'insufficient_context',
      'conflict',
    ]);
    expect(Object.keys(TRUST_LABELS).sort()).toEqual([...TRUST_LABEL_ORDER].sort());
    expect(TRUST_LABELS.certified.base).toBe('Certified');
    expect(TRUST_LABELS.governed.base).toBe('From Metrics');
    expect(TRUST_LABELS.reviewed.base).toBe('Reviewed');
    expect(TRUST_LABELS.ai_generated.base).toBe('AI-Generated');
    expect(TRUST_LABELS.insufficient_context.base).toBe('Insufficient-Context');
    expect(TRUST_LABELS.conflict.base).toBe('Conflict');
  });

  it('composes base + optional qualifier into a display string', () => {
    expect(resolveTrustLabel('certified').display).toBe('Certified');
    expect(
      resolveTrustLabel('certified', TRUST_QUALIFIER_INVARIANT_VIOLATED).display,
    ).toBe('Certified · invariant violated');
    const resolved = resolveTrustLabel('certified', TRUST_QUALIFIER_INVARIANT_VIOLATED);
    expect(resolved.base).toBe('Certified');
    expect(resolved.qualifier).toBe('invariant violated');
  });

  it('degrades an unknown label id to the safe default rather than throwing', () => {
    expect(DEFAULT_TRUST_LABEL_ID).toBe('insufficient_context');
    const resolved = resolveTrustLabel('totally_made_up');
    expect(resolved.id).toBe('insufficient_context');
    expect(resolved.display).toBe('Insufficient-Context');
    expect(resolveTrustLabel(undefined).id).toBe('insufficient_context');
  });

  it('maps every agent/MCP route to a canonical label id', () => {
    const map: Record<string, TrustLabelId> = {
      certified: 'certified',
      semantic_answer: 'governed',
      semantic_compile: 'governed',
      research: 'reviewed',
      generated_sql: 'ai_generated',
      clarify: 'insufficient_context',
      conflict: 'conflict',
    };
    for (const [route, id] of Object.entries(map)) {
      expect(trustLabelIdForRoute(route)).toBe(id);
    }
    // Unknown route degrades safely.
    expect(trustLabelIdForRoute('something_else')).toBe('insufficient_context');
  });

  it('maps legacy status strings to canonical labels, additively', () => {
    expect(trustLabelIdForStatus('certified')).toBe('certified');
    expect(trustLabelIdForStatus('approved')).toBe('certified');
    // The Ask page's run trust states read the same words over MCP.
    expect(trustLabelIdForStatus('governed')).toBe('governed');
    expect(trustLabelIdForStatus('review_required')).toBe('ai_generated');
    expect(trustLabelIdForStatus('draft')).toBe('ai_generated');
    expect(trustLabelIdForStatus('pending_recertification')).toBe('ai_generated');
    expect(trustLabelIdForStatus('conflict')).toBe('conflict');
    expect(trustLabelIdForStatus('uncertified')).toBe('insufficient_context');
    // Unknown status degrades safely (backward compatible).
    expect(trustLabelIdForStatus('brand_new_status')).toBe('insufficient_context');
    expect(trustLabelIdForStatus(undefined)).toBe('insufficient_context');
  });
});

describe('freshness-aware trust qualifiers', () => {
  it('maps only stale/failed data states to a qualifier', () => {
    expect(dataStateQualifier('failed')).toBe(TRUST_QUALIFIER_UPSTREAM_FAILED);
    expect(dataStateQualifier('stale')).toBe(TRUST_QUALIFIER_STALE_DATA);
    // fresh / unknown / undefined never downgrade the label.
    expect(dataStateQualifier('fresh')).toBeUndefined();
    expect(dataStateQualifier('unknown')).toBeUndefined();
    expect(dataStateQualifier(undefined)).toBeUndefined();
  });

  it('composes "Certified · upstream failed" for a failed upstream', () => {
    const resolved = composeEffectiveTrust({ id: 'certified', dataState: 'failed' });
    expect(resolved.display).toBe('Certified · upstream failed');
    expect(resolved.base).toBe('Certified');
    expect(resolved.qualifier).toBe('upstream failed');
  });

  it('composes "Certified · stale data" for stale upstream data', () => {
    expect(composeEffectiveTrust({ id: 'certified', dataState: 'stale' }).display).toBe(
      'Certified · stale data',
    );
  });

  it('leaves a fresh certified block as plain "Certified"', () => {
    expect(composeEffectiveTrust({ id: 'certified', dataState: 'fresh' }).display).toBe('Certified');
    expect(composeEffectiveTrust({ id: 'certified' }).display).toBe('Certified');
    expect(composeEffectiveTrust({ id: 'certified', dataState: 'unknown' }).display).toBe('Certified');
  });

  it('lets an explicit invariant qualifier win over the freshness axis', () => {
    // Both an invariant violation and a stale upstream apply: the stronger
    // invariant signal keeps the single qualifier slot.
    const resolved = composeEffectiveTrust({
      id: 'certified',
      dataState: 'stale',
      existingQualifier: TRUST_QUALIFIER_INVARIANT_VIOLATED,
    });
    expect(resolved.display).toBe('Certified · invariant violated');
  });
});
