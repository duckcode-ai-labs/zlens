import { describe, expect, it } from 'vitest';
import { groupingIdentityGapOfSql } from '@zlens/core';
import { extractBlockContract } from '../block-contract.js';
import { parseIntent } from '../intent.js';
import { buildVocabularyIndex } from '../vocabulary.js';
import { entails } from './certified.js';

/**
 * The certify-time warning and the certified matcher read the same SQL the same
 * way: a block the matcher refuses for a missing identity key is exactly a
 * block the warning names, and the reverse.
 */

const KNOWN = [{ relation: 'main.claims', columns: ['claim_id', 'adjuster_id', 'adjuster_name', 'region'], primaryKey: ['claim_id'] }];

const matcherRefusesForIdentity = (sql: string): boolean => {
  const name = 'claims_by_group';
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'claim_count', model: 'claims', aggregation: 'count_distinct', physical: { relation: 'claims', expr: '"claims"."claim_id"', aggregate: 'count_distinct' } }],
    dimensions: [{ name: 'adjuster_name', model: 'claims', dataType: 'string', physical: { relation: 'claims', column: 'adjuster_name' } }],
    blocks: [{ name, domain: 'claims', certified: true, sql, contract: extractBlockContract({ name, domain: 'claims', sql }) }],
  });
  const parsed = parseIntent({
    version: 1, kind: 'analytics', reading: 'Claims by adjuster', display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'breakdown',
    measures: [{ ref: 'metric:claims.claim_count' }],
    groupBy: [{ ref: 'dimension:claims.adjuster_name', role: 'categorical' }],
  });
  const verdict = entails(vocabulary.get('block:claims.claims_by_group')!, parsed.intent!, vocabulary);
  return verdict.identityNote !== undefined;
};

const CASES: Array<{ label: string; sql: string; gap: boolean }> = [
  { label: 'a name only', sql: 'SELECT adjuster_name, COUNT(DISTINCT claim_id) AS claim_count FROM claims GROUP BY adjuster_name', gap: true },
  { label: 'a name and its key', sql: 'SELECT adjuster_id, adjuster_name, COUNT(DISTINCT claim_id) AS claim_count FROM claims GROUP BY adjuster_id, adjuster_name', gap: false },
  { label: 'a name with GROUP BY ALL', sql: 'SELECT adjuster_name, COUNT(DISTINCT claim_id) AS claim_count FROM claims GROUP BY ALL', gap: true },
  { label: 'a name by position', sql: 'SELECT adjuster_name, COUNT(DISTINCT claim_id) AS claim_count FROM claims GROUP BY 1', gap: true },
  { label: 'a name aliased to a non-label output', sql: 'SELECT adjuster_name AS adjuster, COUNT(DISTINCT claim_id) AS claim_count FROM claims GROUP BY adjuster_name', gap: false },
  { label: 'a plain dimension', sql: 'SELECT region, COUNT(DISTINCT claim_id) AS claim_count FROM claims GROUP BY region', gap: false },
];

describe('the certify warning and the certified matcher agree', () => {
  for (const { label, sql, gap } of CASES) {
    it(`groups by ${label}`, () => {
      expect(matcherRefusesForIdentity(sql)).toBe(gap);
      expect(groupingIdentityGapOfSql(sql, KNOWN) !== undefined).toBe(gap);
    });
  }

  it('names the label and the key from the table', () => {
    expect(groupingIdentityGapOfSql(CASES[0]!.sql, KNOWN)?.message).toBe(
      "Ask can't use this saved query as a certified answer: it groups by adjuster_name only. Add adjuster_id (the key) to SELECT and GROUP BY.",
    );
  });

  it('still warns, without naming a key, when the table key is unknown', () => {
    const gapWithoutKey = groupingIdentityGapOfSql(CASES[0]!.sql);
    expect(gapWithoutKey?.key).toBeUndefined();
    expect(gapWithoutKey?.message).toMatch(/groups by adjuster_name only/);
  });

  it('says nothing when the grouping cannot be read', () => {
    expect(groupingIdentityGapOfSql('SELECT COUNT(*) AS n FROM claims')).toBeUndefined();
    expect(groupingIdentityGapOfSql('SELECT lower(adjuster_name) AS a, COUNT(*) AS n FROM claims GROUP BY lower(adjuster_name)', KNOWN)).toBeUndefined();
  });
});
