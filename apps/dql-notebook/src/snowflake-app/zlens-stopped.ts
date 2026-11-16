import { useSyncExternalStore } from 'react';

/**
 * The ZLens app for Snowflake stopped: by itself after its quiet spell, or because it was stopped
 * (`stop_app()`, or Snowflake suspending the service). Snowflake starts a stopped app again on ANY request
 * to its address, so from then on this page sends nothing by itself: it holds every request to ZLens,
 * unsent, until the person chooses to start ZLens again (which reloads the page).
 *
 * The server says so with a `stopping` event on the page's event streams (it sends one only inside
 * Snowflake). In the app for Snowflake the page also takes ZLens as stopped when its event streams fail
 * to reconnect a few times in a row (followServerEvents).
 */
export type ZLensStoppedReason = 'idle' | 'stopped' | 'lost';

export interface ZLensStopped {
  /** `idle`: no one used it for its quiet spell; `stopped`: it was stopped; `lost`: the page lost it without being told. */
  reason: ZLensStoppedReason;
  /** For `idle`: the quiet spell, in minutes. */
  idleMinutes?: number;
}

let stopped: ZLensStopped | null = null;
const listeners = new Set<() => void>();

/** Why ZLens stopped, or null while it runs. */
export function zlensStopped(): ZLensStopped | null {
  return stopped;
}

export function isZLensStopped(): boolean {
  return stopped !== null;
}

/** ZLens stopped: hold every request to it from now on and tell the page. The first reason given stays. */
export function markZLensStopped(next: ZLensStopped): void {
  if (stopped) return;
  stopped = next;
  holdRequestsToZLens();
  for (const listener of listeners) listener();
}

/** The server's `stopping` event: `{ "reason": "idle", "idleMinutes": 60 }` or `{ "reason": "stopped" }`. */
export function stoppingNotice(data: string): ZLensStopped {
  try {
    const parsed = JSON.parse(data) as { reason?: unknown; idleMinutes?: unknown };
    if (parsed.reason === 'idle') {
      const minutes = typeof parsed.idleMinutes === 'number' && Number.isFinite(parsed.idleMinutes) && parsed.idleMinutes > 0 ? parsed.idleMinutes : undefined;
      return minutes === undefined ? { reason: 'idle' } : { reason: 'idle', idleMinutes: minutes };
    }
  } catch {
    // A frame we cannot read still says ZLens is stopping.
  }
  return { reason: 'stopped' };
}

export function subscribeZLensStopped(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Why ZLens stopped, or null while it runs; re-renders when it stops. */
export function useZLensStopped(): ZLensStopped | null {
  return useSyncExternalStore(subscribeZLensStopped, zlensStopped, zlensStopped);
}

let pageFetch: typeof fetch | undefined;

/** Whether a request goes to ZLens (this page's own address): any such request would wake the stopped service. */
function reachesZLens(input: RequestInfo | URL): boolean {
  const here = typeof location === 'undefined' ? undefined : location;
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, here?.href ?? 'http://zlens.invalid/');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return here === undefined || url.origin === here.origin;
  } catch {
    return true;
  }
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
}

/**
 * Every timer in the page (polls, refreshes, retries) asks through `fetch`. Once ZLens stopped, a request to
 * it waits, unsent, until its caller gives up (its abort signal) or the page reloads: none reaches Snowflake,
 * and a loop that retries on failure cannot spin, as it would on an error.
 */
function holdRequestsToZLens(): void {
  if (pageFetch || typeof globalThis.fetch !== 'function') return;
  const send = globalThis.fetch;
  pageFetch = send;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!reachesZLens(input)) return send(input, init);
    const signal = init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return;
      if (signal.aborted) {
        reject(aborted(signal));
        return;
      }
      signal.addEventListener('abort', () => reject(aborted(signal)), { once: true });
    });
  }) as typeof fetch;
}

/** Tests: ZLens running again, requests sent as before. */
export function resetZLensStoppedForTests(): void {
  stopped = null;
  if (pageFetch) globalThis.fetch = pageFetch;
  pageFetch = undefined;
  for (const listener of listeners) listener();
}
