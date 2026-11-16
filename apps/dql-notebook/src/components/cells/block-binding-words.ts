/**
 * What a notebook cell bound to a saved query says, in plain words: the saved query's name (not its file
 * path), and what editing does, without "fork" or "local" (V3 tester retest: "Edit to fork locally.",
 * ".../nba/blocks/who_were_the_lakers_top_3_rebounders_in_the_2009.dql").
 */
import type { BlockBinding } from '../../store/types';
import { draftNameFromPath } from '../blocks/block-types';

/**
 * The saved query's name: the one the cell refers to (`@block("name")`, written when it was bound), or its
 * file's name when the cell holds none.
 */
export function boundQueryName(binding: Pick<BlockBinding, 'path' | 'originalContent'>): string {
  const reference = /^\s*@block\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*$/.exec(binding.originalContent ?? '')?.[1];
  if (reference) {
    try {
      const name = JSON.parse(reference) as unknown;
      if (typeof name === 'string' && name.trim()) return name.trim();
    } catch {
      // Not a JSON string: fall back to the file's name.
    }
  }
  return draftNameFromPath(binding.path.replace(/\\/g, '/'));
}

/** The words of a bound cell's strip: its label, what it means, and what its buttons do. */
export const BLOCK_BINDING_WORDS = {
  boundLabel: 'SAVED QUERY',
  editedLabel: 'EDITED',
  boundHelp: 'This cell shows the saved query as it is saved. Editing makes your own copy in this notebook; the saved query does not change.',
  editedHelp: 'You edited this cell, so it is your own copy: the saved query has not changed. Revert to show the saved query again, or save your copy as a saved query.',
  lockTitle: 'Shows the saved query as it is saved. Editing makes your own copy.',
  revertTitle: 'Discard your edits and show the saved query again',
  customizeTitle: 'Put the saved query\'s source in this cell so you can edit your own copy. The saved query does not change.',
  unbindTitle: 'Keep this cell as it is, no longer tied to the saved query',
} as const;
