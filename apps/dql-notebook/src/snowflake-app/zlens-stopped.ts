import { useSyncExternalStore } from 'react';

/**
 * The ZLens app for Snowflake stopped: by itself after its quiet spell, or because it was stopped
 * (`stop_app()`, or Snowflake suspending the service). Snowflake starts a stopped app again on ANY request
 * to its address, so from then on this page sends nothing by itself: it holds every request to ZLens,
 * unsent, until the person chooses to start ZLens again (startZLensAgain: it wakes ZLens, waits until it answers, then
 * the page reloads).
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

/** Snowflake's own answer for a service that is not running: `503 {"responseType":"ERROR_SERVICE_UNAVAILABLE", …}`. */
export function snowflakeSaysNotRunning(status: number, body: string): boolean {
  return status === 503 && /ERROR_SERVICE_UNAVAILABLE|service is not yet running/i.test(body);
}

let unwatchedFetch: typeof fetch | undefined;

/**
 * In the app for Snowflake: a request that Snowflake answers with "service is not running" means ZLens stopped
 * without this page hearing `stopping` (a dropped event stream; V4 release check). That request has started it
 * again, so the page now takes ZLens as stopped and sends nothing more: it stops by itself after its quiet spell,
 * and a missed event costs one quiet spell, not every hour the tab stays open.
 */
export function watchForStoppedService(): void {
  if (unwatchedFetch || typeof globalThis.fetch !== 'function') return;
  const send = globalThis.fetch;
  unwatchedFetch = send;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await send(input, init);
    if (response.status === 503 && !stopped && reachesZLens(input)) {
      try {
        if (snowflakeSaysNotRunning(response.status, await response.clone().text())) markZLensStopped({ reason: 'stopped' });
      } catch {
        // An answer that cannot be read says nothing about ZLens stopping.
      }
    }
    return response;
  }) as typeof fetch;
}

/** How starting ZLens again ended: ZLens answers, Snowflake wants the person to sign in, or it did not start in time. */
export type StartOutcome = 'ready' | 'sign-in' | 'gave-up';

/** How often the page checks whether ZLens answers again, and when it stops checking. */
export const START_CHECK_MS = 10_000;
export const START_GIVE_UP_MS = 20 * 60_000;

/**
 * Starts ZLens again, once the person asks. The first request to its address wakes the service (Snowflake
 * starts a stopped app on any request); its health is then checked every few seconds until ZLens itself
 * answers, and only then does the caller reload the page. Reloading at once landed while ZLens was still
 * starting and showed Snowflake's raw "service is not yet running" error page (V4 release check). A redirect
 * means Snowflake wants the person to sign in again, which a reload shows.
 */
export async function startZLensAgain(options: {
  send?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  giveUpMs?: number;
} = {}): Promise<StartOutcome> {
  // The page holds every request to ZLens once it stopped; this one the person asked for, so it goes out.
  const send = options.send ?? pageFetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const interval = options.intervalMs ?? START_CHECK_MS;
  const giveUp = options.giveUpMs ?? START_GIVE_UP_MS;
  const started = now();
  for (;;) {
    try {
      const response = await send('/api/health', { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return 'sign-in';
      if (response.ok) return 'ready';
      // 503 from Snowflake: the service is still starting.
    } catch {
      // Not reachable yet.
    }
    if (now() - started >= giveUp) return 'gave-up';
    await sleep(interval);
  }
}

/** Tests: ZLens running again, requests sent as before. */
export function resetZLensStoppedForTests(): void {
  stopped = null;
  if (pageFetch) globalThis.fetch = pageFetch;
  pageFetch = undefined;
  if (unwatchedFetch) globalThis.fetch = unwatchedFetch;
  unwatchedFetch = undefined;
  for (const listener of listeners) listener();
}
