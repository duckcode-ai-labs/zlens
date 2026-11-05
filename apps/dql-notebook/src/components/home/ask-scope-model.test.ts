import { describe, expect, it } from 'vitest';
import { scopeLabel, scopeProblem } from './ask-scope-model';

const options = [{ id: 'commerce', label: 'Commerce', areas: [{ id: 'commerce::model_area::core', name: 'Core' }], purposes: ['revenue reporting'] }];

describe('Ask scope picker', () => {
  it('names a saved scope that no longer exists instead of answering unscoped silently', () => {
    expect(scopeProblem({ domain: 'finance' }, options)).toBe('The domain “finance” no longer exists.');
    expect(scopeProblem({ domain: 'commerce', modelAreaId: 'commerce::model_area::gone' }, options)).toBe('The area “gone” no longer exists in Commerce.');
    expect(scopeProblem({ domain: 'commerce' }, options)).toBeUndefined();
    // Before the list loads nothing is flagged.
    expect(scopeProblem({ domain: 'finance' }, null)).toBeUndefined();
  });

  it('labels the scope in plain words', () => {
    expect(scopeLabel(undefined, options)).toBe('All domains');
    expect(scopeLabel({ domain: 'commerce', modelAreaId: 'commerce::model_area::core', purpose: 'revenue reporting' }, options)).toBe('Commerce · Core · for revenue reporting');
  });
});
