/**
 * An App's data list is its draft `sources` (design D4). A source can be
 * connected before any tile uses it, from the Data step or **+ Add data**.
 * Publication only writes pages, so a connected source that no tile uses is
 * never part of what is published and must not block publishing.
 *
 * This module has no Node imports so the server and the browser share one
 * rule for "a tile uses this source".
 */

export interface AppDataSourceLike {
  id: string;
  kind?: string;
  sourceRef?: string;
  executionRef?: string;
  sourcePath?: string;
}

export interface AppDataTileLike {
  sourceId?: string;
  block?: { blockId?: string; ref?: string };
  semantic?: { id: string };
  draftAnalysis?: { ref: string };
}

export interface AppDataDraftLike<S extends AppDataSourceLike = AppDataSourceLike> {
  sources: readonly S[];
  pages: ReadonlyArray<{ layout: { items: readonly AppDataTileLike[] } }>;
}

function withoutNamespace(value: string): string {
  return value.replace(/^[^:]+:/, '');
}

function sourceReferences(source: AppDataSourceLike): Set<string> {
  const refs = new Set<string>();
  for (const value of [source.id, source.sourceRef, source.executionRef, source.sourcePath]) {
    const clean = value?.trim();
    if (!clean) continue;
    refs.add(clean);
    refs.add(withoutNamespace(clean));
  }
  return refs;
}

function tileReferences(tile: AppDataTileLike): string[] {
  const block = tile.block?.blockId ?? tile.block?.ref;
  return [block, tile.semantic?.id, tile.draftAnalysis?.ref]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
}

/** Ids of the draft sources at least one tile on any page uses. */
export function appSourceIdsUsedByTiles(draft: AppDataDraftLike): Set<string> {
  const tiles = draft.pages.flatMap((page) => page.layout.items);
  const tileSourceIds = new Set(tiles.map((tile) => tile.sourceId?.trim()).filter((id): id is string => Boolean(id)));
  const tileRefs = new Set(tiles.flatMap(tileReferences).flatMap((ref) => [ref, withoutNamespace(ref)]));
  const used = new Set<string>();
  for (const source of draft.sources) {
    if (tileSourceIds.has(source.id)) {
      used.add(source.id);
      continue;
    }
    for (const ref of sourceReferences(source)) {
      if (tileRefs.has(ref)) {
        used.add(source.id);
        break;
      }
    }
  }
  return used;
}

/** Connected data sources (not page text) that no tile uses yet. */
export function appSourcesNotUsedByTiles<S extends AppDataSourceLike>(draft: AppDataDraftLike<S>): S[] {
  const used = appSourceIdsUsedByTiles(draft);
  return draft.sources.filter((source) => source.kind !== 'text' && !used.has(source.id));
}
