import { describe, expect, it } from 'vitest';
import { blockFolderLabel, blockRowMeta } from './block-library-tree';

describe('block library folder labels', () => {
  it('shows the reserved drafts folder as "Drafts" and every other folder as named', () => {
    expect(blockFolderLabel('_drafts')).toBe('Drafts');
    expect(blockFolderLabel('commerce')).toBe('commerce');
    expect(blockFolderLabel('order_item')).toBe('order_item');
  });
});

describe('the line under a saved query name (V3 tester retest)', () => {
  it('an Ask draft reads "Drafts" once, never "_drafts · draft"', () => {
    expect(blockRowMeta('_drafts', 'draft')).toBe('Drafts');
    expect(blockRowMeta('_drafts', 'certification proposed')).toBe('Drafts · certification proposed');
    expect(blockRowMeta('nba', 'draft')).toBe('nba · draft');
    expect(blockRowMeta('nba', 'deprecated', 'team_wins_v2')).toBe('nba · deprecated · replaced by team_wins_v2');
    expect(blockRowMeta(undefined, 'certified')).toBe('certified');
  });
});
