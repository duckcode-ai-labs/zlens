import { useSyncExternalStore } from 'react';
import { lastPersonActivity, onPersonActive } from '../api/server-auth';

/**
 * The ZLens app for Snowflake stopped: by itself after its quiet spell, or because it was stopped
 * (`stop_app()`, or Snowflake suspending the service). Snowflake starts a stopped app again on ANY request
 * to its address, so from then on this page sends nothing by itself: it holds every request to ZLens,
 * unsent, until the person chooses to start ZLens again (startZLensAgain: it wakes ZLens, waits until it answers, then
 * the page reloads).
 *
 * The server says so with a `stopping` event on the page's event streams (it sends one only inside
 * Snowflake). In the app for Snowflake the page also takes ZLens as stopped when its event streams fail
 * to reconnect a few times in a row (followServerEvents), or when Snowflake answers a request with its own
 * "service is not running" (watchForStoppedService). Because the event can be lost (the ingress ends every
 * connection after about 90 s), a page nobody touched for QUIET_AFTER_MS also sends nothing by itself.
 */
export type ZLensStoppedReason = 'idle' | 'stopped' | 'lost';

export interface ZLensStopped {
  /** `idle`: no one used it for its quiet spell; `stopped`: it was stopped; `lost`: the page lost it without being told. */
  reason: ZLensStoppedReason;
  /** For `idle`: the quiet spell, in minutes. */
  idleMinutes?: number;
  /** The person came back to a quiet page and ZLens had stopped: the page starts it at once, without asking. */
  startNow?: boolean;
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
  if (stopped) {
    // Already stopped: news that ZLens is starting (the person's own request woke it) still changes what the page
    // says (V17 patch 4 tester: "will not start it again by itself" while it was starting). Nothing else changes.
    if (next.startNow && !stopped.startNow) {
      stopped = { ...stopped, startNow: true };
      for (const listener of listeners) listener();
    }
    return;
  }
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
  return status >= 502 && status <= 504 && /ERROR_SERVICE_UNAVAILABLE|service is not yet running|not reachable|serviceStatus=/i.test(body);
}

/** Inside Snowflake, ZLens marks every answer it sends with this header. */
export const ZLENS_APP_HEADER = 'x-zlens-app';
let zlensMarkSeen = false;

/**
 * Whether Snowflake, not ZLens, answered: a stopped or starting app (Snowflake starts it on this request). Once the
 * page has seen ZLens's mark on any answer, an unmarked 5xx is Snowflake's, whatever its text: the V17 tester's
 * page did not recognise Snowflake's answers by their text and said ZLens "will not start" while it was starting.
 * Until then (should the mark not pass through), Snowflake's answer is recognised by its text.
 */
export async function snowflakeAnswered(response: Response): Promise<boolean> {
  if (response.headers.get(ZLENS_APP_HEADER) === '1') {
    zlensMarkSeen = true;
    return false;
  }
  if (response.type === 'opaqueredirect') return false;
  // A gateway answer without ZLens's mark is Snowflake's, whatever its text (V17 patch 4 tester: 24 of them in a
  // row were not recognised). ZLens marks its own 503s.
  if (response.status >= 502 && response.status <= 504) return true;
  if (response.status < 500 || !zlensMarkSeen) return false;
  return true;
}

let unwatchedFetch: typeof fetch | undefined;

/**
 * The page goes quiet this long after the person last touched it (app for Snowflake only). The Snowflake ingress
 * ends every connection after about 90 s, and Snowflake starts a stopped app on ANY request: a page that opened its
 * event streams again, or polled, after ZLens stopped woke it (V4 release check: once a minute after the idle stop,
 * and 3 s after stop_app()). A quiet page sends nothing by itself. The person's next touch resumes it: the page first
 * asks whether ZLens still runs, then sends what waited (or, if ZLens stopped, starts it and opens it when ready).
 */
export const QUIET_AFTER_MS = 2 * 60_000;

interface Waiting {
  input: RequestInfo | URL;
  init?: RequestInit;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

const waiting: Waiting[] = [];
let resuming = false;
let stopActivityWatch: (() => void) | undefined;

/** Whether the page is quiet now: in the app for Snowflake, no touch from the person for QUIET_AFTER_MS. */
export function isPageQuiet(now = Date.now()): boolean {
  return unwatchedFetch !== undefined && now - lastPersonActivity() > QUIET_AFTER_MS;
}

/** A request the person waits on although they do not touch the page: a long Ask or App plan they started. */
function waitedOnByPerson(input: RequestInfo | URL): boolean {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(raw, typeof location === 'undefined' ? 'http://zlens.invalid/' : location.href).pathname.startsWith('/api/long-requests/');
  } catch {
    return false;
  }
}

/** The person touched a quiet page: ask whether ZLens still runs, then let everything that waited go. */
async function resumeQuietPage(send: typeof fetch): Promise<void> {
  if (resuming || stopped || waiting.length === 0) return;
  resuming = true;
  try {
    let running = false;
    try {
      const response = await send('/api/health', { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
      running = response.ok;
      if (running) void snowflakeAnswered(response);
    } catch {
      // Unreachable: not running as far as this page can tell.
    }
    if (!running) {
      // ZLens did not answer for itself: Snowflake did (it stopped while the page was quiet, and that check has
      // started it again), or Snowflake wants a sign-in, or it could not be reached. The person is back, so the page
      // starts it and opens it when it is ready. Nothing that waited is sent (V17 patch 4 tester: requests let go
      // here met Snowflake's 503s and the page said ZLens "will not start" while it was starting).
      markZLensStopped({ reason: 'idle', startNow: true });
      return;
    }
    for (const item of waiting.splice(0)) send(item.input, item.init).then(item.resolve, item.reject);
  } finally {
    resuming = false;
  }
}

let confirming: Promise<boolean> | undefined;

/**
 * Whether ZLens itself answers its health check now. One check at a time, shared by every request that asks: a
 * burst of polls that met the same gateway answer costs one check. A stopped ZLens is started by this check too,
 * as by the request before it.
 */
function zlensAnswersNow(send: typeof fetch): Promise<boolean> {
  confirming ??= (async () => {
    try {
      const response = await send('/api/health', { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
      if (!response.ok) return false;
      void snowflakeAnswered(response);
      return true;
    } catch {
      return false;
    }
  })().finally(() => { confirming = undefined; });
  return confirming;
}

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
  stopActivityWatch = onPersonActive(() => { void resumeQuietPage(send); });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!stopped && reachesZLens(input) && isPageQuiet() && !waitedOnByPerson(input)) {
      // Quiet page: the request waits, unsent, until the person is back (or its caller gives up).
      const signal = init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
      return new Promise<Response>((resolve, reject) => {
        if (signal?.aborted) { reject(aborted(signal)); return; }
        const item: Waiting = { input, init, resolve, reject };
        waiting.push(item);
        signal?.addEventListener('abort', () => {
          const index = waiting.indexOf(item);
          if (index >= 0) waiting.splice(index, 1);
          reject(aborted(signal));
        }, { once: true });
      });
    }
    const response = await send(input, init);
    // Snowflake answered for ZLens: this request has started it again (a quiet page sends nothing by itself, so the
    // person was here moments ago). The page says it is starting and opens it when ready. Unless ZLens answers its
    // health check at once: then it was one passing gateway answer, and the caller sees it as any failed request
    // (V17 p6 tester: one poll met a 503 mid-Ask while ZLens ran, and the page reloaded itself).
    if (!stopped && reachesZLens(input) && await snowflakeAnswered(response) && !(await zlensAnswersNow(send))) {
      markZLensStopped({ reason: 'stopped', startNow: true });
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
      if (response.ok) {
        void snowflakeAnswered(response);
        return 'ready';
      }
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
  zlensMarkSeen = false;
  confirming = undefined;
  stopActivityWatch?.();
  stopActivityWatch = undefined;
  waiting.splice(0);
  resuming = false;
  for (const listener of listeners) listener();
}
