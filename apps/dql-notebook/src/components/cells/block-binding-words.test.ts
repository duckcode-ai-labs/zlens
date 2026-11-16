import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCK_BINDING_WORDS, boundQueryName } from './block-binding-words';

describe('a cell bound to a saved query, in plain words (V3 tester retest)', () => {
  it('shows the saved query by its name, not its file path', () => {
    const path = 'domains/nba/blocks/who_were_the_lakers_top_3_rebounders_in_the_2009.dql';
    expect(boundQueryName({ path, originalContent: '@block("who_were_the_lakers_top_3_rebounders_in_the_2009")' })).toBe('who_were_the_lakers_top_3_rebounders_in_the_2009');
    expect(boundQueryName({ path, originalContent: '@block("Lakers rebounders, 2009")' })).toBe('Lakers rebounders, 2009');
    // A cell bound before the reference was kept, or holding something else: the file's name, without folders or .dql.
    expect(boundQueryName({ path })).toBe('who_were_the_lakers_top_3_rebounders_in_the_2009');
    expect(boundQueryName({ path: 'blocks\\_drafts\\how_many_teams.dql', originalContent: 'SELECT 1' })).toBe('how_many_teams');
    expect(boundQueryName({ path, originalContent: '@block("")' })).toBe('who_were_the_lakers_top_3_rebounders_in_the_2009');
  });

  it('says what editing does without "fork" or "local"', () => {
    for (const words of Object.values(BLOCK_BINDING_WORDS)) {
      expect(words).not.toMatch(/fork|local|diverge|mirror|promote/i);
    }
    expect(BLOCK_BINDING_WORDS.boundHelp).toContain('Editing makes your own copy');
    // The cell's strip reads only these words: no tooltip of its own, and the name in place of the path.
    const cell = readFileSync(join(__dirname, 'Cell.tsx'), 'utf8');
    const strip = cell.slice(cell.indexOf('function BlockBindingChip('), cell.indexOf('function binderBtnStyle('));
    expect(strip).not.toMatch(/fork locally|edits fork|local copy|'FORKED'|\{binding\.path\}/);
    expect(strip).toContain('{boundQueryName(binding)}');
    expect(strip.match(/title=\{BLOCK_BINDING_WORDS\.\w+\}/g)).toHaveLength(4);
  });
});
