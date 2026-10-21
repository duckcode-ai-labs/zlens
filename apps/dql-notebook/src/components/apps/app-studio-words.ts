/**
 * Plain words for App Studio's status line and the Apps cards (D6). One place,
 * so the editor, the cards and the docs say the same thing.
 */

/** A draft nobody else can see yet: replaces "Safe local edit draft" / "LOCAL DRAFT · Not in Project source". */
export const UNPUBLISHED_CHANGES = 'Unpublished changes (only you can see them)';

/** After a save: still a draft until it is published. */
export const SAVED_UNPUBLISHED = 'Saved · only you can see it until you publish';

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
