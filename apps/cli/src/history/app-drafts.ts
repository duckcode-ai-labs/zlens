import { parseDashboardDocument, type AppBuildDraft } from '@zlens/core';

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
  /** A kept App Studio draft, or the published App's files. */
  form: 'draft' | 'published';
  name?: string;
  pages: number;
  tiles: number;
  /** The pages and tiles as people see them (appPagesKey), the same for a draft and the published App. */
  content: string;
  settings: string;
}

/** Bookkeeping a page or tile carries that is not what anyone made: publishing and reading sources set it. */
const PAGE_BOOKKEEPING = new Set(['version']);
const METADATA_BOOKKEEPING = new Set(['visibility', 'lifecycle']);
const TILE_BOOKKEEPING = new Set(['sourceId', 'sourceRevision']);

function canonical(value: unknown, drop?: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined || drop?.has(key)) continue;
    out[key] = canonical(item);
  }
  return out;
}

/**
 * An App's pages as people see them, comparable between a draft and the published App (V2): page by page (by id),
 * without what publishing adds (page version, visibility, lifecycle) or what opening the App for edit adds to a
 * tile (its source id and revision, read again from the catalog).
 */
export function appPagesKey(pages: unknown[]): string {
  const normal = pages
    .filter((page): page is Record<string, unknown> => Boolean(page) && typeof page === 'object')
    .map((page) => {
      const layout = (page.layout ?? {}) as Record<string, unknown>;
      const strip = (items: unknown) => (Array.isArray(items) ? items.map((item) => canonical(item, TILE_BOOKKEEPING)) : items);
      const responsive = layout.responsive && typeof layout.responsive === 'object'
        ? Object.fromEntries(Object.entries(layout.responsive as Record<string, Record<string, unknown> | undefined>).map(([size, grid]) => [size, grid ? { ...grid, items: strip(grid.items) } : grid]))
        : layout.responsive;
      return canonical({
        ...page,
        metadata: canonical(page.metadata, METADATA_BOOKKEEPING),
        layout: { ...layout, items: strip(layout.items), ...(responsive ? { responsive } : {}) },
      }, PAGE_BOOKKEEPING) as Record<string, unknown>;
    })
    .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
  return JSON.stringify(normal);
}

export function appDraftShape(draft: AppDraftHistoryFile): AppVersionShape {
  return {
    form: 'draft',
    name: draft.name,
    pages: draft.pages.length,
    tiles: draft.pages.reduce((count, page) => count + (page?.layout?.items?.length ?? 0), 0),
    content: appPagesKey(draft.pages),
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
  // Read as App Studio reads them when the App is opened for edit (the dashboard parser), so the two compare.
  const pages: unknown[] = [];
  for (const text of pageTexts) {
    try {
      pages.push(parseDashboardDocument(text).document ?? JSON.parse(text));
    } catch {
      pages.push(text);
    }
  }
  const tiles = pages.reduce<number>((count, page) => count + (((page as { layout?: { items?: unknown[] } } | null)?.layout?.items?.length) ?? 0), 0);
  return { form: 'published', ...(name ? { name } : {}), pages: pageTexts.length, tiles, content: appPagesKey(pages), settings };
}

/** Whether a draft holds exactly what the published App holds (its name and pages): opening it for edit, no change. */
export function sameAsPublished(draft: AppVersionShape, published: AppVersionShape | null): boolean {
  return Boolean(published) && draft.name === published!.name && draft.content === published!.content;
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
  // Settings compare only between two drafts or two published versions (they are kept differently).
  if (!parts.length && before.form === after.form && before.settings !== after.settings) parts.push('App settings or data changed');
  return parts.length ? parts.join(', ') : undefined;
}
