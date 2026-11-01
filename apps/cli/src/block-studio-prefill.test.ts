import { describe, expect, it } from 'vitest';
import { parseBlockSourceMetadata } from './local-runtime.js';
import { certificationFieldGaps, certificationFieldLabel } from '@zlens/core';
import { prefillCertificationMetadata } from './block-studio-prefill.js';

const sqlDraft = `block "revenue_by_region" {
  status = "draft"
  domain = "sales"
  type = "custom"
  description = "Revenue by region"
  tags = ["ai-generated", "review-required"]

  query = """
    SELECT region, SUM(amount) AS revenue
    FROM analytics.orders
    GROUP BY region
  """

  visualization {
    chart = "table"
  }
}
`;

describe('certificationFieldGaps', () => {
  it('names every field a draft has not filled, and none once they are', () => {
    expect(certificationFieldGaps(sqlDraft)).toEqual(['grain', 'outputs', 'reviewCadence', 'sourceSystems', 'tests']);
    expect(certificationFieldGaps(prefillCertificationMetadata(sqlDraft).source)).toEqual([]);
  });

  it('reads an empty value or an empty tests section as not filled', () => {
    const emptied = sqlDraft.replace('type = "custom"', 'type = "custom"\n  grain = ""\n  outputs = []\n  reviewCadence = ""').replace('visualization {', 'tests {\n  }\n\n  visualization {');
    expect(certificationFieldGaps(emptied)).toEqual(['grain', 'outputs', 'reviewCadence', 'sourceSystems', 'tests']);
  });

  it('has the words a person reads for each field', () => {
    expect(certificationFieldLabel('reviewCadence')).toBe('review cadence');
    expect(certificationFieldLabel('tests')).toBe('a test');
    expect(certificationFieldLabel('entities')).toBe('entities');
  });
});

describe('prefillCertificationMetadata', () => {
  it('fills an empty tests section in place, so the block keeps one', () => {
    const { source } = prefillCertificationMetadata(sqlDraft.replace('visualization {', 'tests {\n  }\n\n  visualization {'));
    expect(source.match(/\btests\s*\{/g)).toHaveLength(1);
    expect(source).toMatch(/tests \{\s+assert row_count > 0\s+\}/);
  });

  it('fills the seven certification fields from what the answer knows', () => {
    const { source, suggested, unknown } = prefillCertificationMetadata(sqlDraft, {
      columns: ['region', 'revenue'],
      owner: 'lena@example.com',
      sourceSystemFor: (table) => (table === 'analytics.orders' ? 'model.shop.orders' : undefined),
    });
    const meta = parseBlockSourceMetadata(source);
    expect(meta.pattern).toBe('custom');
    expect(meta.grain).toBe('one row per region');
    expect(meta.outputs).toEqual(['region', 'revenue']);
    expect(meta.reviewCadence).toBe('quarterly');
    expect(meta.entities).toEqual(['orders']);
    expect(meta.sourceSystems).toEqual(['model.shop.orders']);
    expect(meta.owner).toBe('lena@example.com');
    expect(source).toMatch(/tests \{\s+assert row_count > 0\s+\}/);
    expect(suggested.map((entry) => entry.field).sort()).toEqual(
      ['entities', 'grain', 'outputs', 'owner', 'pattern', 'reviewCadence', 'sourceSystems', 'tests'],
    );
    expect(unknown).toEqual([]);
  });

  it('marks the values as suggestions in the source, visibly', () => {
    const { source } = prefillCertificationMetadata(sqlDraft, { columns: ['region', 'revenue'] });
    expect(source).toContain('// Suggested by DQL from this answer. Review each value before you certify:');
  });

  it('falls back to table names for source systems when lineage knows no dbt node', () => {
    const meta = parseBlockSourceMetadata(prefillCertificationMetadata(sqlDraft).source);
    expect(meta.sourceSystems).toEqual(['analytics.orders']);
  });

  it('never overrides a value the draft already declares', () => {
    const declared = sqlDraft.replace('type = "custom"', 'type = "custom"\n  pattern = "ranking"\n  grain = "one row per customer"\n  reviewCadence = "monthly"');
    const meta = parseBlockSourceMetadata(prefillCertificationMetadata(declared).source);
    expect(meta.pattern).toBe('ranking');
    expect(meta.grain).toBe('one row per customer');
    expect(meta.reviewCadence).toBe('monthly');
  });

  it('fills a skeleton field that was left empty once, in place', () => {
    const skeleton = sqlDraft.replace('type = "custom"', 'type = "custom"\n  owner = ""\n  pattern = ""');
    const { source } = prefillCertificationMetadata(skeleton, { owner: 'lena@example.com' });
    expect(source.match(/\bowner\s*=/g)).toHaveLength(1);
    expect(source.match(/\bpattern\s*=/g)).toHaveLength(1);
    expect(parseBlockSourceMetadata(source).owner).toBe('lena@example.com');
  });

  it('keeps an existing tests block and does not add another', () => {
    const withTests = sqlDraft.replace(/\}\n$/, '  tests {\n    assert row_count >= 3\n  }\n}\n');
    const { source, suggested } = prefillCertificationMetadata(withTests);
    expect(source.match(/\btests\s*\{/g)).toHaveLength(1);
    expect(suggested.some((entry) => entry.field === 'tests')).toBe(false);
  });

  it('resolves a positional GROUP BY to the output column it names', () => {
    const positional = sqlDraft.replace('GROUP BY region', 'GROUP BY 1');
    expect(parseBlockSourceMetadata(prefillCertificationMetadata(positional).source).grain).toBe('one row per region');
  });

  it('says the grain is unknown rather than guessing when there is no GROUP BY or it holds an expression', () => {
    const none = sqlDraft.replace('GROUP BY region', '');
    const expression = sqlDraft.replace('GROUP BY region', "GROUP BY date_trunc('month', created_at)");
    for (const source of [none, expression]) {
      const result = prefillCertificationMetadata(source);
      expect(parseBlockSourceMetadata(result.source).grain).toBe('');
      expect(result.unknown).toContain('grain');
    }
  });

  it('uses dimensions as the grain and metrics as outputs for a semantic draft', () => {
    const semantic = `block "revenue_by_region" {
  type = "semantic"
  status = "draft"
  metrics = ["revenue", "margin"]
  dimensions = ["region", "segment"]
}
`;
    const meta = parseBlockSourceMetadata(prefillCertificationMetadata(semantic, { entities: ['orders'] }).source);
    expect(meta.grain).toBe('one row per region, segment');
    expect(meta.outputs).toEqual(['region', 'segment', 'revenue', 'margin']);
    expect(meta.entities).toEqual(['orders']);
  });

  it('leaves a source with no block header untouched', () => {
    const result = prefillCertificationMetadata('SELECT 1');
    expect(result).toEqual({ source: 'SELECT 1', suggested: [], unknown: [] });
  });
});
