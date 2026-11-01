import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authorizedFetch } from '../api/server-auth';

/**
 * When ZLens runs inside a host (RFC 0010 HH-9), the host says who is signed
 * in, what they may do, and what it adds around DQL's screens: links to its
 * own pages, its sign-out, and actions on answers that need review. The
 * screens stay DQL's. Without a host (`zlens notebook`) this is `{ host: false }`
 * and nothing in the app changes.
 */
export interface HostUi {
  host: true;
  person: { id: string; name: string; email?: string; kind: 'person' | 'service' };
  capabilities: Record<string, boolean>;
  signOutUrl?: string;
  environment?: string;
  links: HostLink[];
  answerActions: HostAnswerAction[];
  /** A strip above every screen, e.g. "Draft space — changes go to review, not Production". */
  banner?: HostBanner;
  /** For an action the person may not take: the host's reason and where to go (HH-12), e.g. Request access. */
  refusals?: Record<string, { reason?: string; next?: { label: string; href: string }; readOnly?: boolean }>;
  /** `reader`: the person reads and asks here but does not build; screens leave out the notebook's local words. */
  audience?: 'reader';
  /** What an App link says when this project has no such App, and where to go. */
  appNotFound?: { message: string; next?: { label: string; href: string } };
  /**
   * `proposes`: certifying data, a saved query or a join here only proposes certification; the host certifies through
   * its own review. The App Studio's certify words say "propose" instead. Absent: the person certifies here.
   */
  certification?: 'proposes';
}

export interface HostBanner { text: string; tone?: 'info' | 'caution'; links?: Array<{ label: string; href: string }> }

export type HostIcon = 'inbox' | 'requests' | 'review' | 'work' | 'health' | 'admin' | 'people' | 'git' | 'link';
export interface HostLink { id: string; label: string; href: string; placement: 'menu' | 'nav'; badge?: number; icon?: HostIcon }

/** Where the host's review of one answer stands (HH-10), e.g. "Checked by" and the reviewer's name. */
export interface HostAnswerStatus {
  state: 'requested' | 'in_progress' | 'checked' | 'certified' | 'declined';
  label: string;
  detail?: string;
  href?: string;
}

export interface HostAnswerAction { id: string; label: string; url: string; description?: string; on?: Array<'review' | 'unanswered' | 'answered'> }

export type HostUiState = HostUi | { host: false };

const HostUiContext = createContext<HostUiState>({ host: false });

/** The host page open in DQL's main area, if any. */
export interface HostPage { id: string; label: string; href: string }

/** Ask the host where each answer's review stands; answers it doesn't know are absent. */
export async function fetchHostAnswerStatuses(runIds: string[]): Promise<Record<string, HostAnswerStatus>> {
  if (!runIds.length) return {};
  const response = await authorizedFetch('/api/host/answer-status', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runIds }),
  });
  if (!response.ok) return {};
  const body = await response.json().catch(() => ({})) as { statuses?: Record<string, HostAnswerStatus> };
  return body.statuses ?? {};
}
const HostPageContext = createContext<{ page: HostPage | null; openPage: (page: HostPage) => void }>({ page: null, openPage: () => undefined });

/**
 * Whether the page ZLens served says it runs under a host (`<meta name="dql-hosted" content="1">`, set by the server
 * when it has host hooks). A hosted page never shows the single-user screens, even before the capability map arrives
 * or when loading it fails.
 */
export function pageSaysHosted(doc: Pick<Document, 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  try {
    return doc?.querySelector('meta[name="dql-hosted"]')?.getAttribute('content') === '1';
  } catch {
    return false;
  }
}

/** The host map as the app reads it: the fields of the expected shapes only (a proxy or a broken host can send anything). */
export function hostUiFrom(value: unknown): HostUi | null {
  if (!value || typeof value !== 'object' || (value as { host?: unknown }).host !== true) return null;
  const raw = value as Record<string, unknown>;
  const person = raw.person && typeof raw.person === 'object' ? raw.person as Record<string, unknown> : null;
  if (!person || typeof person.id !== 'string') return null;
  const capabilities = raw.capabilities && typeof raw.capabilities === 'object' && !Array.isArray(raw.capabilities)
    ? Object.fromEntries(Object.entries(raw.capabilities as Record<string, unknown>).map(([action, allowed]) => [action, allowed === true]))
    : {};
  const objects = (list: unknown) => (Array.isArray(list) ? list.filter((item) => !!item && typeof item === 'object') : []);
  const rest: Record<string, unknown> = { ...raw };
  delete rest.certification;
  return {
    ...(rest as unknown as HostUi),
    person: { id: person.id, name: typeof person.name === 'string' ? person.name : person.id, ...(typeof person.email === 'string' ? { email: person.email } : {}), kind: person.kind === 'service' ? 'service' : 'person' },
    capabilities,
    links: objects(raw.links) as HostLink[],
    answerActions: objects(raw.answerActions) as HostAnswerAction[],
    // Only the one value the app knows; anything else reads as "certifies here".
    ...(raw.certification === 'proposes' ? { certification: 'proposes' as const } : {}),
  };
}

/** Whether certifying here only proposes certification (the host certifies through its review); never without a host. */
export function hostProposesCertification(state: HostUiState): boolean {
  return state.host && state.certification === 'proposes';
}

/** Waits between attempts to load the host map while it is not known yet: quick at first, then every 30 seconds. */
export const HOST_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** After this long without a map, the page says ZLens cannot be reached (it keeps trying). */
export const HOST_UNREACHABLE_AFTER_MS = 15_000;

type Pending = { since: number; attempts: number; status: number | null };

export function HostUiProvider({ children, initial }: { children: ReactNode; initial?: HostUiState }) {
  // Under a host the map starts unknown (pending): nothing is shown but "Connecting…" until it arrives.
  const [state, setState] = useState<HostUiState | null>(() => initial ?? (pageSaysHosted() ? null : { host: false }));
  const [pending, setPending] = useState<Pending>(() => ({ since: Date.now(), attempts: 0, status: null }));
  const [page, setPage] = useState<HostPage | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    let retry: number | undefined;
    // Known to be hosted: from the page, or from any answer of the server marked hosted. Once hosted, always hosted.
    let hosted = pageSaysHosted();
    let known: HostUiState | null = hosted ? null : { host: false };
    let waiting: Pending = { since: Date.now(), attempts: 0, status: null };
    const settle = (next: HostUiState) => {
      known = next;
      waiting = { since: Date.now(), attempts: 0, status: null };
      window.clearTimeout(retry);
      if (!cancelled) setState(next);
    };
    const failed = (status: number | null) => {
      // A hosted map that loaded once stays as it was (a failed reload during a restart changes nothing).
      if (known && known.host) return;
      // Without a host nothing changes: the single-user screens, as before.
      if (!hosted) return;
      known = null;
      if (cancelled) return;
      waiting = { since: waiting.attempts === 0 ? Date.now() : waiting.since, attempts: waiting.attempts + 1, status };
      setState(null);
      setPending(waiting);
      window.clearTimeout(retry);
      retry = window.setTimeout(() => void load(), HOST_RETRY_DELAYS_MS[Math.min(waiting.attempts - 1, HOST_RETRY_DELAYS_MS.length - 1)]);
    };
    const load = (): Promise<void> => authorizedFetch('/api/host/ui', { credentials: 'same-origin' })
      .then(async (response) => {
        if (response.headers.get('x-dql-hosted') === '1') hosted = true;
        if (!response.ok) return failed(response.status);
        const value: unknown = await response.json().catch(() => null);
        const hostUi = hostUiFrom(value);
        if (hostUi) {
          hosted = true;
          return settle(hostUi);
        }
        // Only a server that is not hosted may say so; anything else from a hosted one is a failed load.
        if (!hosted && value && typeof value === 'object' && (value as { host?: unknown }).host === false) return settle({ host: false });
        return failed(response.status);
      })
      .catch(() => failed(null));
    void load();
    // Counts on the host's links change as work moves: reload when a host page
    // says something changed, when the tab comes back, and once a minute.
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && isHostChange(event.data)) void load();
    };
    const onFocus = () => void load();
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(load, 60_000);
    // Re-render the waiting screen as time passes (to say when ZLens cannot be reached).
    const clock = window.setInterval(() => { if (!known) setTick((value) => value + 1); }, 1_000);
    return () => {
      cancelled = true;
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
      window.clearInterval(clock);
      window.clearTimeout(retry);
    };
  }, [initial]);
  if (!state) return <HostConnecting pending={pending} />;
  return (
    <HostUiContext.Provider value={state}>
      <HostPageContext.Provider value={{ page, openPage: setPage }}>{children}</HostPageContext.Provider>
    </HostUiContext.Provider>
  );
}

/** What a hosted page shows until it knows what this person may do: no screens, a neutral line, then a plain "cannot be reached". */
export function HostConnecting({ pending, now = Date.now() }: { pending: Pending; now?: number }) {
  const unreachable = pending.attempts > 0 && now - pending.since >= HOST_UNREACHABLE_AFTER_MS;
  const signedOut = pending.status === 401;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'var(--bg-0)', color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5, textAlign: 'center' }}
    >
      <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
        {signedOut ? (
          <span>Sign in to use ZLens.</span>
        ) : unreachable ? (
          <>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>ZLens can't be reached right now.</span>
            <span>It keeps trying. You can also reload the page.</span>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}
            >
              Reload
            </button>
          </>
        ) : (
          <span>Connecting…</span>
        )}
      </div>
    </div>
  );
}

/** The message a host page inside DQL posts after changing something (HH-10). */
export const HOST_CHANGED_MESSAGE = 'dql-host:changed';
export function isHostChange(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { type?: unknown }).type === HOST_CHANGED_MESSAGE;
}

export function useHostPage() {
  return useContext(HostPageContext);
}

/** A host page inside DQL's main area: DQL's frame stays, the page fills it. */
export function hostPageSrc(href: string): string {
  return `${href}${href.includes('?') ? '&' : '?'}embed=1`;
}

export function useHostUi(): HostUiState {
  return useContext(HostUiContext);
}

/**
 * Whether this person may do an action. Without a host the local owner may
 * do everything, as before; with one, only what the host's rules allow.
 */
export function hostAllows(state: HostUiState, action: string): boolean {
  if (!state.host) return true;
  return state.capabilities[action] === true;
}

/** Why the host refuses this action and where the person can go, when it said (HH-12); null when it is allowed. */
export function hostRefusal(state: HostUiState, action: string): { reason?: string; next?: { label: string; href: string }; readOnly?: boolean } | null {
  if (!state.host || state.capabilities[action] === true) return null;
  return state.refusals?.[action] ?? {};
}

/** Whether the screens speak to a reader (a hosted person who does not build here): no local-notebook words. */
export function hostReader(state: HostUiState): boolean {
  return state.host && state.audience === 'reader';
}

/** Which DQL action each navigation destination needs under a host. */
export const NAV_CAPABILITY: Record<string, string[]> = {
  ask: ['ask'],
  // Anyone who may read the project sees these four; without the write action below they open read-only.
  files: ['project.read', 'project.write'],
  block_library: ['project.read', 'dataset.author'],
  lineage: ['project.read', 'dataset.author'],
  domains: ['project.read', 'dataset.author'],
  // Source control and Ask observability need their write action. When Production follows main the host
  // refuses it for everyone; a refusal carrying a `next` link (people who may draft) shows them read-only.
  ask_observability: ['hint.review'],
  git: ['git.review'],
  settings: ['settings.manage', 'connection.manage'],
};

/** Screens shown read-only to a person whose write action is refused with a next step. */
const NAV_SHOWN_WITH_NEXT = new Set(['git', 'ask_observability']);

/**
 * Screens shown read-only only to a person the host marks `readOnly` on one of the screen's actions: it holds the
 * action by role but the space refuses it (Production follows main). A `next` link alone never shows them.
 */
const NAV_SHOWN_READ_ONLY = new Set(['settings']);

/** The action that lets a person edit on each of those screens. */
export const NAV_WRITE_CAPABILITY: Record<string, string> = {
  files: 'project.write',
  block_library: 'dataset.author',
  lineage: 'dataset.author',
  domains: 'dataset.author',
  git: 'git.review',
  ask_observability: 'hint.review',
};

export function navItemAllowed(state: HostUiState, key: string): boolean {
  const needs = NAV_CAPABILITY[key];
  if (!state.host || !needs) return true;
  if (needs.some((action) => hostAllows(state, action))) return true;
  if (NAV_SHOWN_READ_ONLY.has(key) && needs.some((action) => hostRefusal(state, action)?.readOnly === true)) return true;
  return NAV_SHOWN_WITH_NEXT.has(key) && readOnlyNext(state, key) !== null;
}

/** A screen the person may open but not edit: under a host, without that screen's write action. Never without a host. */
export function hostReadOnly(state: HostUiState, key: string): boolean {
  if (NAV_SHOWN_READ_ONLY.has(key)) return state.host && !(NAV_CAPABILITY[key] ?? []).some((action) => hostAllows(state, action));
  const write = NAV_WRITE_CAPABILITY[key];
  return !!write && state.host && !hostAllows(state, write);
}

/** The one-line reason a read-only screen gives: the host's own sentence when it sent one. */
export function readOnlyReason(state: HostUiState, key: string): string {
  const actions = NAV_SHOWN_READ_ONLY.has(key) ? (NAV_CAPABILITY[key] ?? []) : [NAV_WRITE_CAPABILITY[key]];
  for (const action of actions) {
    const reason = action ? hostRefusal(state, action)?.reason : undefined;
    if (reason) return reason;
  }
  return 'Read-only: you can look here, but changes are not allowed.';
}

/** The next step the host offers a person its refusal applies to (for example "Open my draft space"), if it sent one. */
export function readOnlyNext(state: HostUiState, key: string): { label: string; href: string } | null {
  const write = NAV_WRITE_CAPABILITY[key];
  return (write && hostRefusal(state, write)?.next) || null;
}

/** Which of those screens the main view is showing, if any. */
export function navKeyForView(mainView: string): string | null {
  switch (mainView) {
    case 'notebook': return 'files';
    case 'block_studio': return 'block_library';
    case 'lineage':
    case 'lineage_detail': return 'lineage';
    case 'domains':
    case 'modeling': return 'domains';
    case 'git': return 'git';
    case 'settings':
    case 'connection': return 'settings';
    case 'ask_observability':
    case 'ask_trace': return 'ask_observability';
    default: return null;
  }
}

/**
 * Where a person lands at "/" with nothing requested. Under a host, people who may ask land on Ask (Home cards
 * above it); everyone else stays on Apps, where Home cards show above the list. Without a host: unchanged.
 * Deep links (an App, a page, /ask, another view) arrive as a different `mainView` or an open App and are left alone.
 */
export function hostLandingView(state: HostUiState, here: { pathname: string; mainView: string; activeAppId: string | null }): 'ask' | null {
  if (!state.host || here.pathname !== '/' || here.mainView !== 'apps' || here.activeAppId) return null;
  return hostAllows(state, 'ask') ? 'ask' : null;
}

/** Post an answer action to the host; returns the message to show. */
export async function runHostAnswerAction(action: HostUi['answerActions'][number], input: { runId: string; question: string; threadId?: string; trustState?: string; note?: string }): Promise<string> {
  const response = await authorizedFetch(action.url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { message?: unknown; error?: unknown };
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `The request was not sent (${response.status}).`);
  return typeof body.message === 'string' ? body.message : 'Sent.';
}
