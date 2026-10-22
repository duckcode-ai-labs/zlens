/**
 * Plain words for App Studio's status line and the Apps cards (D6). One place,
 * so the editor, the cards and the docs say the same thing.
 */

/** A draft nobody else can see yet: replaces "Safe local edit draft" / "LOCAL DRAFT · Not in Project source". */
export const UNPUBLISHED_CHANGES = 'Unpublished changes (only you can see them)';

/** A new App nobody else can see yet (round 3): one wording for it everywhere. */
export const NOT_PUBLISHED_YET = 'Not published yet';

/** The Studio header for a new App: "Not published yet (only you can see it)". */
export const NOT_PUBLISHED_YET_ONLY_YOU = `${NOT_PUBLISHED_YET} (only you can see it)`;

/** Opening a published App to edit, before anything changed: readers still see it as published. */
export const NO_UNPUBLISHED_CHANGES = 'No changes yet · readers see the published App';

/**
 * The Studio header for a draft: a published App's draft has "Unpublished
 * changes (only you can see them)", a new App is "Not published yet (only you
 * can see it)"; after a save, the same words after "Saved · ".
 */
export function draftStatusWords(input: { published: boolean; saved?: boolean }): string {
  const words = input.published ? UNPUBLISHED_CHANGES : NOT_PUBLISHED_YET_ONLY_YOU;
  return input.saved ? `Saved · ${words}` : words;
}

/** After a page run: "All tiles up to date", or how many are. Replaces "Preview settled · 3/3 ready". */
export function previewSettledWords(ready: number, total: number): string {
  if (total === 0) return 'Up to date';
  if (ready >= total) return 'All tiles up to date';
  return `${ready} of ${total} tiles up to date`;
}

/** A tile's row count: "12 rows" (replaces "Settled on 12 rows"). */
export function rowCountWords(rows: number): string {
  return `${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}`;
}
