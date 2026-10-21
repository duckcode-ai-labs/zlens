import type { AppStudioBuildDraft, DashboardRunResponse } from '../../api/client';

/**
 * A hierarchy or mark interaction refreshes only its server-validated tile
 * set. Keep unaffected settled components visible, but remove whole-page
 * facts, story, filter options, and receipt authority from the merged view.
 */
export function mergeStudioPartialPreview(
  previous: DashboardRunResponse,
  partial: DashboardRunResponse,
  items: AppStudioBuildDraft['pages'][number]['layout']['items'],
): DashboardRunResponse {
  const updates = new Map(partial.tiles.map((tile) => [tile.tileId, tile]));
  const prior = new Map(previous.tiles.map((tile) => [tile.tileId, tile]));
  return {
    ...partial,
    partial: true,
    executedTileIds: partial.executedTileIds ?? partial.tiles.map((tile) => tile.tileId),
    tiles: items.flatMap((item) => {
      const current = updates.get(item.i);
      if (current) return [current];
      const retained = prior.get(item.i);
      return retained ? [retained] : [];
    }),
    facts: [],
    filterOptions: undefined,
  };
}

/**
 * A full page response can contain safe, current component rows and one or
 * more governed failures. The browser may render those rows, but it must not
 * attempt to attach a whole-page receipt or retain an older receipt as though
 * this current scope were complete.
 */
export type StudioPreviewSettlement =
  | { kind: 'receipt_candidate'; readyCount: number; totalCount: number }
  | { kind: 'incomplete'; readyCount: number; totalCount: number; message: string; clearStoredReceipt: boolean }
  | { kind: 'unavailable'; readyCount: number; totalCount: number; message: string };

export function settleStudioPreviewRun(result: DashboardRunResponse): StudioPreviewSettlement {
  const executableTiles = result.tiles.filter((tile) => tile.tileType !== 'text' && tile.tileType !== 'aiPin');
  const readyCount = executableTiles.filter((tile) => tile.status === 'ok').length;
  const totalCount = executableTiles.length;
  if (result.incomplete) {
    return {
      kind: 'incomplete',
      readyCount,
      totalCount,
      message: result.incomplete.message,
      clearStoredReceipt: result.incomplete.priorPreviewReceiptInvalidated === true,
    };
  }
  if (result.stale) {
    return {
      kind: 'unavailable',
      readyCount,
      totalCount,
      message: result.staleReason ?? 'The page changed while it was running. Run it again.',
    };
  }
  if (result.partial) {
    return {
      kind: 'unavailable',
      readyCount,
      totalCount,
      message: 'Some tiles were updated. Run the whole page before publishing.',
    };
  }
  return { kind: 'receipt_candidate', readyCount, totalCount };
}

/**
 * Mirror a server-confirmed page-receipt invalidation locally. This is only a
 * display projection: the runtime already guarded the receipt ID, page, and
 * current draft intent before persisting the actual clear operation.
 */
export function withoutPagePreviewReceipt(
  draft: AppStudioBuildDraft,
  pageId: string,
): AppStudioBuildDraft {
  const receipts = draft.previewReceipts ?? (draft.previewReceipt ? [draft.previewReceipt] : []);
  if (!receipts.some((receipt) => receipt.pageId === pageId)) return draft;
  const remaining = receipts.filter((receipt) => receipt.pageId !== pageId);
  const next: AppStudioBuildDraft = { ...draft };
  if (remaining.length > 0) next.previewReceipts = remaining;
  else delete next.previewReceipts;
  if (draft.previewReceipt?.pageId === pageId) {
    const replacement = remaining.at(-1);
    if (replacement) next.previewReceipt = replacement;
    else delete next.previewReceipt;
  }
  return next;
}
