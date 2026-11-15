import { useSyncExternalStore } from 'react';

/**
 * Where the History page is (V15, the ZLens app for Snowflake): the project's changes, one item's versions, or two
 * versions compared. Kept beside the notebook store, so History adds no state to it; the page itself is the
 * `history` main view.
 */
export type HistoryRoute =
  | { page: 'feed' }
  | { page: 'item'; path: string }
  | { page: 'compare'; path: string; from: number; to: number; back?: 'feed' | 'item' };

let route: HistoryRoute = { page: 'feed' };
/** A saved query whose History tab should open next time Block Studio shows it. */
let blockHistoryTab: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function historyRoute(): HistoryRoute {
  return route;
}

export function setHistoryRoute(next: HistoryRoute): void {
  route = next;
  emit();
}

export function useHistoryRoute(): HistoryRoute {
  return useSyncExternalStore(subscribe, historyRoute, historyRoute);
}

/** Ask Block Studio to show the History tab when it opens this saved query. */
export function requestBlockHistoryTab(path: string): void {
  blockHistoryTab = path;
}

/** True once, when Block Studio opened the saved query whose History tab was asked for. */
export function takeBlockHistoryTab(path: string | null | undefined): boolean {
  if (!path || blockHistoryTab !== path) return false;
  blockHistoryTab = null;
  return true;
}
