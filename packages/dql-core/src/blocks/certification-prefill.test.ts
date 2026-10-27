import { describe, expect, it } from 'vitest';
import { prefillCertificationMetadata } from './certification-prefill.js';

const semantic = `block "revenue_by_region" {
  type = "semantic"
  status = "draft"
  metrics = ["revenue", "margin"]
  dimensions = ["region", "segment"]
}
`;

describe('prefillCertificationMetadata (exported from dql-core)', () => {
  it('ignores an unrelated answer SQL and columns for a semantic block', () => {
    const { source, suggested } = prefillCertificationMetadata(semantic, {
      sql: 'SELECT customer_id, COUNT(*) AS n FROM raw.payments GROUP BY customer_id',
      columns: ['customer_id', 'n'],
      entities: ['orders'],
      sourceSystemFor: () => 'model.shop.payments',
    });
    expect(source).toContain('grain = "one row per region, segment"');
    expect(source).toContain('outputs = ["region", "segment", "revenue", "margin"]');
    expect(source).not.toContain('customer_id');
    expect(source).not.toContain('payments');
    expect(suggested.some((entry) => entry.field === 'sourceSystems')).toBe(false);
  });

  it('keeps using the answer SQL for a draft that has no query and no semantic fields', () => {
    const skeleton = 'block "x" {\n  status = "draft"\n}\n';
    const { source } = prefillCertificationMetadata(skeleton, {
      sql: 'SELECT region FROM analytics.orders GROUP BY region',
      columns: ['region'],
    });
    expect(source).toContain('grain = "one row per region"');
    expect(source).toContain('sourceSystems = ["analytics.orders"]');
  });

  it('can be called by a draft writer outside the CLI: marks every value as a suggestion', () => {
    const { source } = prefillCertificationMetadata(semantic, { owner: 'lena@example.com' });
    expect(source).toContain('// Suggested by DQL from this answer. Review each value before you certify:');
    expect(source).toContain('owner = "lena@example.com"');
    expect(source).toMatch(/tests \{\s+assert row_count > 0\s+\}/);
  });
});

describe('the question the answer was given for', () => {
  const skeleton = 'block "adjusters" {\n  status = "draft"\n  query = """SELECT adjuster_id, COUNT(*) AS open_claims FROM claims GROUP BY adjuster_id"""\n}\n';

  it('is recorded as the block\'s example, as a question the certified block answers', () => {
    const { source, suggested } = prefillCertificationMetadata(skeleton, { question: '  Which adjusters handle\n the most open claims? ' });
    expect(source).toContain('examples = [{ question = "Which adjusters handle the most open claims?" }]');
    expect(suggested).toContainEqual({ field: 'examples', value: ['Which adjusters handle the most open claims?'] });
    expect(source).toMatch(/Review each value before you certify: .*examples/);
  });

  it('never overwrites examples the draft already declares, and is not listed as unknown when there is no question', () => {
    const declared = skeleton.replace('status = "draft"', 'status = "draft"\n  examples = [{ question = "Open claims per adjuster" }]');
    const kept = prefillCertificationMetadata(declared, { question: 'Which adjusters handle the most open claims?' });
    expect(kept.source).toContain('examples = [{ question = "Open claims per adjuster" }]');
    expect(kept.source).not.toContain('Which adjusters');
    const none = prefillCertificationMetadata(skeleton, {});
    expect(none.unknown).not.toContain('examples');
    expect(none.source).not.toContain('examples');
  });
});
