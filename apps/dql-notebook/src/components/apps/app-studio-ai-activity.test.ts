import { describe, expect, it } from 'vitest';
import {
  APP_STUDIO_AI_ACTIVITY_LABELS,
  appStudioProposalRetry,
  appStudioReviewAddRetry,
  appStudioRevisionRetry,
  appStudioSourceActionLabel,
  nextAppStudioAiActivityIndex,
} from './app-studio-ai-activity';

describe('App Studio AI activity and source actions (UI-022, UI-023, E2E-020)', () => {
  it('uses honest non-percentage planning labels in a deterministic rotation', () => {
    expect(APP_STUDIO_AI_ACTIVITY_LABELS).toEqual([
      'Understanding your decision',
      'Finding certified tables, Metrics and saved queries',
      'Checking trust and capabilities',
      'Preparing source review',
    ]);
    expect(APP_STUDIO_AI_ACTIVITY_LABELS.join(' ')).not.toMatch(/\d+%|complete|reconnect/i);
    expect(nextAppStudioAiActivityIndex(3)).toBe(0);
  });

  it('makes review-lane activation and row-local compose feedback explicit', () => {
    expect(appStudioSourceActionLabel({ view: 'Chart', status: 'idle', reviewRequired: true, alreadyUsed: false }))
      .toBe('Allow data that needs review & add Chart');
    expect(appStudioSourceActionLabel({ view: 'Chart', status: 'adding', reviewRequired: false, alreadyUsed: false }))
      .toBe('Adding…');
    expect(appStudioSourceActionLabel({ view: 'Chart', status: 'added', reviewRequired: false, alreadyUsed: true, pageTitle: 'Overview' }))
      .toBe('Added to Overview');
    expect(appStudioSourceActionLabel({ view: 'Chart', status: 'idle', reviewRequired: false, alreadyUsed: true }))
      .toBe('Add another Chart');
    expect(appStudioSourceActionLabel({ view: 'Chart', status: 'error', reviewRequired: false, alreadyUsed: false }))
      .toBe('Try add Chart');
  });

  it('preserves the exact failed operation inputs for activity retry', () => {
    expect(appStudioProposalRetry('Re-run this decision', ['source:b', 'source:a', 'source:b'])).toEqual({
      kind: 'propose', prompt: 'Re-run this decision', requiredSourceIds: ['source:b', 'source:a'],
    });
    expect(appStudioRevisionRetry({ audience: 'Finance' }, ['source:a'])).toEqual({
      kind: 'revise', answers: { audience: 'Finance' }, requiredSourceIds: ['source:a'],
    });
    expect(appStudioReviewAddRetry('Margin decision', 'review:margin', ['source:a', 'review:margin'])).toEqual({
      kind: 'enable_review_and_propose', prompt: 'Margin decision', sourceId: 'review:margin', requiredSourceIds: ['source:a', 'review:margin'],
    });
  });
});
