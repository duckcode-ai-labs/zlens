import { describe, expect, it } from 'vitest';
import { blockTestAssertionName, evaluateBlockTestAssertion } from './block-test-assertions.js';

const result = {
  columns: ['region', 'revenue'],
  rows: [
    { region: 'east', revenue: 120 },
    { region: 'west', revenue: -5 },
    { region: 'north', revenue: 80 },
  ],
};

describe('block test assertions', () => {
  it('holds a column test on every row, not only the first', () => {
    const outcome = evaluateBlockTestAssertion({ field: 'revenue', operator: '>=', expected: 0 }, result);
    expect(outcome.passed).toBe(false);
    expect(outcome.actual).toBe(-5);
    expect(outcome.error).toContain('1 of 3 rows fail');
    expect(outcome.error).toContain('row 2');
    expect(evaluateBlockTestAssertion({ field: 'revenue', operator: '>', expected: -10 }, result).passed).toBe(true);
  });

  it('checks IN against a list of values', () => {
    expect(evaluateBlockTestAssertion({ field: 'region', operator: 'IN', expected: ['east', 'west', 'north'] }, result).passed).toBe(true);
    const missing = evaluateBlockTestAssertion({ field: 'region', operator: 'IN', expected: ['east', 'west'] }, result);
    expect(missing.passed).toBe(false);
    expect(missing.actual).toBe('north');
    // A parsed array literal works the same as an evaluated array.
    const literal = { kind: 'ArrayLiteral', elements: [{ value: 120 }, { value: -5 }, { value: 80 }] };
    expect(evaluateBlockTestAssertion({ field: 'revenue', operator: 'IN', expected: literal }, result).passed).toBe(true);
    expect(blockTestAssertionName({ field: 'region', operator: 'IN', expected: ['east', 'west'] })).toBe('assert region IN [east, west]');
    expect(evaluateBlockTestAssertion({ field: 'region', operator: 'IN', expected: 'east' }, result).error).toContain('needs a list');
  });

  it('compares row_count, equality across types, and nulls', () => {
    expect(evaluateBlockTestAssertion({ field: 'row_count', operator: '==', expected: 3 }, result).passed).toBe(true);
    expect(evaluateBlockTestAssertion({ field: 'row_count', operator: '>', expected: 3 }, result).passed).toBe(false);
    expect(evaluateBlockTestAssertion({ field: 'n', operator: '==', expected: 2 }, { columns: ['n'], rows: [{ n: 2n }, { n: '2' }] }).passed).toBe(true);
    expect(evaluateBlockTestAssertion({ field: 'n', operator: '>=', expected: 0 }, { columns: ['n'], rows: [{ n: null }] }).passed).toBe(false);
    expect(evaluateBlockTestAssertion({ field: 'n', operator: '!=', expected: 'null' }, { columns: ['n'], rows: [{ n: 1 }, { n: null }] }).passed).toBe(false);
  });

  it('passes a column test on an empty result and fails one on a missing column', () => {
    expect(evaluateBlockTestAssertion({ field: 'revenue', operator: '>=', expected: 0 }, { columns: ['revenue'], rows: [] }).passed).toBe(true);
    expect(evaluateBlockTestAssertion({ field: 'margin', operator: '>=', expected: 0 }, result).error).toBe("Column 'margin' not found in results");
  });
});
