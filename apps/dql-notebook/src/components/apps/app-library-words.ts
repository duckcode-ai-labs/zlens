import type { AppStudioBuildDraft } from '../../api/client';

/** Which Apps the library shows. */
export type LibraryFilter = 'all' | 'drafts' | 'private' | 'shared' | 'fav';

const FILTER_LABELS: Record<LibraryFilter, string> = {
  all: 'All',
  drafts: 'Not published yet',
  private: 'Private',
  shared: 'Shared',
  fav: 'Favourites',
};

/**
 * The App library's words. A reader under a host (RFC 0010 HH-9 `audience: 'reader'`) reads Apps shared with them
 * and drafts nothing here, so the single-user notebook's words (local drafts, private, local files) are left out.
 */
export function appLibraryWords(reader: boolean): {
  intro: string;
  filters: LibraryFilter[];
  label: (filter: LibraryFilter) => string;
  localCounts: boolean;
  loadingDetail: string;
  emptyDetail: string;
  appNote: (app: { name: string; domain?: string }) => string;
} {
  if (!reader) {
    return {
      intro: 'Your Apps, published or not. Only you can see an App until you publish it.',
      filters: ['all', 'drafts', 'private', 'shared', 'fav'],
      label: (filter) => FILTER_LABELS[filter],
      localCounts: true,
      loadingDetail: 'Reading local app files from this ZLens project.',
      emptyDetail: 'Change the filter or start a new App above. A new App stays visible only to you until you publish it.',
      appNote: (app) => `${app.name} consumption surface for ${app.domain}.`,
    };
  }
  return {
    intro: 'The Apps shared with you, each with how far its figures can be trusted.',
    filters: ['all', 'shared', 'fav'],
    label: (filter) => (filter === 'shared' ? 'Shared Apps' : FILTER_LABELS[filter]),
    localCounts: false,
    loadingDetail: 'Getting the Apps shared with you.',
    emptyDetail: 'Change the filter. An App you need but cannot see: ask its owner to share it with you.',
    appNote: (app) => (app.domain ? `An App for ${app.domain}.` : ''),
  };
}

/**
 * The library's draft list with this draft in it, newest first (round 3):
 * Back to Apps lists the App just built before the list is read again. A
 * draft already listed is replaced; a published draft is not added.
 */
export function withDraftListed<T extends { ok: true; drafts: AppStudioBuildDraft[] }>(
  current: T | undefined,
  draft: AppStudioBuildDraft,
): T | { ok: true; drafts: AppStudioBuildDraft[] } {
  const drafts = (current?.drafts ?? []).filter((item) => item.id !== draft.id);
  if (draft.state === 'project_published') return current ?? { ok: true, drafts };
  return { ...(current ?? { ok: true as const }), drafts: [draft, ...drafts] };
}
