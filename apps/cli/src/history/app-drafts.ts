import { parseDashboardDocument, type AppBuildDraft } from '@zlens/core';
import { APP_STUDIO_DRAFT_FILE } from './tracked-files.js';

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

/** A piece of data an App reads, as people name it ("Wins by season"). */
export interface AppVersionSource {
  id: string;
  label: string;
}

/** What an App holds in one version, read from its files: its name, and how many pages and tiles. */
export interface AppVersionShape {
  /** A kept App Studio draft, or the published App's files. */
  form: 'draft' | 'published';
  name?: string;
  /** What the App is for: the published App's description, or the goal a draft was made for. */
  description?: string;
  pages: number;
  tiles: number;
  /** The pages and tiles as people see them (appPagesKey), the same for a draft and the published App. */
  content: string;
  settings: string;
  /** The pages as `content` holds them, page by page (`normalAppPages`). */
  pageList: Array<Record<string, unknown>>;
  /** The App's data: a draft's own list, or what a published App's tiles read. */
  sources: AppVersionSource[];
  /** What the tiles read, as people name it: how a draft and a published App are compared (`sources` differ). */
  tileData: AppVersionSource[];
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
export function normalAppPages(pages: unknown[]): Array<Record<string, unknown>> {
  return pages
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
}

export function appPagesKey(pages: unknown[]): string {
  return JSON.stringify(normalAppPages(pages));
}

/** "wins_by_season" → "Wins by season". */
function words(value: string): string {
  const said = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return said ? `${said[0]!.toUpperCase()}${said.slice(1)}` : value;
}

/** A draft's source as people name it: its saved query, table or Metrics name, never its path or id. */
function draftSourceLabel(source: { id?: unknown; sourceRef?: unknown; qualifiedIdentity?: unknown }): string {
  const identity = typeof source.qualifiedIdentity === 'string' ? source.qualifiedIdentity.split('::')[2] : undefined;
  const ref = typeof source.sourceRef === 'string' ? source.sourceRef.split('/').pop()?.replace(/\.dql$/i, '') : undefined;
  return words(identity || ref || refLabel(String(source.id ?? '')) || 'Data');
}

/** The last part of a source id or path ("app:block:nba:wins" → "wins", "blocks/nba/wins.dql" → "wins"). */
function refLabel(ref: string): string {
  return ref.split(/[/:]/).filter(Boolean).pop()?.replace(/\.(dql|ya?ml|sql)$/i, '') ?? '';
}

/**
 * What the tiles read, as people name it, from the pages as saved (before `normalAppPages` drops their source ids).
 * Told apart by that name: a published App's tile names its saved query by path, the same tile opened for edit by
 * its catalog id.
 */
function tileSources(pages: unknown[]): AppVersionSource[] {
  const found = new Map<string, AppVersionSource>();
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    for (const tile of tilesOfPage(page as Record<string, unknown>)) {
      const block = (tile.block as { ref?: unknown; blockId?: unknown } | undefined);
      const ref = [block?.ref, block?.blockId, tile.sourceId].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
      const label = ref ? words(refLabel(ref)) : tile.semantic ? 'Metrics' : '';
      if (!label || found.has(label.toLowerCase())) continue;
      found.set(label.toLowerCase(), { id: label.toLowerCase(), label });
    }
  }
  return [...found.values()];
}

function tilesOfPage(page: Record<string, unknown>): Array<Record<string, unknown>> {
  const items = (page.layout as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

export function appDraftShape(draft: AppDraftHistoryFile): AppVersionShape {
  const pageList = normalAppPages(draft.pages);
  return {
    form: 'draft',
    name: draft.name,
    ...(draft.frame?.goal ? { description: draft.frame.goal } : {}),
    pages: draft.pages.length,
    tiles: draft.pages.reduce((count, page) => count + (page?.layout?.items?.length ?? 0), 0),
    content: JSON.stringify(pageList),
    settings: JSON.stringify([draft.frame, draft.sources, draft.requirements, draft.template]),
    pageList,
    sources: (draft.sources ?? []).map((source) => ({ id: source.id, label: draftSourceLabel(source) })),
    tileData: tileSources(draft.pages),
  };
}

/** A published App's shape: its `dql.app.json` and its pages (`dashboards/*.dqld`). */
export function publishedAppShape(appText: string | null, pageTexts: string[]): AppVersionShape | null {
  if (appText === null) return null;
  let name: string | undefined;
  let description: string | undefined;
  let settings = appText;
  try {
    const app = JSON.parse(appText) as { name?: unknown; title?: unknown; description?: unknown; metadata?: { title?: unknown } };
    const found = [app.name, app.title, app.metadata?.title].find((value) => typeof value === 'string' && value.trim());
    name = typeof found === 'string' ? found.trim() : undefined;
    description = typeof app.description === 'string' && app.description.trim() ? app.description.trim() : undefined;
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
  const pageList = normalAppPages(pages);
  return {
    form: 'published',
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    pages: pageTexts.length,
    tiles,
    content: JSON.stringify(pageList),
    settings,
    pageList,
    sources: tileSources(pages),
    tileData: tileSources(pages),
  };
}

/**
 * An App as one version holds it, from that version's files (paths inside the App's folder): its App Studio draft
 * when it has one (what App Studio shows), else its published files. Null when the version holds neither.
 */
export function appVersionShape(files: ReadonlyMap<string, string>): AppVersionShape | null {
  const draft = parseAppDraftHistoryText(files.get(APP_STUDIO_DRAFT_FILE));
  if (draft) return appDraftShape(draft);
  const pages = [...files.keys()].filter((path) => /^dashboards\/[^/]+\.dqld$/.test(path)).sort().map((path) => files.get(path) ?? '');
  return publishedAppShape(files.get('dql.app.json') ?? null, pages);
}

/** Whether a draft holds exactly what the published App holds (its name and pages): opening it for edit, no change. */
export function sameAsPublished(draft: AppVersionShape, published: AppVersionShape | null): boolean {
  return Boolean(published) && draft.name === published!.name && draft.content === published!.content;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One change to an App between two versions, in plain words. */
export interface AppChange {
  kind: 'name' | 'description' | 'page' | 'tile' | 'text' | 'layout' | 'filters' | 'data' | 'settings';
  text: string;
}

const MAX_LABEL = 60;
const TILE_PLACE = new Set(['x', 'y', 'w', 'h']);
const TILE_DATA = new Set(['query', 'block', 'semantic', 'draftAnalysis', 'aiPin', 'driver', 'sourceClass']);
const TILE_FILTERS = new Set(['filterBindings', 'parameterBindings']);
/** What a page carries that follows its tiles (bindings, the story's tile list): not a change of its own. */
const PAGE_FOLLOWS_TILES = new Set(['datasets', 'story', 'sections']);

const quoted = (label: string) => `"${label}"`;

function clipLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1).trimEnd()}…` : flat;
}

/** A text tile's first line, without markdown marks ("## Overview" → "Overview"). */
function firstTextLine(markdown: unknown): string {
  if (typeof markdown !== 'string') return '';
  const line = markdown.split('\n').map((part) => part.replace(/^#{1,6}\s+/, '').replace(/[*_`>]/g, '').trim()).find(Boolean) ?? '';
  return clipLabel(line);
}

const VIZ_WORDS: Record<string, string> = {
  kpi: 'KPI', single_value: 'KPI', bar: 'bar chart', line: 'line chart', area: 'area chart', pie: 'pie chart', donut: 'pie chart',
  table: 'table', pivot: 'pivot table', scatter: 'scatter chart', text: 'text',
};

/** A tile as people name it: its title, else its text's first line, else what it shows. */
export function appTileLabel(tile: Record<string, unknown>): string {
  if (typeof tile.title === 'string' && tile.title.trim()) return clipLabel(tile.title);
  const text = firstTextLine((tile.text as { markdown?: unknown } | undefined)?.markdown);
  if (text) return text;
  const viz = (tile.viz as { type?: unknown } | undefined)?.type;
  const shows = typeof viz === 'string' ? VIZ_WORDS[viz] ?? words(viz).toLowerCase() : 'tile';
  return `a ${shows} tile`;
}

function pageLabel(page: Record<string, unknown> | undefined): string {
  const title = (page?.metadata as { title?: unknown } | undefined)?.title;
  return typeof title === 'string' && title.trim() ? clipLabel(title) : words(String(page?.id ?? 'page'));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function without(record: Record<string, unknown>, keys: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)));
}

function listWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** A tile as History tells it apart across versions: its page's id and its own. */
const tileKey = (pageId: unknown, tileId: unknown) => `${String(pageId ?? '')}/${String(tileId ?? '')}`;

/** The tiles a version added (page id and tile id), so the next version can tell the new tile's placing from a move. */
export function appTilesAdded(before: AppVersionShape | null, after: AppVersionShape | null): string[] {
  if (!after) return [];
  const had = new Set((before?.pageList ?? []).flatMap((page) => tilesOfPage(page).map((tile) => tileKey(page.id, tile.i))));
  return after.pageList.flatMap((page) => tilesOfPage(page).map((tile) => tileKey(page.id, tile.i))).filter((key) => !had.has(key));
}

/** What History knows about the version before: the tiles it had just added (App Studio then places them). */
export interface AppChangeContext {
  justAdded?: ReadonlySet<string>;
}

/**
 * What changed in an App between two versions, in plain words, in the order people read an App: its name and
 * purpose, its pages, each page's tiles (added, removed, renamed, text, chart, data), the layout, and its data.
 * Tiles are told apart by their id, and named by their titles. Never paths, ids or fingerprints. A tile the version
 * before had just added, moved into its place by App Studio, is placed, not a layout change (V4 tester: "Layout
 * changed: 1 tile moved or resized" after adding a tile, with nothing moved).
 */
export function appChanges(before: AppVersionShape | null, after: AppVersionShape | null, context: AppChangeContext = {}): AppChange[] {
  if (!before || !after) return [];
  const changes: AppChange[] = [];
  if ((before.name ?? '') !== (after.name ?? '')) {
    changes.push({ kind: 'name', text: before.name && after.name ? `Name changed from ${quoted(before.name)} to ${quoted(after.name)}` : `Name changed to ${quoted(after.name ?? '')}` });
  }
  // A published App's description and a draft's goal are different things: compared only between two of a kind.
  if (before.form === after.form && (before.description ?? '') !== (after.description ?? '')) {
    changes.push({ kind: 'description', text: before.description ? (after.description ? 'Description changed' : 'Description removed') : 'Description added' });
  }
  const beforePages = new Map(before.pageList.map((page) => [String(page.id ?? ''), page]));
  const afterPages = new Map(after.pageList.map((page) => [String(page.id ?? ''), page]));
  const manyPages = after.pageList.length > 1 || before.pageList.length > 1;
  const onPage = (page: Record<string, unknown>) => (manyPages ? ` on ${quoted(pageLabel(page))}` : '');
  for (const [id, page] of afterPages) {
    if (!beforePages.has(id)) changes.push({ kind: 'page', text: `Page added: ${quoted(pageLabel(page))}${tilesOfPage(page).length ? ` (${plural(tilesOfPage(page).length, 'tile')})` : ''}` });
  }
  for (const [id, page] of beforePages) {
    if (!afterPages.has(id)) changes.push({ kind: 'page', text: `Page removed: ${quoted(pageLabel(page))}` });
  }
  let moved = 0;
  let layoutOnly = false;
  const placed: string[] = [];
  for (const [id, page] of afterPages) {
    const old = beforePages.get(id);
    if (!old) continue;
    if (pageLabel(old) !== pageLabel(page)) changes.push({ kind: 'page', text: `Page ${quoted(pageLabel(old))} renamed to ${quoted(pageLabel(page))}` });
    const oldTiles = new Map(tilesOfPage(old).map((tile) => [String(tile.i ?? ''), tile]));
    const newTiles = new Map(tilesOfPage(page).map((tile) => [String(tile.i ?? ''), tile]));
    let tilesCameOrWent = false;
    for (const [tileId, tile] of newTiles) {
      if (oldTiles.has(tileId)) continue;
      tilesCameOrWent = true;
      changes.push({ kind: 'tile', text: `Tile added: ${quoted(appTileLabel(tile))}${onPage(page)}` });
    }
    for (const [tileId, tile] of oldTiles) {
      if (newTiles.has(tileId)) continue;
      tilesCameOrWent = true;
      changes.push({ kind: 'tile', text: `Tile removed: ${quoted(appTileLabel(tile))}${onPage(page)}` });
    }
    let placedOnPage = false;
    for (const [tileId, tile] of newTiles) {
      const was = oldTiles.get(tileId);
      if (!was) continue;
      if (!same(without(was, new Set(['title', 'text', ...TILE_PLACE])), without(tile, new Set(['title', 'text', ...TILE_PLACE])))
        || !same(was.title, tile.title) || !same(was.text, tile.text)) {
        changes.push(...tileChanges(was, tile, onPage(page)));
      }
      if (!same([was.x, was.y, was.w, was.h], [tile.x, tile.y, tile.w, tile.h])) {
        // Placing keeps the new tile's size; a resize is the person's.
        if (context.justAdded?.has(tileKey(id, tileId)) && same([was.w, was.h], [tile.w, tile.h])) {
          placed.push(`${quoted(appTileLabel(tile))}${onPage(page)}`);
          placedOnPage = true;
        } else {
          moved += 1;
        }
      }
    }
    // Tiles that come or go, or a new tile put in its place, move the others in every screen size: that is not a
    // layout change of its own.
    if (!tilesCameOrWent && !placedOnPage && !same(gridOf(old), gridOf(page))) layoutOnly = true;
    const oldMeta = (old.metadata ?? {}) as Record<string, unknown>;
    const newMeta = (page.metadata ?? {}) as Record<string, unknown>;
    if (!same(oldMeta.description, newMeta.description)) changes.push({ kind: 'page', text: `Page ${quoted(pageLabel(page))}: description changed` });
    if (!same(old.filters, page.filters)) changes.push({ kind: 'filters', text: `Filters changed on ${quoted(pageLabel(page))}` });
    const pageRest = (record: Record<string, unknown>) => without(record, new Set(['id', 'layout', 'metadata', 'filters', ...(tilesCameOrWent ? PAGE_FOLLOWS_TILES : ['story'])]));
    const metaRest = (record: Record<string, unknown>) => without(record, new Set(['title', 'description']));
    if (!same(pageRest(old), pageRest(page)) || !same(metaRest(oldMeta), metaRest(newMeta))) {
      changes.push({ kind: 'settings', text: `Page ${quoted(pageLabel(page))}: settings changed` });
    }
  }
  if (moved) changes.push({ kind: 'layout', text: `Layout changed: ${plural(moved, 'tile')} moved or resized` });
  else if (layoutOnly) changes.push({ kind: 'layout', text: 'Layout changed' });
  for (const tile of placed) changes.push({ kind: 'tile', text: `New tile placed: ${tile}` });
  // Two drafts compare their own lists of data; a draft and a published App, what their tiles read.
  const sourcesOf = (shape: AppVersionShape) => (before.form === after.form ? shape.sources : shape.tileData);
  const oldSources = new Map(sourcesOf(before).map((source) => [source.id, source]));
  const newSources = new Map(sourcesOf(after).map((source) => [source.id, source]));
  const addedData = [...newSources.values()].filter((source) => !oldSources.has(source.id)).map((source) => source.label);
  const removedData = [...oldSources.values()].filter((source) => !newSources.has(source.id)).map((source) => source.label);
  if (addedData.length) changes.push({ kind: 'data', text: `Data added: ${listWords([...new Set(addedData)])}` });
  if (removedData.length) changes.push({ kind: 'data', text: `Data removed: ${listWords([...new Set(removedData)])}` });
  if (!changes.length && before.form === after.form && before.settings !== after.settings) {
    changes.push({ kind: 'settings', text: 'App settings changed' });
  }
  return changes;
}

/**
 * A page's grid without what its tiles show: the columns and rows, and where each tile sits, for every screen size
 * (the sizes' grids repeat the tiles, so a tile's text change is not a layout change).
 */
function gridOf(page: Record<string, unknown>): unknown {
  const layout = (page.layout ?? {}) as Record<string, unknown>;
  const places = (items: unknown) => (Array.isArray(items) ? items.map((item) => {
    const tile = (item ?? {}) as Record<string, unknown>;
    return [tile.i, tile.x, tile.y, tile.w, tile.h];
  }) : items);
  const responsive = layout.responsive && typeof layout.responsive === 'object'
    ? Object.fromEntries(Object.entries(layout.responsive as Record<string, Record<string, unknown> | undefined>).map(([size, grid]) => [size, grid ? { ...grid, items: places(grid.items) } : grid]))
    : layout.responsive;
  return { ...without(layout, new Set(['items', 'responsive'])), responsive };
}

/** How one tile that is in both versions changed: its title, its text, its chart, its data, its filters. */
function tileChanges(was: Record<string, unknown>, tile: Record<string, unknown>, where: string): AppChange[] {
  const out: AppChange[] = [];
  const label = appTileLabel(was);
  if (typeof was.title === 'string' && typeof tile.title === 'string' && was.title.trim() !== tile.title.trim() && tile.title.trim()) {
    out.push({ kind: 'tile', text: `Tile ${quoted(label)} renamed to ${quoted(clipLabel(tile.title))}${where}` });
  } else if (!same(was.title, tile.title)) {
    out.push({ kind: 'tile', text: `Tile ${quoted(label)}: title changed${where}` });
  }
  if (!same(was.text, tile.text)) out.push({ kind: 'text', text: `Text changed in ${quoted(label)}${where}` });
  const aspects: string[] = [];
  const rest = new Set(['title', 'text', 'i', ...TILE_PLACE]);
  const changedKeys = [...new Set([...Object.keys(was), ...Object.keys(tile)])].filter((key) => !rest.has(key) && !same(was[key], tile[key]));
  if (changedKeys.includes('viz') || changedKeys.includes('display')) aspects.push('chart');
  if (changedKeys.some((key) => TILE_DATA.has(key))) aspects.push('data');
  if (changedKeys.some((key) => TILE_FILTERS.has(key))) aspects.push('filters');
  if (changedKeys.includes('description')) aspects.push('description');
  if (!aspects.length && changedKeys.length) aspects.push('settings');
  if (aspects.length) out.push({ kind: 'tile', text: `${quoted(label)}: ${listWords(aspects)} changed${where}` });
  return out;
}

/** One line about what changed between two shapes of an App: "Added 1 tile", "Text changed in "Intro"". */
export function appEditWords(before: AppVersionShape | null, after: AppVersionShape | null, context: AppChangeContext = {}): string | undefined {
  if (!before || !after) return undefined;
  const parts: string[] = [];
  if (after.pages > before.pages) parts.push(`Added ${after.pages - before.pages === 1 ? 'a page' : plural(after.pages - before.pages, 'page')}`);
  if (after.pages < before.pages) parts.push(`Removed ${before.pages - after.pages === 1 ? 'a page' : plural(before.pages - after.pages, 'page')}`);
  if (after.tiles > before.tiles) parts.push(`Added ${plural(after.tiles - before.tiles, 'tile')}`);
  if (after.tiles < before.tiles) parts.push(`Removed ${plural(before.tiles - after.tiles, 'tile')}`);
  if (!parts.length && before.content !== after.content) {
    // Said as what changed when it is one or two things ("Text changed in "Intro""), else in general.
    const said = appChanges(before, after, context).filter((change) => change.kind !== 'name' && change.kind !== 'description' && change.kind !== 'data');
    parts.push(said.length && said.length <= 2 ? said.map((change) => change.text).join('. ') : 'Tiles or layout changed');
  }
  // Settings compare only between two drafts or two published versions (they are kept differently).
  if (!parts.length && before.form === after.form && before.settings !== after.settings) parts.push('App settings or data changed');
  return parts.length ? parts.join(', ') : undefined;
}
