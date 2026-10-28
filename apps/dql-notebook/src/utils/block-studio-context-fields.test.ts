import { describe, expect, it } from 'vitest';
import { parse } from '@zlens/core';
import { setBlockArray, setBlockStringField } from './block-studio.js';

/** A block as Block Studio saves it: the formatter's header, then sections after the fields. */
const SAVED = `// dql-format: 1

block "orders_by_store" {
  domain = "commerce"
  type = "custom"
  status = "draft"
  owner = "analytics@jaffle.shop"
  tags = ["orders", "stores"]

  query = """
    SELECT l.location_name, COUNT(*) AS order_count
    FROM dev.orders o JOIN dev.locations l ON o.location_id = l.location_id
    GROUP BY 1
  """

  visualization {
    chart = "bar"
  }

  tests {
    assert row_count > 0
  }
}
`;

function block(source: string) {
  const statement = parse(source, '<block-invocation>').statements[0];
  if (!statement || statement.kind !== 'BlockDecl') throw new Error('expected a block');
  return statement;
}

describe('Block Studio context fields', () => {
  it('puts a new field with the block\'s other fields, before query, visualization and tests', () => {
    let source = setBlockStringField(SAVED, 'businessOutcome', 'Staff stores to demand');
    source = setBlockStringField(source, 'llmContext', 'Use for orders per store');
    const lines = source.split('\n');
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(at('businessOutcome =')).toBe(at('tags =') + 1);
    expect(at('llmContext =')).toBe(at('businessOutcome =') + 1);
    expect(at('llmContext =')).toBeLessThan(at('query ='));
    expect(source.trimEnd().endsWith('}')).toBe(true);
    expect(block(source)).toMatchObject({ businessOutcome: 'Staff stores to demand', llmContext: 'Use for orders per store' });
  });

  it('adds a field to a block with no fields yet right after its opening line', () => {
    const source = setBlockStringField('block "x" {\n  query = """SELECT 1"""\n}\n', 'owner', 'a@b.c');
    expect(source).toBe('block "x" {\n  owner = "a@b.c"\n  query = """SELECT 1"""\n}');
  });

  it('writes question aliases, business terms and rules and caveats the block parser accepts', () => {
    let source = setBlockArray(SAVED, 'synonyms', ['store orders', 'orders per location']);
    source = setBlockArray(source, 'primaryTerms', ['order volume']);
    source = setBlockArray(source, 'sourceSystems', ['dbt:orders']);
    source = setBlockArray(source, 'caveats', ['Excludes cancelled orders', 'Counts "pickup" orders too', '']);
    expect(source).toContain('caveats = ["Excludes cancelled orders", "Counts \\"pickup\\" orders too"]');
    expect(block(source)).toMatchObject({
      synonyms: ['store orders', 'orders per location'],
      primaryTerms: ['order volume'],
      sourceSystems: ['dbt:orders'],
      caveats: ['Excludes cancelled orders', 'Counts "pickup" orders too'],
    });
  });

  it('replaces a single-string caveats an earlier version wrote instead of adding a second one', () => {
    const legacy = SAVED.replace('  tags = ["orders", "stores"]', '  tags = ["orders", "stores"]\n  caveats = "Excludes refunds"');
    const source = setBlockArray(legacy, 'caveats', ['Excludes refunds', 'Excludes test stores']);
    expect(source.match(/caveats =/g)).toHaveLength(1);
    expect(block(source).caveats).toEqual(['Excludes refunds', 'Excludes test stores']);
  });
});

describe('Questions it answers (examples)', () => {
  it('writes the questions as examples the block parser reads, with the other fields', async () => {
    const { blockExampleQuestions, setBlockExampleQuestions } = await import('./block-studio.js');
    const source = setBlockExampleQuestions(SAVED, ['Which stores take the most orders?', ' Orders per store, by location ', 'Which stores take the most orders?']);
    expect(source).toContain('examples = [{ question = "Which stores take the most orders?" }, { question = "Orders per store, by location" }]');
    expect(source.indexOf('examples =')).toBeLessThan(source.indexOf('query ='));
    expect(block(source).examples).toEqual([{ question: 'Which stores take the most orders?' }, { question: 'Orders per store, by location' }]);
    expect(blockExampleQuestions(source)).toEqual(['Which stores take the most orders?', 'Orders per store, by location']);
  });

  it('keeps the SQL an example carried, escapes quotes, and removes the field when the last question goes', async () => {
    const { blockExampleQuestions, setBlockExampleQuestions } = await import('./block-studio.js');
    const withSql = SAVED.replace('tags = ["orders", "stores"]', 'tags = ["orders", "stores"]\n  examples = [{ question = "Orders per store", sql = "SELECT 1" }, { question = "Old question" }]');
    const edited = setBlockExampleQuestions(withSql, ['Orders per store', 'Say "hi" to stores']);
    expect(edited).toContain('examples = [{ question = "Orders per store", sql = "SELECT 1" }, { question = "Say \\"hi\\" to stores" }]');
    expect(edited).not.toContain('Old question');
    expect(blockExampleQuestions(edited)).toEqual(['Orders per store', 'Say "hi" to stores']);
    expect(block(edited).examples).toEqual([{ question: 'Orders per store', sql: 'SELECT 1' }, { question: 'Say "hi" to stores' }]);
    const cleared = setBlockExampleQuestions(edited, []);
    expect(cleared).not.toMatch(/examples/);
    expect(block(cleared).examples).toBeUndefined();
    expect(setBlockExampleQuestions(SAVED, [])).toBe(SAVED);
  });
});
