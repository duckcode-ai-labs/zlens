import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import type { DqlAction, DqlResource, DqlRouteAction } from './route-actions.js';
import type { DqlCredentialsHook, DqlRowPolicy } from './row-policy.js';
import type { DqlAuditSink, DqlTraceSink } from './observability.js';
import { HostHookTimeoutError } from './hook-deadline.js';

export type { DqlAction, DqlResource, DqlRouteAction } from './route-actions.js';

/**
 * WHO IS ASKING (RFC 0010, slice HH-1). A program that embeds ZLens can tell
 * the server who made each request; ZLens then takes every "who did this"
 * record — a review, a correction's author, the owner of new content — from
 * that person instead of from the request body or this machine's git user.
 *
 * With no host hooks nothing here is used: `zlens notebook` keeps its one
 * local owner and behaves exactly as before.
 */
export interface DqlPrincipal {
  /** Stable id from the host's identity provider. */
  id: string;
  kind: 'person' | 'service';
  displayName?: string;
  email?: string;
  groups?: string[];
  /** Values row rules can read later (RFC 0010 HH-3), e.g. region. */
  attributes?: Record<string, string | number | boolean | string[]>;
  /**
   * HH-11: Apps the host gave this person beyond each App's own policies
   * (e.g. an approved request for one App), by App id. 'execute' runs its
   * tiles; 'read' only opens it. Absent: the App's policies decide alone.
   */
  appGrants?: Record<string, 'read' | 'execute'>;
  /**
   * 'host' when a hook supplied it; 'link' for a read-only page link, which
   * sees its one App as the owner publishes it; 'local' for the local owner.
   */
  source: 'local' | 'host' | 'link';
}

/**
 * WHERE A STATEMENT'S RESULT GOES (RFC 0010 HH-17), beyond the person
 * asking: `person` (shown to them), `model` (an Ask or Research answer, whose
 * results a model may read), `delivery` (a schedule's run, sent to its
 * recipients) or `export` (a file that leaves DQL: CSV, JSON, Excel).
 */
export type DqlDestination = 'person' | 'model' | 'delivery' | 'export';

/** DQL's file exports: a statement or one App tile run again for a CSV, JSON or Excel file. */
const FILE_EXPORT_ROUTE = /^\/api\/(?:query|apps\/[^/]+\/dashboards\/[^/]+)\/export$/;

/**
 * The destination of a request's statements, from its route action and path.
 * Only the file exports are `export`: a signed snapshot or a trace download
 * (also the `export` action) reads a run already made, as the person saw it.
 */
export function destinationForRequest(action: DqlAction | undefined, path: string): DqlDestination | undefined {
  if (action === 'export') return FILE_EXPORT_ROUTE.test(path) ? 'export' : 'person';
  return destinationForAction(action);
}

/** The destination of a request's statements, from its route action (HH-2). */
export function destinationForAction(action: DqlAction | undefined): DqlDestination | undefined {
  if (!action) return undefined;
  if (action === 'export') return 'export';
  if (action === 'ask' || action === 'research') return 'model';
  if (action === 'schedule.manage') return 'delivery';
  return 'person';
}

export interface DqlRequestContext {
  /** The signed-in person; absent when the host names no one for this request (it then reads no one's content). */
  principal?: DqlPrincipal;
  requestId: string;
  /** The route action this request was authorized as (HH-2); statements it runs carry it (HH-17). */
  action?: DqlAction;
  /** Where the request's statements' results go (HH-17); from `action`, or `delivery` for a scheduled run. */
  destination?: DqlDestination;
  /**
   * The hooks of the server this request arrived at. Several servers can run
   * in one process (a host's Production and its previews); each request uses
   * its own server's hooks, and the process-wide ones are only a fallback.
   */
  hooks?: DqlHostHooks;
}

/** The hooks of the server handling the current work (a request, or the server's own work), if a host set them. */
export function currentHostHooks(): DqlHostHooks | undefined {
  return scopedHostHooks()?.hooks;
}

/** What ZLens knows about the values it is about to send a model (`isInBoundary`). */
export interface DqlBoundaryContext {
  /** Every table the values came from, as DQL's SQL scan saw each statement; absent when it cannot list them all. */
  relations?: string[];
}

/** A certified source a person could read, as the host's `sourceAccess` sees it. */
export interface DqlSourceRef {
  id: string;
  kind: 'dataset' | 'block' | 'metric';
  name: string;
  domain?: string;
  /** Project-relative file, for blocks and block Datasets. */
  path?: string;
}

/**
 * The ids among `sources` this person may use, or null when no host decides
 * (all allowed). A host that errs allows none (fail closed).
 */
export async function hostAllowedSources(hooks: DqlHostHooks | undefined, principal: DqlPrincipal | null | undefined, sources: DqlSourceRef[]): Promise<Set<string> | null> {
  if (!hooks?.sourceAccess || !sources.length) return null;
  if (!principal) return new Set();
  try {
    return new Set(await hooks.sourceAccess(principal, sources));
  } catch {
    return new Set();
  }
}

/**
 * One knowledge server as a host hands it over for one person (HH-15): a
 * streamable HTTP MCP endpoint and that person's headers. ZLens calls only its
 * search and fetch tools (read-only), through the tool gate.
 */
export interface DqlKnowledgeServer {
  /** Stable id, shown in audit and citations, e.g. "confluence". */
  id: string;
  /** Shown beside citations, e.g. "Confluence". */
  label?: string;
  /** https (plain http only on this machine). */
  url: string;
  /** This person's own headers, e.g. `{ Authorization: 'Bearer …' }`. */
  headers?: Record<string, string>;
  /** Search tool and its query argument (default `search` / `query`). */
  searchTool?: string;
  searchArg?: string;
  /** Page tool and its id argument (default `fetch` / `id`). */
  fetchTool?: string;
  fetchArg?: string;
  /** Fixed arguments for every search / fetch, e.g. `{ cloudId }`. */
  searchArgs?: Record<string, unknown>;
  fetchArgs?: Record<string, unknown>;
}

/** A host's answer to "may this person do this?". */
export interface DqlDecision {
  allow: boolean;
  /** Shown to the person when refused. */
  reason?: string;
  /**
   * HH-12: where to go from a refusal, e.g. a page to ask for access. Only a
   * same-origin path (`/…`) is passed on; ZLens opens it as a host page.
   */
  next?: { label: string; href: string };
  /**
   * On a refusal: this person holds the action by role, but the place refuses it for everyone (for example
   * Production, which follows main, refuses every change). ZLens then lets them read what the action reviews,
   * read-only. A refusal for a person who does not hold the action never sets it; `next` is not a substitute.
   */
  readOnly?: boolean;
}

/** A refusal's `next` link as ZLens passes it on: a same-origin path only. */
export function safeNextLink(next: DqlDecision['next']): { label: string; href: string } | undefined {
  if (!next || typeof next.label !== 'string' || typeof next.href !== 'string') return undefined;
  if (!next.href.startsWith('/') || next.href.startsWith('//') || next.href.includes('\\')) return undefined;
  return { label: next.label.slice(0, 80), href: next.href };
}

export interface DqlHostHooks {
  /**
   * Who made this request. Called for every `/api/` request except
   * `/api/health`. Return null to refuse it (401); a hook that throws is a
   * refusal too. When present it replaces the shared-token check.
   */
  resolvePrincipal?(req: IncomingMessage): Promise<DqlPrincipal | null> | DqlPrincipal | null;
  /**
   * May this person do this? Called for every `/api/` request the host
   * placed, with the route's action and resource (RFC 0010 HH-2). A refusal
   * or a hook that throws answers 403. Without it, every placed person may
   * do everything, as with the shared token.
   */
  authorize?(principal: DqlPrincipal, action: DqlAction, resource: DqlResource): Promise<DqlDecision> | DqlDecision;
  /**
   * What each statement may read (RFC 0010 HH-3). Every query the server
   * sends to a warehouse — Datasets, page tiles, AI-written SQL, notebook
   * cells, proofs — passes here first; return it, a narrowed rewrite, or a
   * refusal. See `row-policy.ts`.
   */
  rowPolicy?: DqlRowPolicy;
  /**
   * The connection as the person asking (RFC 0010 HH-4): their own warehouse
   * token or role, laid over the configured connection before any statement
   * runs. A refusal stops the query with "reconnect" — never a retry with the
   * service credential. See `row-policy.ts`.
   */
  credentials?: DqlCredentialsHook;
  /**
   * One event per warehouse statement ZLens ran (RFC 0010 HH-6): the engine,
   * whether it read data or schema, the outcome and how long it took — for a
   * host's metrics. Never the SQL, its parameters, its rows or who asked.
   * Called after the statement finishes; errors are ignored.
   */
  statements?: DqlStatementObserver;
  /**
   * The model for this person (RFC 0010 HH-5), e.g. Claude through Amazon
   * Bedrock or Google Vertex in the customer's account
   * (`createBedrockClaudeProvider`, `createVertexClaudeProvider` in
   * dql-agent). Consulted before DQL's own provider settings; return
   * undefined to use them. `id` names the provider family for receipts.
   */
  modelProvider?(input: { principal: DqlPrincipal | null }): { id: string; provider: DqlModelProvider } | undefined;
  /**
   * Whether result values may reach this model — the privacy boundary.
   * Without it, only a model on this machine qualifies (Ollama on loopback).
   * The commercial host's approved rule: the model runs in the customer's
   * own cloud account, in a region their admin approved, with data
   * retention off.
   *
   * `context.relations` names every table the values DQL is about to send
   * came from, when it knows them all (a story drafted from a page run, a
   * question about a chart on screen). It is absent when ZLens cannot list
   * them — decide as if the values could have come from anywhere.
   */
  isInBoundary?(model: { id: string; name: string; model?: string; baseUrl?: string }, context?: DqlBoundaryContext): boolean;
  /**
   * Audit (RFC 0010 HH-6): one event per API request that changed something
   * or was refused, and one per finished answer. No result values. Without
   * it nothing is recorded; central audit is the host's. See `observability.ts`.
   */
  audit?: DqlAuditSink;
  /**
   * Every tool an agent runs inside the server (HH-7) — catalog lookups,
   * governed queries, SQL runs, `finish_answer` — passes here with the person
   * asking. Call `next()` to run it; return something else to reshape the
   * result; throw to refuse. Queries a tool runs still pass `rowPolicy`.
   */
  tools?(call: { name: string; args: unknown; principal: DqlPrincipal | null }, next: () => Promise<unknown>): Promise<unknown>;
  /**
   * Delivery (HH-8): the host's mail, Slack app or signed webhooks in place
   * of DQL's senders for digests and alerts.
   */
  delivery?: import('../schedule/notifiers/index.js').DeliverySink;
  /**
   * Signing (HH-8): a key service that signs exported snapshots with an
   * Ed25519 key it never hands out; exports then name who exported them.
   */
  signing?: import('../snapshot/app-snapshot.js').SnapshotSigner;
  /**
   * Git (HH-8): commits are authored as the signed-in person (when they have
   * an email); `openPullRequest` replaces the GitHub CLI for review requests.
   */
  git?: {
    openPullRequest?(input: { gitRoot: string; branch: string; base: string; title: string; body: string; principal: DqlPrincipal | null }): Promise<{ url: string }>;
  };
  /**
   * Whom answers are written for: a stakeholder (consumption only, no SQL or
   * authoring handoffs) or an analyst. With this hook the host decides per
   * person and the request body's `audience` is ignored; a hook error, or an
   * answer that is neither of the two, means stakeholder; undefined leaves
   * DQL's default.
   */
  audience?(principal: DqlPrincipal): Promise<'stakeholder' | 'analyst' | undefined> | 'stakeholder' | 'analyst' | undefined;
  /**
   * What the ZLens app shows around its own screens for this person (HH-9):
   * links to the host's own pages, the host's sign-out, and actions the host
   * offers on answers that need review (for example "Make this a certified
   * answer"). The app's screens stay DQL's; the host only adds to them.
   */
  ui?(principal: DqlPrincipal): Promise<DqlHostUi> | DqlHostUi;
  /**
   * Where the host's review of each answer stands, for answers this person
   * asked (HH-10): e.g. "Request R-142 · assigned to a reviewer" or "Checked
   * by a named reviewer". Shown beside the answer; the answer's own trust
   * label stays.
   */
  answerStatus?(principal: DqlPrincipal, runIds: string[]): Promise<Record<string, DqlAnswerStatus>> | Record<string, DqlAnswerStatus>;
  /**
   * HH-13: which certified sources this person may use — App Datasets
   * (`app:block:…`, `app:semantic:…`), certified blocks and metrics. Returns
   * the ids allowed; the rest are left out of Ask and refused on App tiles.
   * An error allows none. Without it, every certified source is usable.
   */
  sourceAccess?(principal: DqlPrincipal, sources: DqlSourceRef[]): Promise<Iterable<string>> | Iterable<string>;
  /**
   * HH-14: whether this person sees the figures of an Ask answer that needs
   * review. `withhold_review` gives them — and stores for them — the answer
   * without any value (what it is built on, its SQL and trust), until someone
   * checks it; certified and governed answers are unchanged. Only a clear
   * `show` shows: an error, or any answer that is not `show` (undefined, a
   * typo, another type), withholds.
   */
  answerFigures?(principal: DqlPrincipal): 'show' | 'withhold_review' | Promise<'show' | 'withhold_review'>;
  /**
   * Whether figures read from these tables can differ by who reads them: a
   * row rule, column policy or tag protection the host applies to one of
   * them. ZLens asks before an Ask answer's written text (the figures its
   * author saw) is saved into an App page as a static text tile, and refuses
   * it when the answer is yes: a live tile runs each reader's own rules.
   * `relations` absent: ZLens could not list every table the answer read; answer
   * as if it could be any table. An error means yes. Without this hook, a
   * host with `rowPolicy` or `credentials` is taken to mean yes.
   */
  figuresDependOnReader?(input: { relations?: string[] }): boolean | Promise<boolean>;
  /**
   * Whether this person still reads the text of an Ask answer published as a
   * static tile before `figuresDependOnReader` refused them (the people who
   * replace such tiles: an App's authors and stewards). Everyone else reads a
   * placeholder in its place, on the page and in every page run. An error
   * means no. Without this hook ZLens asks `authorize` for `app.author` on the
   * App, then `dataset.certify`.
   */
  keepsAnswerText?(principal: DqlPrincipal, input: { appId: string }): boolean | Promise<boolean>;
  /**
   * HH-15: the knowledge sources (read-only document servers, e.g.
   * Confluence) this person may use, each with this person's own auth
   * headers — never a shared key. ZLens reads them with its own MCP client, so
   * Ask and Research can cite documents with any model provider. With this
   * hook the host decides alone; an error means none. Without it, a host that
   * signs people in gives no knowledge sources, and `zlens notebook` without a
   * host reads the project's `.dql/mcp-servers.json` (`use: ["knowledge"]`).
   */
  knowledgeSources?(principal: DqlPrincipal): Promise<DqlKnowledgeServer[]> | DqlKnowledgeServer[];
  /**
   * HH-16: what the host adds to this person's Home — e.g. "Open requests":
   * each card a title and a few items with a status and a same-origin link.
   * Called only when Home opens. An error or nothing: no host cards.
   */
  homeCards?(principal: DqlPrincipal): Promise<DqlHomeCard[]> | DqlHomeCard[];
  /**
   * HH-16: the App pages each person follows, kept by the host so it can
   * tell them about each new edition (`pageEdition`) through their own
   * notification preferences. Without it, follows are this person's own
   * state in the project's private folder (`.dql/local/private/home/`).
   */
  follows?: DqlFollowStore;
  /**
   * HH-16: a scheduled run of a page gave a new edition (its governed figures
   * changed since the last scheduled run). Carries ids, titles and a
   * same-origin link — never a figure: a follower opens the page and sees it
   * as themselves, with their own row rules. Errors are ignored.
   */
  pageEdition?(edition: DqlPageEdition): Promise<void> | void;
  /**
   * HH-16: the identity-provider groups an author may name as an App's
   * audience (`audienceGroups` in dql.app.json). Without it the author types
   * group names; with it only these may be saved (an error: none may).
   */
  directoryGroups?(principal: DqlPrincipal): Promise<DqlDirectoryGroup[]> | DqlDirectoryGroup[];
  /** Each finished Ask trace, strictly redacted, as a bundle and as OTLP (HH-6). */
  traces?: DqlTraceSink;
  /**
   * A secret the host keeps stable for this workspace (for example derived
   * from its key service), under which question fingerprints leave in traces
   * (the sink above and OTLP): HMAC-SHA256, so they cannot be checked against
   * likely questions elsewhere. Without it ZLens makes one and keeps it in
   * `.dql/local/private/trace-salt`.
   */
  traceSalt?: string;
  /**
   * Where state lives (HH-6), for hosts that run several copies of DQL on
   * shared storage. Each defaults to today's SQLite file in the project.
   * Every method returns a Promise; ZLens awaits each call, so a store may be
   * a network database.
   */
  stores?: {
    runs?: DqlRunStore;
    memory?: (projectRoot: string) => DqlMemoryStore;
    conversations?: (defaultPath: string) => DqlConversationStore;
  };
  /**
   * Certify with every enterprise gate required (grain, outputs, pattern,
   * lineage, cadence). With a host, the host decides this, not the request.
   */
  enterpriseCertification?: boolean;
  /**
   * Only one person uses this server (a host's per-person sandbox), so the
   * server's own local state is theirs: a request may run on its local DuckDB
   * workspace (`executionTarget: { target: 'local' }`) and open private
   * drafts under `.dql/local/private/notebooks`. Otherwise everyone the server
   * serves would share them, so with a host both are refused (the server
   * chooses the connection; file routes serve project content only).
   */
  onePerson?: boolean;
  /**
   * Which of a table's columns this person may see listed (a column policy may
   * hide some): DQL's schema routes list only these. A hook that throws lists
   * none of the table's columns.
   */
  columnsVisible?(principal: DqlPrincipal, relation: string, columns: string[]): Promise<string[]> | string[];
  /**
   * Attributes the host sets on a principal for one request to say where its
   * values go (for example "for the model", "for a delivery"), not who the
   * person is. They stay in the keys of cached and proven results, so a result
   * read for one destination never serves another. They are left out only
   * when ZLens finds the person's own earlier run again: a question about a
   * chart on screen finds the chart that person ran.
   */
  purposeAttributes?: readonly string[];
  /**
   * HH-17: how Ask and Research screen questions for personal data about
   * individuals. `wording` (the default) refuses before planning by the
   * question's words: payment, health, contact and protected attributes. With
   * `columns` the host refuses by column instead: its `rowPolicy` refuses a
   * statement whose `destination` is `model` when it would list classified
   * columns for individuals, and aggregates stay answerable ("claims by
   * diagnosis"). Regulated identifiers (SSN, passport, date of birth) and one
   * person's pay are refused by wording either way.
   */
  sensitiveQuestions?: 'wording' | 'columns';
}

/** The host's additions to the ZLens app for one person (HH-9). */
export type DqlHostIcon = 'inbox' | 'requests' | 'review' | 'work' | 'health' | 'admin' | 'people' | 'git' | 'link';

export interface DqlAnswerStatus {
  state: 'requested' | 'in_progress' | 'checked' | 'certified' | 'declined';
  label: string;
  detail?: string;
  /** A same-origin page with the whole story, opened inside the app. */
  href?: string;
}

export interface DqlHostUi {
  /** Where "Sign out" goes. */
  signOutUrl?: string;
  /** Links to the host's own pages, in the person menu or the navigation. */
  /** `badge` is a count shown beside the link, e.g. reviews waiting; `icon` is one of DQL's. */
  links?: Array<{ id: string; label: string; href: string; placement: 'menu' | 'nav'; badge?: number; icon?: DqlHostIcon }>;
  /**
   * Offered on an answer that needs review. DQL posts
   * `{ runId, question, threadId?, trustState }` to `url` (same origin) and
   * shows the `message` the host answers with.
   */
  /**
   * Buttons on an answer. `on` says which answers get it: `review` (an AI
   * answer no certified source backs; the default), `unanswered` (ZLens could
   * not answer at all) and/or `answered` (a certified or governed answer —
   * e.g. "This looks wrong", shown quietly).
   */
  answerActions?: Array<{ id: string; label: string; url: string; description?: string; on?: Array<'review' | 'unanswered' | 'answered'> }>;
  /** A name for the environment, e.g. "Claims · Production". */
  environment?: string;
  /**
   * A strip above DQL's screens, for something the person must keep in mind
   * everywhere here — e.g. "Draft space — changes go to review, not
   * Production" — with up to three same-origin links (e.g. back to
   * Production). `caution` draws it in the warning colour.
   */
  banner?: DqlHostBanner;
  /**
   * Who DQL's screens speak to. `reader`: a person who reads and asks here but
   * does not build (a hosted stakeholder): the App library and Ask leave out
   * the single-user notebook's words (local drafts, private Apps, local files)
   * and say in plain words what an answer is built on. Absent: unchanged.
   */
  audience?: 'reader';
  /**
   * What an App link says when this project has no such App (with a host, the
   * App may be in another of its projects): plain words of at most 200
   * characters and, optionally, a same-origin link to go on. Absent: DQL's
   * own message.
   */
  appNotFound?: { message: string; next?: { label: string; href: string } };
}

/** `appNotFound` as ZLens passes it on: plain text, a same-origin link only. */
export function safeAppNotFound(value: unknown): { message: string; next?: { label: string; href: string } } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const message = typeof raw.message === 'string' ? raw.message.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  if (!message) return undefined;
  const next = safeNextLink(raw.next as DqlDecision['next']);
  return { message, ...(next ? { next: { label: next.label.slice(0, 40), href: next.href } } : {}) };
}

/** One card the host adds to a person's Home (HH-16), e.g. "Open requests". */
export interface DqlHomeCard {
  id: string;
  title: string;
  items: Array<{ id: string; title: string; status?: string; detail?: string; href?: string; tone?: 'info' | 'caution' | 'done' }>;
  /** Shown when there are no items, e.g. "Nothing waiting on you". */
  emptyText?: string;
  /** A same-origin page with all of them. */
  more?: { label: string; href: string };
}

/** A page someone follows (HH-16). No `pageId`: the App's home page. */
export interface DqlFollow {
  appId: string;
  pageId?: string;
  /** "Claims Weekly · Claims this week", for the host's notices. */
  title?: string;
  followedAt?: string;
}

/** Where a host keeps follows (HH-16). */
export interface DqlFollowStore {
  list(principal: DqlPrincipal): Promise<DqlFollow[]> | DqlFollow[];
  set(principal: DqlPrincipal, follow: DqlFollow, following: boolean): Promise<void> | void;
}

/** A page's new edition (HH-16): what and where, never a figure. */
export interface DqlPageEdition {
  appId: string;
  pageId: string;
  appTitle: string;
  pageTitle: string;
  /** Same-origin link that opens the page: `/?app=<id>&page=<id>`. */
  href: string;
  runId: string;
  at: string;
  /** Which schedule ran it, when ZLens knows. */
  scheduleId?: string;
}

/** An identity-provider group an author may pick as an App's audience (HH-16). */
export interface DqlDirectoryGroup {
  id: string;
  label?: string;
  members?: number;
}

const HOME_TONES = new Set(['info', 'caution', 'done']);
const sameOriginPath = (href: unknown): href is string => typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') && !href.includes('\\');
const plain = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A host's Home cards as ZLens passes them to the app: plain text, same-origin links, bounded. */
export function safeHomeCards(cards: unknown): DqlHomeCard[] {
  if (!Array.isArray(cards)) return [];
  const out: DqlHomeCard[] = [];
  for (const raw of cards.slice(0, 4)) {
    if (!raw || typeof raw !== 'object') continue;
    const card = raw as Record<string, unknown>;
    const id = plain(card.id, 60);
    const title = plain(card.title, 60);
    if (!id || !title) continue;
    const items = (Array.isArray(card.items) ? card.items : []).slice(0, 8).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      const itemTitle = plain(item.title, 160);
      if (!itemTitle) return [];
      const status = plain(item.status, 80);
      const detail = plain(item.detail, 200);
      return [{
        id: plain(item.id, 80) || itemTitle.slice(0, 80),
        title: itemTitle,
        ...(status ? { status } : {}),
        ...(detail ? { detail } : {}),
        ...(sameOriginPath(item.href) ? { href: item.href } : {}),
        ...(typeof item.tone === 'string' && HOME_TONES.has(item.tone) ? { tone: item.tone as 'info' | 'caution' | 'done' } : {}),
      }];
    });
    const emptyText = plain(card.emptyText, 120);
    const more = card.more && typeof card.more === 'object' ? card.more as Record<string, unknown> : undefined;
    out.push({
      id,
      title,
      items,
      ...(emptyText ? { emptyText } : {}),
      ...(more && sameOriginPath(more.href) && plain(more.label, 40) ? { more: { label: plain(more.label, 40), href: more.href } } : {}),
    });
  }
  return out;
}

/** The host's strip above DQL's screens (HH-9). */
export interface DqlHostBanner {
  text: string;
  tone?: 'info' | 'caution';
  links?: Array<{ label: string; href: string }>;
}

/** A host banner as ZLens passes it to the app: plain text, a known tone, same-origin links only. */
export function safeHostBanner(banner: unknown): DqlHostBanner | undefined {
  if (!banner || typeof banner !== 'object') return undefined;
  const raw = banner as Record<string, unknown>;
  const text = typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  if (!text) return undefined;
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .map((link) => safeNextLink(link as DqlDecision['next']))
    .filter((link): link is { label: string; href: string } => !!link)
    .slice(0, 3)
    .map((link) => ({ label: link.label.slice(0, 40), href: link.href }));
  return { text, tone: raw.tone === 'caution' ? 'caution' : 'info', ...(links.length ? { links } : {}) };
}

/** One warehouse statement, for metrics (HH-6): no SQL, parameters, rows or person. */
export interface DqlStatementEvent {
  at: string;
  driver: string;
  purpose: 'data' | 'metadata';
  /** `refused`: the row policy or the person's connection stopped it before it ran. */
  outcome: 'ok' | 'error' | 'refused';
  durationMs: number;
}
export type DqlStatementObserver = (event: DqlStatementEvent) => void | Promise<void>;

/**
 * The run store surface the server uses (HH-6). Every method returns a
 * Promise, so a host can keep runs in a shared database; ZLens awaits each
 * call. `dql-agent` exports the persisted form (`agentRunForStorage`,
 * `agentRunFromStorage`, the progress pair and `interruptedAgentRun`) so a
 * host store keeps the same records the SQLite store keeps.
 */
export type DqlRunStore = import('@zlens/agent').PromisedMethods<DqlRunStoreMethods>;
/** The same surface as ZLens calls it: its own SQLite store answers synchronously. */
export type DqlRunStoreLike = import('@zlens/agent').AwaitableMethods<DqlRunStoreMethods>;
type DqlRunStoreMethods = Pick<import('@zlens/agent').SqliteAgentRunStore, 'save' | 'get' | 'list' | 'getProgress' | 'saveProgress' | 'claimRequest' | 'requestClaim' | 'count'>;
/** The memory store surface (HH-6); every method returns a Promise. */
export type DqlMemoryStore = import('@zlens/agent').PromisedMethods<Pick<import('@zlens/agent').MemoryStore, 'upsert' | 'get' | 'list' | 'search' | 'setEnabled' | 'delete'>> & { close?(): Promise<void> };
/** The conversation store surface (HH-6); every method returns a Promise. */
export type DqlConversationStore = import('@zlens/agent').PromisedMethods<import('@zlens/agent').ConversationStoreMethods> & {
  pruneThreads?(olderThanDays: number): Promise<number>;
  close?(): Promise<void>;
};

/** The generate/stream surface ZLens needs from a model; dql-agent's AgentProvider satisfies it. */
export type DqlModelProvider = import('@zlens/agent').AgentProvider;

const requestContext = new AsyncLocalStorage<DqlRequestContext>();

/**
 * ONE PROCESS, SEVERAL SERVERS (RFC 0010). A host may run several ZLens servers
 * in one process — its Production and each pull request's preview, a server
 * without hooks beside them — each with its own hooks. Every request a server
 * answers, and the work it starts, runs in that server's scope, so the hooks
 * that govern it are always its own server's: the request context's hooks when
 * it names them, else its server's (none for a server without a host). The
 * process-wide values below are only for work outside every server (a host's
 * own call into DQL code), and they are a host's hooks only when every server
 * running in the process has the same ones; servers with different hooks leave
 * them empty, so such work never borrows one server's hooks for another's.
 */
export interface DqlServerScope {
  /** Unique per server start: keeps per-server state (such as "view as") apart. */
  readonly id: string;
  hooks?: DqlHostHooks;
}
const serverScope = new AsyncLocalStorage<DqlServerScope>();

/** Run `work` as the server `scope`'s own (ZLens does this around each request and its server's startup). */
export function withServerScope<T>(scope: DqlServerScope, work: () => T): T {
  return serverScope.run(scope, work);
}

/** The server the current work belongs to, if any. */
export function currentServerScope(): DqlServerScope | undefined {
  return serverScope.getStore();
}

/**
 * The hooks that govern the current work: `{ hooks }` (possibly none) when the work belongs to a server or a
 * request that names its hooks; undefined outside every server, where the process-wide values apply.
 */
export function scopedHostHooks(): { hooks: DqlHostHooks | undefined } | undefined {
  const context = requestContext.getStore();
  if (context?.hooks) return { hooks: context.hooks };
  const scope = serverScope.getStore();
  if (scope) return { hooks: scope.hooks };
  return undefined;
}

const liveServers = new Map<string, DqlHostHooks | undefined>();
/** A server started (with its hooks, or none); see `processHostHooks`. */
export function registerServerHooks(id: string, hooks: DqlHostHooks | undefined): void {
  liveServers.set(id, hooks);
}
/** A server stopped. */
export function unregisterServerHooks(id: string): void {
  liveServers.delete(id);
}
/**
 * The hooks for work outside every server: the one host's, when every server running in this process has the same
 * hooks; none when there is no server, or servers with different hooks (or a server without a host beside a hosted
 * one) run here.
 */
export function processHostHooks(): DqlHostHooks | undefined {
  const all = [...liveServers.values()];
  const first = all[0];
  return first && all.every((hooks) => hooks === first) ? first : undefined;
}

/** Whether any server running in this process has a host (for work outside every server that must take the safe side). */
export function anyHostedServer(): boolean {
  return [...liveServers.values()].some(Boolean);
}

let processToolHooks: DqlHostHooks['tools'] | undefined;
/** The tool gate's hook for work outside every server (process-wide fallback). */
export function setProcessToolHooks(tools: DqlHostHooks['tools'] | undefined): void {
  processToolHooks = tools;
}
/** The tool gate's hook for the current work: its server's (or request's), else the process-wide one. */
export function currentToolHooks(): DqlHostHooks['tools'] | undefined {
  const scoped = scopedHostHooks();
  return scoped ? scoped.hooks?.tools : processToolHooks;
}

/**
 * The host's model hooks for work outside every server (provider selection is
 * module-level); see `processHostHooks`.
 */
let hostModelHooks: Pick<DqlHostHooks, 'modelProvider' | 'isInBoundary'> = {};
export function setHostModelHooks(hooks: Pick<DqlHostHooks, 'modelProvider' | 'isInBoundary'> | undefined): void {
  hostModelHooks = { ...(hooks?.modelProvider ? { modelProvider: hooks.modelProvider } : {}), ...(hooks?.isInBoundary ? { isInBoundary: hooks.isInBoundary } : {}) };
}

let hostGitHooks: DqlHostHooks['git'] | undefined;
export function setHostGitHooks(hooks: DqlHostHooks['git'] | undefined): void {
  hostGitHooks = hooks;
}
export function currentHostGitHooks(): DqlHostHooks['git'] | undefined {
  const scoped = scopedHostHooks();
  return scoped ? scoped.hooks?.git : hostGitHooks;
}

/** The model hooks for the current work's server (none for a server without a host), else the process's. */
function modelHooks(): Pick<DqlHostHooks, 'modelProvider' | 'isInBoundary'> {
  const scoped = scopedHostHooks();
  if (!scoped) return hostModelHooks;
  const hooks = scoped.hooks;
  return { ...(hooks?.modelProvider ? { modelProvider: hooks.modelProvider } : {}), ...(hooks?.isInBoundary ? { isInBoundary: hooks.isInBoundary } : {}) };
}

/** `Name <email>` for the signed-in person, to author commits; undefined without an email. */
export function hostGitAuthor(): string | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host' || !principal.email) return undefined;
  const name = (principal.displayName || principal.email).replace(/[<>\n]/g, '').trim();
  return `${name} <${principal.email.replace(/[<>\s]/g, '')}>`;
}

export const HOST_MODEL_UNAVAILABLE = 'ZLens could not get the model your administrator set up, so it did not ask a model. Try again; if it keeps happening, ask your administrator.';

/** The host's model hook failed or answered something that is not a model: no model is used, not even the project's own. */
export class HostModelUnavailableError extends Error {
  readonly code = 'HOST_MODEL_UNAVAILABLE';
  constructor() {
    super(HOST_MODEL_UNAVAILABLE);
    this.name = 'HostModelUnavailableError';
  }
}

/**
 * The host's model for the person asking, if the host supplies one (HH-5). Undefined (the hook answers nothing, or
 * there is no hook) uses DQL's own provider settings. A hook that throws, or answers something other than
 * `{ id, provider }`, refuses: ZLens then asks no model at all rather than the project's own (HostModelUnavailableError).
 */
export function hostModelProvider(): { id: string; provider: DqlModelProvider } | undefined {
  const hook = modelHooks().modelProvider;
  if (!hook) return undefined;
  let answer: unknown;
  try {
    answer = hook({ principal: currentPrincipal() ?? null });
  } catch {
    throw new HostModelUnavailableError();
  }
  if (answer === undefined || answer === null) return undefined;
  const record = answer as { id?: unknown; provider?: unknown };
  if (typeof answer !== 'object' || typeof (answer as { then?: unknown }).then === 'function' || typeof record.id !== 'string' || !record.id.trim() || !record.provider || typeof record.provider !== 'object') {
    throw new HostModelUnavailableError();
  }
  return answer as { id: string; provider: DqlModelProvider };
}

/**
 * Whether result values may reach this model. The host decides when it has
 * a boundary rule (an error means no); otherwise only a model on this
 * machine qualifies.
 */
export function resultValuesMayReachModel(model: { id: string; name: string; model?: string; baseUrl?: string }, isLocal: () => boolean, context?: DqlBoundaryContext): boolean {
  const hooks = modelHooks();
  if (hooks.isInBoundary) {
    try {
      return hooks.isInBoundary(model, context?.relations ? { relations: [...context.relations] } : {}) === true;
    } catch {
      return false;
    }
  }
  return isLocal();
}

/** Run `work` as `context`; without a context, just run it. */
export function withRequestContext<T>(context: DqlRequestContext | undefined, work: () => T): T {
  return context ? requestContext.run(context, work) : work();
}

export function currentRequestContext(): DqlRequestContext | undefined {
  return requestContext.getStore();
}

/** The host-supplied person behind the current request, if any. */
export function currentPrincipal(): DqlPrincipal | undefined {
  return requestContext.getStore()?.principal;
}

/**
 * The name recorded for the person acting now, when a host said who that
 * is: their email, else their display name, else their id. Undefined when
 * no host is in charge, so callers keep their local behaviour.
 */
export function hostActor(): string | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host') return undefined;
  return principal.email?.trim() || principal.displayName?.trim() || principal.id;
}

/** The host's signed-in person's display name, for "Certified by <name>"; undefined without a host. */
export function hostActorDisplayName(): string | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host') return undefined;
  return principal.displayName?.trim() || undefined;
}

/**
 * Accept only a well-formed principal from a hook. Anything else — no id,
 * an unknown kind, a thrown error — refuses the request.
 */
export function normalizeHostPrincipal(value: unknown): DqlPrincipal | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const kind = raw.kind === 'service' ? 'service' : raw.kind === undefined || raw.kind === 'person' ? 'person' : null;
  if (!kind) return null;
  const text = (field: unknown) => (typeof field === 'string' && field.trim() ? field.trim() : undefined);
  const groups = Array.isArray(raw.groups) ? raw.groups.filter((group): group is string => typeof group === 'string' && group.trim().length > 0) : undefined;
  const attributes = raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes)
    ? raw.attributes as DqlPrincipal['attributes']
    : undefined;
  const email = text(raw.email);
  const displayName = text(raw.displayName);
  const appGrants = raw.appGrants && typeof raw.appGrants === 'object' && !Array.isArray(raw.appGrants)
    ? Object.fromEntries(Object.entries(raw.appGrants as Record<string, unknown>).filter((entry): entry is [string, 'read' | 'execute'] => entry[1] === 'read' || entry[1] === 'execute'))
    : undefined;
  return {
    id,
    kind,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(groups?.length ? { groups } : {}),
    ...(attributes ? { attributes } : {}),
    ...(appGrants && Object.keys(appGrants).length ? { appGrants } : {}),
    source: 'host',
  };
}

/** Ask the host who is asking; null when it refuses, errs, answers late or with something malformed. */
export async function resolveHostPrincipal(hooks: DqlHostHooks, req: IncomingMessage): Promise<DqlPrincipal | null> {
  return (await resolveHostPrincipalOutcome(hooks, req)).principal;
}

/** Shown when the host does not say in time who is asking (rule 1: a time limit, then a refusal). */
export const HOST_IDENTITY_UNAVAILABLE = 'ZLens could not check who you are right now. Try again in a moment.';
/** Shown when the host does not say in time whether this person may do this. */
export const HOST_DECISION_UNAVAILABLE = 'ZLens could not check what you may do right now. Try again in a moment.';

/**
 * Who is asking, and whether the host could not say in time (`unavailable`: the hook did not answer within its
 * deadline). Either way nobody is placed when the principal is null.
 */
export async function resolveHostPrincipalOutcome(hooks: DqlHostHooks, req: IncomingMessage): Promise<{ principal: DqlPrincipal | null; unavailable?: true }> {
  if (!hooks.resolvePrincipal) return { principal: null };
  try {
    return { principal: normalizeHostPrincipal(await hooks.resolvePrincipal(req)) };
  } catch (error) {
    return error instanceof HostHookTimeoutError ? { principal: null, unavailable: true } : { principal: null };
  }
}

/** Ask the host whether this request may go ahead; an error, a late answer or anything but `{ allow: true }` refuses. */
export async function authorizeHostRequest(hooks: DqlHostHooks, principal: DqlPrincipal, route: DqlRouteAction): Promise<DqlDecision> {
  if (!hooks.authorize) return { allow: true };
  try {
    const decision: unknown = await hooks.authorize(principal, route.action, route.resource);
    if (!decision || typeof decision !== 'object') return { allow: false };
    const answer = decision as Partial<DqlDecision>;
    if (answer.allow === true) return { allow: true };
    const reason = typeof answer.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : undefined;
    const next = safeNextLink(answer.next);
    return { allow: false, ...(reason ? { reason } : {}), ...(next ? { next } : {}), ...(answer.readOnly === true ? { readOnly: true } : {}) };
  } catch (error) {
    return error instanceof HostHookTimeoutError ? { allow: false, reason: HOST_DECISION_UNAVAILABLE } : { allow: false };
  }
}

/**
 * Whether an answer's figures, read from these tables, could differ for another reader (the host's
 * `figuresDependOnReader`). No host: no. A hook that errs: yes.
 */
export async function hostFiguresDependOnReader(hooks: DqlHostHooks | undefined, relations: string[] | undefined): Promise<boolean> {
  if (!hooks) return false;
  if (!hooks.figuresDependOnReader) return Boolean(hooks.rowPolicy || hooks.credentials);
  try {
    return (await hooks.figuresDependOnReader(relations ? { relations: [...relations] } : {})) !== false;
  } catch {
    return true;
  }
}

/**
 * ONE PERSONA PER PERSON, PER SERVER. "View as" (the App persona) is kept per
 * signed-in person on each server, so a steward previewing an App as a member
 * never changes what anyone else sees, and a persona chosen on one server
 * (Production) is not active on another in the same process (a preview).
 * Requests without a host principal keep the one process-wide persona, as
 * before.
 *
 * The slots live in memory, so they are bounded: at most
 * `PERSONA_SLOT_LIMIT` people keep one, and past that the least recently
 * used person's goes. That person then sees Apps as themselves again (the
 * default), never as anyone else.
 */
export const PERSONA_SLOT_LIMIT = 5_000;
const personaSlots = new Map<string, { value: unknown }>();
export function installHostPersonaSlots(
  registry: { useSlots(resolver: (() => { value: any } | undefined) | null): void },
  options: { limit?: number } = {},
): void {
  const limit = Math.max(1, Math.floor(options.limit ?? PERSONA_SLOT_LIMIT));
  registry.useSlots(() => {
    const principal = currentPrincipal();
    if (!principal || principal.source === 'local') return undefined;
    // Per server too: a persona chosen on one server (Production) is not active on another (a preview).
    const key = `${serverScope.getStore()?.id ?? ''}\u0000${principal.id}`;
    let slot = personaSlots.get(key);
    if (slot) {
      // Most recently used last.
      personaSlots.delete(key);
    } else {
      slot = { value: null };
    }
    personaSlots.set(key, slot);
    while (personaSlots.size > limit) {
      const oldest = personaSlots.keys().next().value;
      if (oldest === undefined) break;
      personaSlots.delete(oldest);
    }
    return slot;
  });
}

/** How many people keep a persona slot now (for tests and health checks). */
export function personaSlotCount(): number {
  return personaSlots.size;
}

/**
 * The person as App policies see them when they have not chosen an App
 * persona: their own groups and department, never the owner's full access.
 */
export function hostUserContext(): { userId: string; roles: string[]; department?: string } | undefined {
  const principal = currentPrincipal();
  const actor = hostActor();
  if (!principal || !actor) return undefined;
  const department = principal.attributes?.department;
  return {
    userId: actor,
    roles: [...(principal.groups ?? [])],
    ...(typeof department === 'string' ? { department } : {}),
  };
}

/**
 * Row-rule values for the signed-in person: `{user.id}`, `{user.email}`,
 * `{user.roles}` and each attribute as `{user.<name>}`. The person's values
 * win over anything a request passes, so nobody widens their own rows.
 */
export function hostPrincipalVariables(): Record<string, unknown> | undefined {
  const principal = currentPrincipal();
  const actor = hostActor();
  if (!principal || !actor) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(principal.attributes ?? {})) {
    out[`user.${key}`] = value;
    out[key] = value;
  }
  out['user.id'] = actor;
  out['user.userId'] = actor;
  if (principal.email) out['user.email'] = principal.email;
  out['user.roles'] = [...(principal.groups ?? [])];
  return out;
}

/**
 * What about the signed-in person can change query results, for cache and
 * proof keys. An export's results are read under the host's export rules
 * (HH-17), so they never share a key with what the person sees on screen.
 */
export function hostPrincipalPolicyIdentity(): Record<string, unknown> | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host') return undefined;
  const attributes = Object.fromEntries(Object.entries(principal.attributes ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  const destination = currentDestination();
  return { id: principal.id, groups: [...(principal.groups ?? [])].sort(), attributes, ...(destination === 'export' ? { destination } : {}) };
}

/**
 * Who the signed-in person is, for finding their own earlier run (a chart they
 * ran, asked about later): their id, groups and attributes, without where this
 * request's values go (the destination, the host's `purposeAttributes`). Never
 * a cache or proof key: those keep the destination apart.
 */
export function hostPrincipalRunOwner(): Record<string, unknown> | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host') return undefined;
  const purposes = new Set(purposeAttributeNames(currentHostHooks()?.purposeAttributes));
  const attributes = Object.fromEntries(Object.entries(principal.attributes ?? {})
    .filter(([name]) => !purposes.has(name))
    .sort(([left], [right]) => left.localeCompare(right)));
  return { id: principal.id, groups: [...(principal.groups ?? [])].sort(), attributes };
}

/** The host's `purposeAttributes` as ZLens reads them: a list of names; anything else names none. */
export function purposeAttributeNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string' && name.length > 0) : [];
}

/** Where the current request's statements' results go (HH-17); undefined outside a request. */
export function currentDestination(): DqlDestination | undefined {
  const context = requestContext.getStore();
  return context?.destination ?? destinationForAction(context?.action);
}
