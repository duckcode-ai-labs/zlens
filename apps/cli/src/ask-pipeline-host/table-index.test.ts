import { describe, expect, it } from 'vitest';
import { parseTablePicks, tableIndexLine, tableIndexLines, tableIndexMessages, TABLE_INDEX_PICKS } from './table-index.js';

describe('the table index', () => {
  it('says what a table holds, and its columns when nothing does', () => {
    expect(tableIndexLine({ name: 'sales.lines', description: 'AI draft: One row per invoice line. Also called: revenue lines.', columns: ['a'] })).toBe('- sales.lines: One row per invoice line. Also called: revenue lines.');
    expect(tableIndexLine({ name: 'sales.lines', columns: ['price', 'tax'] })).toBe('- sales.lines: columns: price, tax');
  });

  it('keeps each table to one line', () => {
    const line = tableIndexLine({ name: 't', description: `one\n\ntwo ${'x'.repeat(400)}`, columns: [] });
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(160);
  });

  it('past the budget, keeps the tables search ranked first', () => {
    const relations = Array.from({ length: 10 }, (_, index) => ({ name: `s.t${index}`, columns: ['a'] }));
    const lines = tableIndexLines(relations, ['s.t7', 's.t3'], 60);
    expect(lines.slice(0, 2)).toEqual(['- s.t7: columns: a', '- s.t3: columns: a']);
    expect(lines.join('\n').length).toBeLessThanOrEqual(60);
  });

  it('reads the tables a reply names, among those offered, as the index spells them', () => {
    expect(parseTablePicks('Sure: {"tables":["SALES.Lines","sales.imagined"," sales.orders "]}', ['sales.lines', 'sales.orders'])).toEqual(['sales.lines', 'sales.orders']);
  });

  it('a reply it cannot read chooses nothing', () => {
    expect(parseTablePicks('no json here', ['a.b'])).toEqual([]);
    expect(parseTablePicks('{"tables": "a.b"}', ['a.b'])).toEqual([]);
    expect(parseTablePicks('{broken', ['a.b'])).toEqual([]);
  });

  it('never takes more than the limit, and no table twice', () => {
    const offered = Array.from({ length: 20 }, (_, index) => `s.t${index}`);
    expect(parseTablePicks(JSON.stringify({ tables: [...offered, ...offered] }), offered)).toHaveLength(TABLE_INDEX_PICKS);
  });

  it('the question and the lines reach the model, in that order', () => {
    const [system, user] = tableIndexMessages('What was revenue?', ['- sales.lines: x']);
    expect(system!.content).toContain('at most 8 tables');
    expect(user!.content).toBe('QUESTION: What was revenue?\n\nTABLES:\n- sales.lines: x');
  });
});
