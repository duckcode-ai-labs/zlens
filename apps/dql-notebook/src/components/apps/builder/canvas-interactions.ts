import type { AppStudioBuildDraft, AppStudioDraftOperation } from '../../../api/client';

type Tile = AppStudioBuildDraft['pages'][number]['layout']['items'][number];

/** Grid metrics shared by the Studio canvas and the reader (DashboardRenderer uses the same gap). */
export const CANVAS_GAP_PX = 12;
export const CANVAS_COLUMNS = 12;
/** Tile header (44) plus the preview frame's padding (13) and a pixel of slack. */
const TILE_CHROME_PX = 60;

/** The page's row height, kept to a sane range so a bad file cannot break the canvas. */
export function canvasRowHeight(rowHeight: number | undefined): number {
  return Number.isFinite(rowHeight) ? Math.min(160, Math.max(40, Math.round(rowHeight!))) : 80;
}

/**
 * Height available to a chart in a placed tile: the card spans `rows` grid
 * rows, less its header and padding. Derived from the rows, never measured,
 * so a chart cannot grow the card it sits in.
 */
export function tileBodyHeight(rows: number, rowHeight: number): number {
  const card = rows * rowHeight + (rows - 1) * CANVAS_GAP_PX;
  return Math.max(96, card - TILE_CHROME_PX);
}

/** Whole grid cells covered by a pointer movement. */
export function cellsFromPixels(deltaPx: number, cellPx: number): number {
  if (!Number.isFinite(deltaPx) || cellPx <= 0) return 0;
  return Math.round(deltaPx / cellPx) || 0;
}

const PRESENTATION_KEYS = new Set(['title', 'description', 'owner', 'viz', 'display', 'x', 'y', 'w', 'h', 'sectionId']);

export interface IncrementalPreviewPlan {
  /** Tiles whose results must run again. */
  rerunTileIds: string[];
  /** Tiles whose current results must leave the preview (reruns and removals). */
  dropTileIds: string[];
}

/**
 * After an edit, which tiles need new results. Editing one tile's data,
 * adding a tile or removing one touches only those tiles; the rest of the page
 * keeps its results. Anything page-wide (filters, sources, links, pages)
 * returns undefined and the whole page reruns, as before.
 */
export function incrementalPreviewPlan(operations: AppStudioDraftOperation[], pageId: string): IncrementalPreviewPlan | undefined {
  const rerun = new Set<string>();
  const drop = new Set<string>();
  for (const operation of operations) {
    if (operation.type === 'set_layout') {
      if (operation.pageId !== pageId) return undefined;
      continue;
    }
    if (operation.type === 'update_tile') {
      if (operation.pageId !== pageId) return undefined;
      const dataKeys = Object.keys(operation.patch).filter((key) => !PRESENTATION_KEYS.has(key));
      if (dataKeys.length) {
        rerun.add(operation.tileId);
        drop.add(operation.tileId);
      }
      continue;
    }
    if (operation.type === 'add_tile') {
      if (operation.pageId !== pageId) return undefined;
      if (!operation.tile.text) rerun.add(operation.tile.i);
      continue;
    }
    if (operation.type === 'remove_tile') {
      if (operation.pageId !== pageId) return undefined;
      drop.add(operation.tileId);
      rerun.delete(operation.tileId);
      continue;
    }
    return undefined;
  }
  return { rerunTileIds: [...rerun], dropTileIds: [...drop] };
}

/** A fresh id for a copy of a tile: `<id>-copy`, then `<id>-copy-2`, and so on. */
export function copyTileId(items: Tile[], baseId: string): string {
  const taken = new Set(items.map((item) => item.i));
  const root = `${baseId.replace(/-copy(-\d+)?$/, '')}-copy`;
  if (!taken.has(root)) return root;
  for (let n = 2; n < 10_000; n += 1) {
    if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
  }
  return `${root}-${Date.now()}`;
}

export type CanvasShortcut =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'deselect' }
  | { kind: 'duplicate' }
  | { kind: 'remove' }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'resize'; dw: number; dh: number };

/**
 * The canvas keyboard map. Returns undefined while typing in a field, so
 * shortcuts never steal a keystroke meant for an input.
 */
export function canvasShortcut(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | { tagName?: string; isContentEditable?: boolean } | null;
}, tileSelected: boolean): CanvasShortcut | undefined {
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = target?.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return undefined;
  const mod = Boolean(event.metaKey || event.ctrlKey);
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (mod && key === 'z') return event.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
  if (mod && key === 'y') return { kind: 'redo' };
  if (key === 'Escape') return { kind: 'deselect' };
  if (!tileSelected || event.altKey) return undefined;
  if (mod && key === 'd') return { kind: 'duplicate' };
  if (!mod && (key === 'Delete' || key === 'Backspace')) return { kind: 'remove' };
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const arrow = arrows[key];
  if (arrow && !mod) return event.shiftKey ? { kind: 'resize', dw: arrow[0], dh: arrow[1] } : { kind: 'move', dx: arrow[0], dy: arrow[1] };
  return undefined;
}

/**
 * Where a canvas shortcut was pressed decides whether it applies. On the
 * canvas every shortcut works; undo and redo work anywhere. In the tile
 * settings panel, Delete removes the selected tile as long as focus is not
 * in a text field (canvasShortcut already ignores keys typed into fields),
 * so an author who just changed a setting can still delete the tile.
 */
export function canvasShortcutApplies(shortcut: CanvasShortcut, where: { onCanvas: boolean; inSettingsPanel: boolean; key: string }): boolean {
  if (shortcut.kind === 'undo' || shortcut.kind === 'redo') return true;
  if (where.onCanvas) return true;
  return where.inSettingsPanel && shortcut.kind === 'remove' && where.key === 'Delete';
}

/** How a tile was added to the page. */
export type StudioAddOrigin = 'source' | 'field_draft';

/**
 * The tile selected after an add. A tile built by clicking fields is not left
 * selected: the author's next field click starts a new tile instead of
 * changing the one just added.
 */
export function selectionAfterAdd(origin: StudioAddOrigin, addedTileId: string | undefined): string | null {
  if (origin === 'field_draft') return null;
  return addedTileId ?? null;
}

// ─── Undo that survives a reload ─────────────────────────────────────────────

const HISTORY_PREFIX = 'dql.studio.history.';
const HISTORY_INDEX_KEY = 'dql.studio.history-index';
const MAX_HISTORY_ENTRIES = 30;
const MAX_HISTORY_BYTES = 1_500_000;
/** Histories kept for this many drafts; the least recently edited go first. */
const MAX_HISTORY_DRAFTS = 5;

export interface StudioHistory {
  undo: AppStudioBuildDraft[];
  redo: AppStudioBuildDraft[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** The undo and redo stacks kept for a draft in this browser, if any. */
export function loadStudioHistory(draftId: string, store: StorageLike | undefined = storage()): StudioHistory {
  try {
    const raw = store?.getItem(`${HISTORY_PREFIX}${draftId}`);
    if (!raw) return { undo: [], redo: [] };
    const parsed = JSON.parse(raw) as Partial<StudioHistory>;
    const valid = (entries: unknown) => (Array.isArray(entries) ? entries.filter((entry): entry is AppStudioBuildDraft => Boolean(entry && typeof entry === 'object' && (entry as { id?: unknown }).id === draftId)) : []);
    return { undo: valid(parsed.undo).slice(-MAX_HISTORY_ENTRIES), redo: valid(parsed.redo).slice(-MAX_HISTORY_ENTRIES) };
  } catch {
    return { undo: [], redo: [] };
  }
}

/**
 * Keep the stacks for a reload. The oldest undo steps are dropped first when
 * the history is too large for local storage; failing to save never blocks an
 * edit.
 */
export function saveStudioHistory(draftId: string, history: StudioHistory, store: StorageLike | undefined = storage()): void {
  if (!store) return;
  const key = `${HISTORY_PREFIX}${draftId}`;
  let undo = history.undo.slice(-MAX_HISTORY_ENTRIES);
  const redo = history.redo.slice(-MAX_HISTORY_ENTRIES);
  try {
    if (undo.length === 0 && redo.length === 0) {
      store.removeItem(key);
      return;
    }
    let text = JSON.stringify({ undo, redo });
    while (text.length > MAX_HISTORY_BYTES && undo.length > 0) {
      undo = undo.slice(1);
      text = JSON.stringify({ undo, redo });
    }
    if (text.length > MAX_HISTORY_BYTES) return;
    store.setItem(key, text);
    rememberHistoryDraft(store, draftId);
  } catch {
    // Storage full or unavailable: the in-memory history still works.
  }
}

function rememberHistoryDraft(store: StorageLike, draftId: string): void {
  let index: string[] = [];
  try {
    const parsed = JSON.parse(store.getItem(HISTORY_INDEX_KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) index = parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    index = [];
  }
  const next = [...index.filter((id) => id !== draftId), draftId];
  for (const stale of next.splice(0, Math.max(0, next.length - MAX_HISTORY_DRAFTS))) {
    store.removeItem(`${HISTORY_PREFIX}${stale}`);
  }
  store.setItem(HISTORY_INDEX_KEY, JSON.stringify(next));
}
