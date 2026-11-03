import { describe, expect, it } from 'vitest';
import type { MeaningTableSummary, MeaningsOverview } from '../../api/client';
import { draftPlanLine, meaningGroups, sourceLabel } from './MeaningsPanel';

const plan: MeaningsOverview['plan'] = { tables: 400, columns: 5200, calls: 34, alreadyDone: 0, overLimit: 0, estimatedInputTokens: 48000, estimatedOutputTokens: 154000, sendsSampleValues: false };
const table = (over: Partial<MeaningTableSummary>): MeaningTableSummary => ({ id: 'x', relation: 'sales.x', name: 'x', kind: 'table', state: 'needs_review', columns: 1, describedColumns: 1, drafts: 1, ...over });

describe('the draft card', () => {
  it('says what leaves the machine and what it costs before anyone chooses it', () => {
    const line = draftPlanLine(plan);
    expect(line).toContain('400 tables and 5,200 columns');
    expect(line).toContain('on your own AI provider');
    expect(line).toContain('48,000 tokens in');
    expect(line).toContain('Sends table names, column names, types and keys. No rows.');
  });

  it('says so when sample values go too', () => {
    expect(draftPlanLine({ ...plan, sendsSampleValues: true })).toContain('sample values from the value profile');
    expect(draftPlanLine({ ...plan, sendsSampleValues: true })).not.toContain('No rows');
  });

  it('reads right for one table', () => {
    expect(draftPlanLine({ ...plan, tables: 1, calls: 1 })).toContain('1 table and 5,200 columns, in 1 call');
  });
});

describe('review by domain', () => {
  it('groups by the domain that models a table, then by schema, domains first', () => {
    const groups = meaningGroups([
      table({ id: 'a', schema: 'website' }),
      table({ id: 'b', schema: 'sales', domain: 'zeta' }),
      table({ id: 'c', schema: 'application' }),
      table({ id: 'd', schema: 'sales', domain: 'zeta' }),
    ]);
    expect(groups.map((group) => [group.label, group.tables.length])).toEqual([['zeta', 2], ['application', 1], ['website', 1]]);
  });

  it('names who wrote a description', () => {
    expect(sourceLabel('ai')).toBe('AI draft');
    expect(sourceLabel('warehouse')).toBe('Warehouse comment');
    expect(sourceLabel('person')).toBe('A person');
    expect(sourceLabel(undefined)).toBeNull();
  });
});
