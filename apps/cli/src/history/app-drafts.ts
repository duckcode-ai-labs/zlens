import type { AppBuildDraft } from '@zlens/core';

/**
 * WHAT HISTORY KEEPS OF AN APP STUDIO DRAFT (V2).
 *
 * App Studio keeps an App as a draft in ZLens's local store until it is published (tracked-files.ts,
 * APP_STUDIO_DRAFT_FILE). History keeps the draft as one JSON file of the App: what the person made (the name, the
 * pages and their tiles, the data and the plan), never the bookkeeping that changes on every preview run (revision,
 * receipts, timestamps). A preview run is then no version; adding a tile, renaming or deleting the App is one.
 */
export const APP_DRAFT_FILE_KIND = 'zlens-app-studio-draft';

/** The App Studio draft as History keeps it. */
export interface AppDraftHistoryFile {
  kind: typeof APP_DRAFT_FILE_KIND;
  format: 1;
  draftId: string;
  appId: string;
  name: string;
  /** The published App this draft edits, when it is an edit of one. */
  baseAppId?: string;
  authoringMode: AppBuildDraft['authoringMode'];
  template: AppBuildDraft['template'];
  frame: AppBuildDraft['frame'];
  requirements: AppBuildDraft['requirements'];
  coverage: AppBuildDraft['coverage'];
  sources: AppBuildDraft['sources'];
  pages: AppBuildDraft['pages'];
  reviewTasks: AppBuildDraft['reviewTasks'];
}

/** The file History keeps for a draft: stable JSON, so the same App is the same content. */
export function appDraftHistoryText(draft: AppBuildDraft): string {
  const kept: AppDraftHistoryFile = {
    kind: APP_DRAFT_FILE_KIND,
    format: 1,
    draftId: draft.id,
    appId: draft.appId,
    name: draft.name,
    ...(draft.baseApp?.appId ? { baseAppId: draft.baseApp.appId } : {}),
    authoringMode: draft.authoringMode,
    template: draft.template,
    frame: draft.frame,
    requirements: draft.requirements ?? [],
    coverage: draft.coverage ?? [],
    sources: draft.sources ?? [],
    pages: draft.pages ?? [],
    reviewTasks: draft.reviewTasks ?? [],
  };
  return `${JSON.stringify(kept, null, 2)}\n`;
}

/** Reads a kept draft back; null when the text is not one. */
export function parseAppDraftHistoryText(text: string | null | undefined): AppDraftHistoryFile | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<AppDraftHistoryFile>;
    if (parsed?.kind !== APP_DRAFT_FILE_KIND || !Array.isArray(parsed.pages) || typeof parsed.appId !== 'string') return null;
    return parsed as AppDraftHistoryFile;
  } catch {
    return null;
  }
}

/** What an App holds in one version, read from its files: its name, and how many pages and tiles. */
export interface AppVersionShape {
  name?: string;
  pages: number;
  tiles: number;
  /** The pages and tiles as text, to tell a layout change from no change. */
  content: string;
  settings: string;
}

export function appDraftShape(draft: AppDraftHistoryFile): AppVersionShape {
  return {
    name: draft.name,
    pages: draft.pages.length,
    tiles: draft.pages.reduce((count, page) => count + (page?.layout?.items?.length ?? 0), 0),
    content: JSON.stringify(draft.pages),
    settings: JSON.stringify([draft.frame, draft.sources, draft.requirements, draft.template]),
  };
}

/** A published App's shape: its `dql.app.json` and its pages (`dashboards/*.dqld`). */
export function publishedAppShape(appText: string | null, pageTexts: string[]): AppVersionShape | null {
  if (appText === null) return null;
  let name: string | undefined;
  let settings = appText;
  try {
    const app = JSON.parse(appText) as { name?: unknown; title?: unknown; metadata?: { title?: unknown } };
    const found = [app.name, app.title, app.metadata?.title].find((value) => typeof value === 'string' && value.trim());
    name = typeof found === 'string' ? found.trim() : undefined;
    settings = JSON.stringify({ ...app, name: undefined, title: undefined });
  } catch {
    // Not JSON: the name comes from elsewhere.
  }
  let tiles = 0;
  for (const text of pageTexts) {
    try {
      tiles += (JSON.parse(text) as { layout?: { items?: unknown[] } })?.layout?.items?.length ?? 0;
    } catch {
      // A page that does not read counts no tiles.
    }
  }
  return { ...(name ? { name } : {}), pages: pageTexts.length, tiles, content: pageTexts.join('\n'), settings };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One line about what changed between two shapes of an App: "Added 1 tile", "Removed a page", "Tiles changed". */
export function appEditWords(before: AppVersionShape | null, after: AppVersionShape | null): string | undefined {
  if (!before || !after) return undefined;
  const parts: string[] = [];
  if (after.pages > before.pages) parts.push(`Added ${after.pages - before.pages === 1 ? 'a page' : plural(after.pages - before.pages, 'page')}`);
  if (after.pages < before.pages) parts.push(`Removed ${before.pages - after.pages === 1 ? 'a page' : plural(before.pages - after.pages, 'page')}`);
  if (after.tiles > before.tiles) parts.push(`Added ${plural(after.tiles - before.tiles, 'tile')}`);
  if (after.tiles < before.tiles) parts.push(`Removed ${plural(before.tiles - after.tiles, 'tile')}`);
  if (!parts.length && before.content !== after.content) parts.push('Tiles or layout changed');
  if (!parts.length && before.settings !== after.settings) parts.push('App settings or data changed');
  return parts.length ? parts.join(', ') : undefined;
}
