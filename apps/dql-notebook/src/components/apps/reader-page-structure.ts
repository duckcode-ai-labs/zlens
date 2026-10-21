/**
 * What a reader's page is made of, top to bottom (D6). The published App and
 * App Studio's Preview both lay a page out from this one list, so Preview
 * shows exactly what readers will see: the Ask box, the trust line, the
 * Summary only when the author added it, then the tiles.
 */
export type ReaderPagePart = 'ask' | 'trust' | 'summary' | 'tiles';

/**
 * The auto-written Summary is off unless the page's author added it. New and
 * existing pages without `metadata.summary` never show it.
 */
export function pageShowsSummary(metadata: { summary?: boolean } | undefined | null): boolean {
  return metadata?.summary === true;
}

export function readerPageParts(input: {
  /** The page's author added the Summary (`metadata.summary`). */
  summary: boolean;
  /** At least one data tile: the trust line counts data tiles. */
  hasDataTiles: boolean;
  /** Readers may ask about the App (no read-only link, host allows Ask). */
  mayAsk: boolean;
}): ReaderPagePart[] {
  const parts: ReaderPagePart[] = [];
  if (input.mayAsk) parts.push('ask');
  if (input.hasDataTiles) parts.push('trust');
  if (input.summary) parts.push('summary');
  parts.push('tiles');
  return parts;
}

/** The words for the Summary option an author adds to a page. */
export const SUMMARY_OPTION = {
  label: 'Summary',
  hint: 'Auto-written from the numbers on this page',
  added: 'Summary added · readers see it above the tiles',
  removed: 'Summary removed',
} as const;
