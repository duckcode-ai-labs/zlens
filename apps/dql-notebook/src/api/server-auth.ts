/**
 * The access-link fragment key. Links keep using `#dql_token=` so links already
 * shared (and older servers) keep working; `#zlens_token=` is accepted too.
 */
const SERVER_TOKEN_FRAGMENT_KEY = 'dql_token';
const SERVER_TOKEN_FRAGMENT_KEYS = [SERVER_TOKEN_FRAGMENT_KEY, 'zlens_token'] as const;
const SERVER_TOKEN_SESSION_KEY = 'dql.server-token.v1';

/** Read the one-time LAN bearer token without putting it in an HTTP request. */
export function serverTokenFromHash(hash: string): string | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  for (const key of SERVER_TOKEN_FRAGMENT_KEYS) {
    const token = params.get(key)?.trim();
    if (token) return token;
  }
  return undefined;
}

/** Remove only the access token while preserving any unrelated fragment state. */
export function hashWithoutServerToken(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  for (const key of SERVER_TOKEN_FRAGMENT_KEYS) params.delete(key);
  const remaining = params.toString();
  return remaining ? `#${remaining}` : '';
}

function initializeServerToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const supplied = serverTokenFromHash(window.location.hash);
    if (supplied) {
      window.sessionStorage.setItem(SERVER_TOKEN_SESSION_KEY, supplied);
      const cleanHash = hashWithoutServerToken(window.location.hash);
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}${cleanHash}`,
      );
      return supplied;
    }
    return window.sessionStorage.getItem(SERVER_TOKEN_SESSION_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const serverToken = initializeServerToken();

/**
 * How long after the person last touched the page a request still counts as
 * theirs. Later requests (polls, refreshes, recovery loops) are marked
 * `x-dql-background: 1`, so a host's idle sign-out isn't kept alive by a tab
 * nobody is using (RFC 0010).
 */
export const BACKGROUND_AFTER_MS = 30_000;
let lastActivityAt = Date.now();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const touched = () => { lastActivityAt = Date.now(); };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, touched, { capture: true, passive: true });
  }
}

/** Whether a request made now is background work rather than the person's own. */
export function isBackgroundNow(now = Date.now(), lastActivity = lastActivityAt): boolean {
  return now - lastActivity > BACKGROUND_AFTER_MS;
}

/** Attach the session-only token to same-origin DQL API calls when supplied. */
export function withServerAuthorization(headers?: HeadersInit): Headers {
  const resolved = new Headers(headers);
  if (serverToken) resolved.set('Authorization', `Bearer ${serverToken}`);
  if (isBackgroundNow()) resolved.set('x-dql-background', '1');
  return resolved;
}

const VIEWER_TOKEN_PREFIX = 'dqlv1.';

/**
 * When this tab was opened from a read-only page link (RFC 0010): the one
 * App it may read, and until when. The server checks the signature; this
 * only decides what the tab shows.
 */
export function viewerLink(token: string | undefined = serverToken): { appId: string; expiresAt: string } | null {
  if (!token?.startsWith(VIEWER_TOKEN_PREFIX)) return null;
  try {
    const body = token.split('.')[1] ?? '';
    const json = atob(body.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(body.length / 4) * 4, '='));
    const payload = JSON.parse(json) as { a?: unknown; e?: unknown };
    if (typeof payload.a !== 'string' || typeof payload.e !== 'number') return null;
    return { appId: payload.a, expiresAt: new Date(payload.e * 1000).toISOString() };
  } catch {
    return null;
  }
}

export function isViewerLink(): boolean {
  return viewerLink() !== null;
}

/** Whether this tab holds a LAN access token (from its link or pasted in). */
export function hasServerToken(): boolean {
  return Boolean(serverToken);
}

/**
 * The token in what a reader pastes: the full access link (`…#dql_token=…`)
 * or the token alone. A link without the token names no token.
 */
export function serverTokenFromAccessInput(input: string): string | undefined {
  const text = input.trim();
  for (const key of SERVER_TOKEN_FRAGMENT_KEYS) {
    const tokenAt = text.indexOf(`${key}=`);
    if (tokenAt >= 0) return serverTokenFromHash(text.slice(tokenAt));
  }
  return /^[\w.~-]{8,}$/.test(text) ? text : undefined;
}

/** Keep a pasted token for this tab; the page reloads to use it. */
export function rememberServerToken(token: string): void {
  window.sessionStorage.setItem(SERVER_TOKEN_SESSION_KEY, token);
}

export const SERVER_AUTH_REQUIRED_EVENT = 'dql:server-auth-required';
/** Fired when a host refuses a change (403): the host's sentence and, when it sent one, where to go (HH-12). */
export const HOST_REFUSAL_EVENT = 'dql-host-refusal';
export interface HostRefusalDetail { message: string; next?: { label: string; href: string } }

export function reportHostRefusal(status: number, method: string, detail: HostRefusalDetail): boolean {
  if (status !== 403 || method.toUpperCase() === 'GET' || typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<HostRefusalDetail>(HOST_REFUSAL_EVENT, { detail }));
  return true;
}

let serverAuthRejected = false;
let redirectingToSignIn = false;

/**
 * A LAN server refuses every API call without its token. Without this the
 * page loads and then waits forever: a tab opened without the full access
 * link (a new tab, a bookmark, a link a chat app shortened) has no token.
 */
export function reportServerAuthRejected(status: number, signInUrl?: string | null): boolean {
  if (status !== 401) return false;
  // RFC 0010 HH-9: a host that signs people in names where to go, as the
  // X-DQL-Sign-In header on its 401. Go there once, and come back here.
  if (signInUrl && signInUrl.startsWith('/') && !signInUrl.startsWith('//') && typeof window !== 'undefined' && !redirectingToSignIn) {
    redirectingToSignIn = true;
    const back = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`${signInUrl}${signInUrl.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(back)}`);
    return true;
  }
  serverAuthRejected = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SERVER_AUTH_REQUIRED_EVENT));
  return true;
}

export function wasServerAuthRejected(): boolean {
  return serverAuthRejected;
}

/** `fetch` for a same-origin DQL API path, with the tab's token. */
export async function authorizedFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, headers: withServerAuthorization(init?.headers) });
  reportServerAuthRejected(response.status, response.headers.get('x-dql-sign-in'));
  return response;
}

export interface ServerEventFrame {
  event: string;
  data: string;
}

/**
 * Read a same-origin SSE stream through fetch so LAN sessions can use the same
 * bearer header as every other API call. Native EventSource has no header API.
 * `onOpen` is called once the server has accepted the stream.
 */
export async function streamServerEvents(
  path: string,
  onEvent: (frame: ServerEventFrame) => void,
  signal: AbortSignal,
  onOpen?: () => void,
): Promise<void> {
  const response = await fetch(path, {
    headers: withServerAuthorization({ Accept: 'text/event-stream' }),
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  reportServerAuthRejected(response.status, response.headers.get('x-dql-sign-in'));
  if (!response.ok) throw new Error(`Event stream failed with HTTP ${response.status}.`);
  if (!response.body) throw new Error('Event stream response did not include a body.');
  onOpen?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length > 0) onEvent({ event, data: data.join('\n') });
    event = 'message';
    data = [];
  };

  while (!signal.aborted) {
    const next = await reader.read();
    buffer += decoder.decode(next.value, { stream: !next.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        dispatch();
      } else if (!line.startsWith(':')) {
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (field === 'event') event = value || 'message';
        if (field === 'data') data.push(value);
      }
    }
    if (next.done) {
      dispatch();
      return;
    }
  }
}
