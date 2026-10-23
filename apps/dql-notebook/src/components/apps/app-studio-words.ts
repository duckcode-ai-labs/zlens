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

/** What App Studio says when the App changed in another tab (F11). */
export const CHANGED_IN_ANOTHER_TAB = 'This App changed in another tab. Refresh to review the latest version.';

export interface StudioErrorWords {
  /** One plain sentence a person can act on. */
  message: string;
  /** The server's own words, code and all: shown only under Technical details. */
  technical?: string;
  /** Offer Refresh: the draft on screen is older than the saved one. */
  refresh?: boolean;
}

const STUDIO_ERROR_WORDS: Array<[RegExp, Omit<StudioErrorWords, 'technical'>]> = [
  [/APP_BUILD_(?:REVISION|PROPOSAL|PREVIEW_RECEIPT)_CONFLICT/, { message: CHANGED_IN_ANOTHER_TAB, refresh: true }],
  [/APP_BUILD_PAGE_NOT_FOUND/, { message: 'That page is not in this App any more. Refresh to see the latest version.', refresh: true }],
  [/APP_BUILD_(?:DATASET_)?SOURCE_DRIFT/, { message: 'Some data in this App changed since it was added. Refresh its data, then run the page again.' }],
  [/APP_BUILD_DATASET_SOURCE_REPAIR_REQUIRED/, { message: 'Some data in this App needs fixing before it can run. Open the App’s data to fix or replace it.' }],
  [/APP_BUILD_DATASET_RETIRED/, { message: 'Some data in this App is no longer available. Replace it with current data.' }],
  [/APP_BUILD_DATASET_(?:SOURCE_)?AUTHORITY_(?:UNAVAILABLE|STALE)/, { message: 'ZLens could not read the project’s current data just now. Try again in a moment.' }],
  [/APP_BUILD_PREVIEW_(?:RECEIPT_(?:INVALID|REJECTED)|UNVERIFIABLE)/, { message: 'The last run no longer matches the page. Run the page again.' }],
  [/APP_BUILD_NOT_READY/, { message: 'This App is not ready to publish yet. Run the page, then review it again.' }],
  [/APP_BUILD_(?:SOURCE|PAGE)_LIMIT/, { message: 'This App has reached the most it can hold at once. Remove something first.' }],
  [/APP_BUILD_PROPOSAL_NOT_FOUND/, { message: 'That AI suggestion is no longer available. Ask for a new one.' }],
  [/APP_BUILD_(?:SOURCE|TILE)_NOT_IN_PROPOSAL/, { message: 'That AI suggestion changed. Review it again before adding it.' }],
];

/**
 * An error App Studio shows, in plain words (F11): a known `APP_BUILD_*`
 * code becomes a sentence, with Refresh when the draft on screen is older
 * than the saved one. Any other `CODE: text` keeps its text and moves the
 * code under Technical details. Text without a code is shown as it is.
 */
export function studioErrorWords(raw: string): StudioErrorWords {
  const text = raw.trim();
  for (const [pattern, words] of STUDIO_ERROR_WORDS) {
    if (pattern.test(text)) return { ...words, technical: text };
  }
  const coded = text.match(/^(.*?)\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):\s*(.+)$/s);
  if (coded) {
    const lead = coded[1]!.trim();
    const rest = coded[3]!.trim();
    const sentence = rest.charAt(0).toUpperCase() + rest.slice(1);
    return { message: [lead, /[.!?]$/.test(sentence) ? sentence : `${sentence}.`].filter(Boolean).join(' '), technical: text };
  }
  return { message: text };
}
