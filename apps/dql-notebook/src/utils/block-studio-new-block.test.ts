import { describe, expect, it } from 'vitest';
import { parse } from '@zlens/core';
import {
  hasCompleteBlockEnvelope,
  parseBlockFields,
  setBlockName,
  setBlockQuery,
  setBlockStringField,
  setBlockTags,
  startsWithBlockDeclaration,
  upsertVisualizationConfig,
} from './block-studio.js';

/**
 * B10, the SQL block builder: a new block's file opens with the formatter's
 * `// dql-format: 1` header. Every edit must land inside the block, and the SQL
 * typed in the Visual Builder must be in the draft (it survives switching to
 * DQL Source and back).
 */
const NEW_BLOCK = `// dql-format: 1

block "revenue_by_location" {
  domain = "uncategorized"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
SELECT 1 AS value
"""

  visualization {
    chart = "table"
  }
}
`;

const WITHOUT_OWNER = NEW_BLOCK.replace('  owner = ""\n', '');

function parsed(source: string) {
  const statement = parse(source, '<block-invocation>').statements[0];
  if (!statement || statement.kind !== 'BlockDecl') throw new Error('expected a block');
  return statement;
}

describe('SQL block builder on a new block (B10)', () => {
  it('reads the block after the dql-format header', () => {
    expect(startsWithBlockDeclaration(NEW_BLOCK)).toBe(true);
    expect(hasCompleteBlockEnvelope(NEW_BLOCK)).toBe(true);
    expect(parseBlockFields(NEW_BLOCK)).toMatchObject({ name: 'revenue_by_location', domain: 'uncategorized', blockType: 'custom' });
  });

  it('Save draft writes the owner inside the block, so the block parses', () => {
    const saved = setBlockStringField(WITHOUT_OWNER, 'owner', 'sales-analytics');
    expect(saved.trimEnd().endsWith('}')).toBe(true);
    expect(saved.indexOf('owner = "sales-analytics"')).toBeLessThan(saved.indexOf('query ='));
    expect(() => parse(saved, '<block-invocation>')).not.toThrow();
    expect(parsed(saved)).toMatchObject({ name: 'revenue_by_location', owner: 'sales-analytics' });
  });

  it('keeps a field inside the block when a comment follows the closing brace', () => {
    const trailing = `${WITHOUT_OWNER.trimEnd()}\n// saved from Block Studio\n`;
    const saved = setBlockStringField(trailing, 'owner', 'sales-analytics');
    expect(saved.indexOf('owner = "sales-analytics"')).toBeLessThan(saved.lastIndexOf('}'));
    expect(parsed(saved).owner).toBe('sales-analytics');
    const withChart = upsertVisualizationConfig(trailing.replace(/\n  visualization \{[\s\S]*?\n  \}\n/, '\n'), { chart: 'bar' });
    expect(withChart.indexOf('visualization {')).toBeLessThan(withChart.lastIndexOf('}'));
    expect(withChart.trimEnd().endsWith('// saved from Block Studio')).toBe(true);
  });

  it('puts SQL typed in the Visual Builder into the draft, so DQL Source and a tab switch show it', () => {
    const sql = 'SELECT l.location_name, SUM(o.order_total) AS revenue\nFROM orders o JOIN locations l ON o.location_id = l.location_id\nGROUP BY 1';
    const draft = setBlockQuery(NEW_BLOCK, sql);
    expect(draft).toContain('FROM orders o JOIN locations l');
    expect(draft).not.toContain('SELECT 1 AS value');
    expect(draft.startsWith('// dql-format: 1')).toBe(true);
    // The Visual Builder reads its SQL back from the draft when it opens again.
    expect(draft.match(/query\s*=\s*"""([\s\S]*?)"""/i)?.[1]?.trim()).toBe(sql);
    expect(parsed(draft).name).toBe('revenue_by_location');
  });

  it('never drops typed SQL when the draft is mid-edit and not a readable block', () => {
    const broken = NEW_BLOCK.replace('block "revenue_by_location" {', 'blok "revenue_by_location" {');
    expect(setBlockQuery(broken, 'SELECT 2 AS value')).toContain('SELECT 2 AS value');
  });

  it('renames and tags a block that opens with the header', () => {
    let draft = setBlockName(NEW_BLOCK, 'Revenue by location');
    draft = setBlockTags(draft, ['stores']);
    expect(draft.startsWith('// dql-format: 1\n\nblock "Revenue by location" {')).toBe(true);
    expect(parsed(draft)).toMatchObject({ name: 'Revenue by location', tags: ['stores'] });
  });
});
