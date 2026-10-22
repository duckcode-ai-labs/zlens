import { describe, expect, it } from 'vitest';
import type { ManifestRelationshipValidationEvidence } from '@zlens/core';
import { joinCertifyDecision, nextRelationshipId, savedQueryReview, savedQueryRowSentence } from './inline-certify.js';

const evidence = (overrides: Partial<ManifestRelationshipValidationEvidence> = {}): ManifestRelationshipValidationEvidence => ({
  status: 'passed',
  checkedAt: '2026-10-22T10:00:00.000Z',
  queryFingerprint: 'q',
  fromRows: 61948,
  toRows: 6,
  joinedRows: 61948,
  fromNullKeys: 0,
  toNullKeys: 0,
  unmatchedFrom: 0,
  maxFromPerKey: 12000,
  maxToPerKey: 1,
  unmatchedKeyedFrom: 0,
  ...overrides,
});

describe('saved query review (T4)', () => {
  const verdict = (overrides: { preview?: boolean; assertions?: Array<{ name: string; passed: boolean; error?: string }>; issues?: Array<{ code: string; message: string }> } = {}) => ({
    preview: overrides.preview === false ? null : { result: { rowCount: 4, rows: [] } },
    testResults: { passed: 0, failed: 0, assertions: overrides.assertions ?? [] },
    checklist: { issues: overrides.issues ?? [] },
  });

  it('says it runs, lists its tests, names the owner and what one row is', () => {
    const review = savedQueryReview({
      verdict: verdict({ assertions: [{ name: 'row_count > 0', passed: true }, { name: 'net_amount >= 0', passed: true }] }),
      owner: 'Maria',
      dimensions: ['region'],
    });
    expect(review).toMatchObject({
      runs: { ok: true, sentence: 'Ran just now: 4 rows.' },
      testsSentence: 'All 2 tests pass.',
      owner: 'Maria',
      ownerRequired: false,
      row: 'One row for each region.',
      blockers: [],
    });
    expect(review.checks).toEqual(['Runs: ran on certification, 4 rows.', 'Tests: All 2 tests pass.', 'Owner: Maria', 'One row: One row for each region.']);
  });

  it('asks for an owner without counting it as a blocker, and keeps a failed test as one', () => {
    const review = savedQueryReview({
      verdict: verdict({
        assertions: [{ name: 'row_count > 1000000', passed: false, error: 'expected more rows' }],
        issues: [{ code: 'owner_missing', message: 'Owner is required before certification.' }, { code: 'tests_failed', message: 'One or more declared tests did not pass against the latest preview result.' }],
      }),
    });
    expect(review.ownerRequired).toBe(true);
    expect(review.owner).toBeUndefined();
    expect(review.testsSentence).toBe('1 of 1 test failed.');
    expect(review.tests).toEqual([{ name: 'row_count > 1000000', passed: false, error: 'expected more rows' }]);
    expect(review.blockers).toEqual(['One or more declared tests did not pass against the latest preview result.']);
  });

  it('says why it did not run, and when it declares no tests', () => {
    const review = savedQueryReview({ verdict: verdict({ preview: false, issues: [{ code: 'preview_failed', message: 'Table missing_table does not exist.' }] }), owner: 'Maria' });
    expect(review.runs).toEqual({ ok: false, error: 'Table missing_table does not exist.' });
    expect(review.testsSentence).toBe('No tests declared.');
    expect(review.checks).toEqual(['Tests: No tests declared.', 'Owner: Maria']);
  });

  it('reads one row from the grain, the grouping columns or the key fields', () => {
    expect(savedQueryRowSentence({ grain: 'order_line' })).toBe('Each row is one order line.');
    expect(savedQueryRowSentence({ dimensions: ['region', 'order_month'] })).toBe('One row for each region and order month.');
    expect(savedQueryRowSentence({ keyFields: ['order_id'] })).toBe('Each row is one order id.');
    expect(savedQueryRowSentence({})).toBeUndefined();
  });
});

describe('join certification decision (T4)', () => {
  const sides = {
    from: { table: 'orders', noun: 'order' },
    to: { table: 'locations', noun: 'location' },
  };

  it('certifies a checked many-to-one join and fills each side\'s grain and keys from the checks just run', () => {
    const decision = joinCertifyDecision({
      ...sides,
      keys: [{ from: 'location_id', to: 'location_id' }],
      cardinality: 'many_to_one',
      evidence: evidence(),
      sentence: 'each order has one location',
      rowKeyChecks: { from: { keys: ['order_id'], ok: true, source: 'the row key of Orders, checked just now' } },
      measures: ['order_total'],
    });
    expect(decision.ok).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.keysSentence).toBe('orders.location_id = locations.location_id');
    expect(decision.checkedSentence).toBe('each order has one location — checked on 61,948 rows');
    expect(decision.checkLines).toEqual(['Every order with a key finds its location.']);
    expect(decision.doubleCount).toBe('If locations had two rows for one location_id, every order with that value would be joined twice, so totals such as order total would be counted more than once.');
    expect(decision.fills).toEqual([
      { side: 'from', table: 'orders', grain: 'order_id', keys: ['order_id'], because: 'order_id is filled and different on every row of orders (the row key of Orders, checked just now).' },
      { side: 'to', table: 'locations', grain: 'location_id', keys: ['location_id'], because: 'location_id is filled and different on every one of 6 rows of locations, checked just now.' },
    ]);
    expect(decision.certifiedAgainst).toEqual({ from: { grain: 'order_id', keys: ['order_id'] }, to: { grain: 'location_id', keys: ['location_id'] } });
  });

  it('keeps grain and keys the model already has and fills nothing then', () => {
    const decision = joinCertifyDecision({
      from: { ...sides.from, grain: 'order', keys: ['order_id'] },
      to: { ...sides.to, grain: 'location', keys: ['location_id'] },
      keys: [{ from: 'location_id', to: 'location_id' }],
      cardinality: 'many_to_one',
      evidence: evidence(),
    });
    expect(decision.ok).toBe(true);
    expect(decision.fills).toEqual([]);
    expect(decision.certifiedAgainst).toEqual({ from: { grain: 'order', keys: ['order_id'] }, to: { grain: 'location', keys: ['location_id'] } });
  });

  it('refuses when the check fails, says why, and fills nothing', () => {
    const decision = joinCertifyDecision({
      ...sides,
      keys: [{ from: 'location_id', to: 'location_id' }],
      cardinality: 'many_to_one',
      evidence: evidence({ status: 'failed', maxToPerKey: 2, message: 'Warehouse evidence does not prove the declared cardinality and safe fanout policy. The declared many_to_one does not hold: locations holds up to 2 rows for one key.' }),
      rowKeyChecks: { from: { keys: ['order_id'], ok: true, source: 'checked' } },
    });
    expect(decision.ok).toBe(false);
    expect(decision.blockers).toEqual(['The check did not pass: The declared many_to_one does not hold: locations holds up to 2 rows for one key.']);
    expect(decision.checkedSentence).toBeUndefined();
    expect(decision.fills).toEqual([]);
    expect(decision.certifiedAgainst).toBeUndefined();
  });

  it('never fills a side no check proved', () => {
    const noRowKey = joinCertifyDecision({ ...sides, keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'many_to_one', evidence: evidence() });
    expect(noRowKey.ok).toBe(false);
    expect(noRowKey.blockers).toEqual(['ZLens could not prove what one row of orders is: no check covers its row key yet. Certify orders as data first, or set its grain and key columns in Modeling.']);
    expect(noRowKey.fills).toEqual([]);

    const failedRowKey = joinCertifyDecision({
      ...sides,
      keys: [{ from: 'location_id', to: 'location_id' }],
      cardinality: 'many_to_one',
      evidence: evidence(),
      rowKeyChecks: { from: { keys: ['order_id'], ok: false, error: 'order_id repeats on 3 rows', source: 'checked' } },
    });
    expect(failedRowKey.blockers).toEqual(['ZLens could not prove what one row of orders is: order_id repeats on 3 rows.']);

    // An empty key on the "one" side is not a row key, even when every filled value is unique.
    const nullKeys = joinCertifyDecision({
      ...sides,
      keys: [{ from: 'location_id', to: 'location_id' }],
      cardinality: 'many_to_one',
      evidence: evidence({ toNullKeys: 1 }),
      rowKeyChecks: { from: { keys: ['order_id'], ok: true, source: 'checked' } },
    });
    expect(nullKeys.ok).toBe(false);
    expect(nullKeys.blockers[0]).toContain('could not prove what one row of locations is');
  });

  it('reads a one-to-many relationship from its "one" side and says what rows lose their match', () => {
    const decision = joinCertifyDecision({
      from: { table: 'locations', noun: 'location' },
      to: { table: 'orders', noun: 'order', grain: 'order_id', keys: ['order_id'] },
      keys: [{ from: 'location_id', to: 'location_id' }],
      cardinality: 'one_to_many',
      evidence: evidence({ fromRows: 6, toRows: 61948, maxFromPerKey: 1, maxToPerKey: 12000, unmatchedFrom: 1, unmatchedKeyedFrom: 1 }),
    });
    expect(decision.ok).toBe(true);
    expect(decision.checkedSentence).toBe('each order has one location — checked on 61,948 rows');
    expect(decision.checkLines).toEqual(['1 location with a key finds no order.']);
    expect(decision.fills.map((fill) => fill.side)).toEqual(['from']);
  });

  it('refuses a many-to-many join', () => {
    const decision = joinCertifyDecision({ ...sides, keys: [{ from: 'a', to: 'a' }], cardinality: 'many_to_many', evidence: evidence({ status: 'failed', message: '' }) });
    expect(decision.ok).toBe(false);
    expect(decision.blockers[0]).toContain('A many to many join cannot be certified');
  });

  it('names a new relationship without taking an id already used', () => {
    expect(nextRelationshipId('orders', 'locations', [])).toBe('orders_to_locations');
    expect(nextRelationshipId('orders', 'locations', ['orders_to_locations'])).toBe('orders_to_locations_2');
  });
});
