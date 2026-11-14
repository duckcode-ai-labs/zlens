import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { themes } from '../../themes/notebook-theme';
import { draftNameFromPath, pickableBlocks, savedQueryNameFromQuestion } from '../blocks/block-types';
import { ClearAskDrafts, clearAskDraftsPrompt } from './BuildSidebar';

describe('automatic Ask drafts in the notebook', () => {
  it('pickers leave out the drafts Ask saved on its own', () => {
    const blocks = [
      { name: 'lakers_top_rebounders', automaticDraft: undefined },
      { name: 'about_2009', automaticDraft: true },
      { name: 'my_edited_draft', automaticDraft: false },
    ];
    expect(pickableBlocks(blocks).map((block) => block.name)).toEqual(['lakers_top_rebounders', 'my_edited_draft']);
  });

  it('names a draft by its whole name, not its path', () => {
    expect(draftNameFromPath('domains/nba/blocks/_drafts/how_many_points_lebron_james_score_2012_playoffs.dql')).toBe('how_many_points_lebron_james_score_2012_playoffs');
  });

  it('names a saved answer from its question, cut only between words', () => {
    expect(savedQueryNameFromQuestion('How many regular season games did the Golden State Warriors win in 2016?')).toBe('how_many_regular_season_games_did_the_golden_state_warriors_win');
    expect(savedQueryNameFromQuestion('2016 playoff scorers')).toBe('q_2016_playoff_scorers');
    expect(savedQueryNameFromQuestion('??')).toBe('saved_answer');
  });

  it('"Clear drafts" asks once, saying what goes and what stays', () => {
    expect(clearAskDraftsPrompt(29)).toBe('Remove 29 automatic drafts? Saved queries you edited or certified stay.');
    expect(clearAskDraftsPrompt(1)).toBe('Remove 1 automatic draft? Saved queries you edited or certified stay.');
    const idle = renderToStaticMarkup(createElement(ClearAskDrafts, { count: 29, onCleared: () => undefined, t: themes.light }));
    expect(idle).toContain('29 automatic drafts from Ask');
    expect(idle).toContain('Clear drafts');
    expect(idle).not.toContain('Remove 29');
    const confirming = renderToStaticMarkup(createElement(ClearAskDrafts, { count: 29, onCleared: () => undefined, t: themes.light, initialStep: 'confirm' }));
    expect(confirming).toContain('Remove 29 automatic drafts? Saved queries you edited or certified stay.');
    expect(confirming).toContain('>Remove<');
    expect(confirming).toContain('>Cancel<');
  });
});
