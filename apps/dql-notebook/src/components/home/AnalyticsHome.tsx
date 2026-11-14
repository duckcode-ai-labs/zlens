import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useHostUi } from '../../host/host-ui';
import { useShallow } from 'zustand/react/shallow';
import { Plus, MessageSquare, Trash2, Loader2, ShieldCheck, Star, Pencil } from 'lucide-react';
import {
  api,
  type AgentConversationThread,
  type AgentConversationThreadListResponse,
} from '../../api/client';
import { makeCell, useDispatch, useNotebookStore } from '../../store/NotebookStore';
import type { Cell } from '../../store/types';
import { initialDomainScope, persistDomainScope, type DomainScope } from './domain-scope';
import { AskScopePicker } from './AskScopePicker';
import { themes, type Theme } from '../../themes/notebook-theme';
import { focusInsertedNotebookCell } from '../../utils/notebook-cell-focus';
import { askLocationHref, askThreadIdFromLocation } from './ask-location';
import {
  correctionProvenanceForDraft,
  useOpenAnswerInNotebook,
} from '../../utils/answer-to-notebook';
import {
  UnifiedAgentRunPanel,
  type InsertDqlPayload,
  type SqlNotebookDraftMeta,
  type ThreadItem,
} from '../agent/UnifiedAgentRunPanel';
import { isSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';

// A Home that summarises (RFC 0010 HH-16) loads after Ask, never before it.
const HomeSummary = React.lazy(() => import('./HomeSummary').then((module) => ({ default: module.HomeSummary })));

/**
 * Analytics Home — the stakeholder ChatGPT-style entry. Text→SQL questions run
 * through the governed agent loop; answers, research reports, and app drafts render
 * as rich messages. Authoring stays in the Notebook; this surface is consumption.
 *
 * Conversations are persisted locally (per browser) so a stakeholder can start a
 * new chat, browse past chats, and resume one — like ChatGPT. The agent runs
 * themselves are already governed + stored server-side; this just keeps the
 * conversation threads grouped and resumable.
 */

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: ThreadItem[];
  /** Server-side conversation thread id — the runs' turns persist server-side too. */
  threadId?: string;
  /** Pinned by the user; pinned chats are listed in their own group. */
  favorite?: boolean;
  /** The user renamed this chat; a later turn never re-derives the title. */
  titleCustomized?: boolean;
}

const STORAGE_KEY = 'dql-ask-conversations';
const ACTIVE_CONVERSATION_STORAGE_KEY = 'dql-ask-active-conversation';
const DELETED_THREAD_STORAGE_KEY = 'dql-ask-deleted-thread-queue';
const PROJECT_IDENTITY_STORAGE_KEY = 'dql-ask-conversation-project-identity-v1';
const MAX_CONVERSATIONS = 100;

/**
 * The Ask trace is the local, addressable Research evidence surface. Keep the
 * focus as presentation-only URL state: the store persists only the run ID and
 * never copies Research payloads into browser navigation.
 */
export function askResearchTracePath(runId: string): string {
  return `/ask/traces/${encodeURIComponent(runId)}?focus=research`;
}

/**
 * Navigate an Ask Research artifact to the same local trace evidence used by
 * the normal Ask run. Keeping this as a small pure seam lets the button remain
 * a native keyboard-accessible control while the dispatch and addressable URL
 * behavior are covered without rendering a whole Notebook shell in a test.
 */
export function openAskResearchTrace(input: {
  sourceAskRunId: string;
  dispatch: (action: { type: 'OPEN_ASK_TRACE'; runId: string }) => void;
  history?: Pick<History, 'replaceState'>;
}): void {
  input.dispatch({ type: 'OPEN_ASK_TRACE', runId: input.sourceAskRunId });
  const history = input.history ?? (typeof window !== 'undefined' ? window.history : undefined);
  history?.replaceState(
    { askTraceRunId: input.sourceAskRunId, focus: 'research' },
    '',
    askResearchTracePath(input.sourceAskRunId),
  );
}

function askNotebookCellName(value: string | undefined): string {
  const clean = (value ?? 'AI analysis')
    .replace(/[^a-zA-Z0-9_ -]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return clean || 'ai_analysis';
}

/** Build the exact editable Notebook cell used by Ask failure-repair handoffs. */
export function askNotebookCellFromPayload(payload: InsertDqlPayload): Cell | undefined {
  const dqlSource = payload.dqlArtifact?.source?.trim();
  const sql = payload.sql?.trim();
  const content = dqlSource || sql;
  if (!content) return undefined;
  const cell = makeCell(dqlSource ? 'dql' : 'sql', content);
  cell.name = askNotebookCellName(payload.title ?? payload.dqlArtifact?.name);
  if (payload.result) {
    cell.result = payload.result;
    cell.status = 'success';
    cell.executionCount = 1;
  }
  if (payload.chartConfig) cell.chartConfig = payload.chartConfig;
  cell.correctionProvenance = correctionProvenanceForDraft({
    question: payload.question,
    generatedSql: payload.sql ?? payload.dqlArtifact?.compiledSql,
    generatedDql: dqlSource,
    sourceRunId: payload.sourceRunId,
  });
  if (payload.dqlArtifact) {
    cell.dqlArtifact = {
      source: payload.dqlArtifact.source,
      sql: payload.sql,
      name: payload.dqlArtifact.name,
      sourcePath: payload.dqlArtifact.sourcePath,
      kind: payload.dqlArtifact.kind,
      metrics: payload.dqlArtifact.metrics,
      dimensions: payload.dqlArtifact.dimensions,
      parameters: payload.dqlArtifact.parameters,
      parameterValues: payload.dqlArtifact.parameterValues,
      persistence: payload.dqlArtifact.persistence,
      trustState: payload.dqlArtifact.trustState,
      compiledSql: payload.dqlArtifact.compiledSql ?? payload.sql,
      reviewState: payload.dqlArtifact.trustState === 'certified' ? 'certified' : 'review_required',
      ...(payload.question ? { question: payload.question } : {}),
    };
    cell.dqlParameterValues = payload.dqlArtifact.parameterValues;
  }
  return cell;
}

function makeConversationId(): string {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function recoveredConversationId(threadId: string): string {
  return `conv_server_${threadId}`;
}

/**
 * Browser storage is only a rendering cache. Rebuild the sidebar from durable
 * project threads so a new port, browser profile, or frontend upgrade does not
 * make existing conversations appear to be gone.
 */
export function mergePersistedAskConversations(
  local: Conversation[],
  threads: AgentConversationThread[],
  deletedThreadIds: ReadonlySet<string> = new Set(),
  options: { retainCachedItems?: boolean } = {},
): Conversation[] {
  const visibleThreads = threads.filter((thread) => !deletedThreadIds.has(thread.id));
  const localByThread = options.retainCachedItems === false
    ? new Map<string, Conversation>()
    : new Map(
      local.flatMap((conversation) => conversation.threadId ? [[conversation.threadId, conversation] as const] : []),
    );
  const recovered = visibleThreads.map((thread): Conversation => {
    const existing = localByThread.get(thread.id);
    return {
      id: existing?.id ?? recoveredConversationId(thread.id),
      // A server title is authoritative: it is what the user typed when they
      // renamed the chat. Only fall back to the local one when the server has
      // none (a thread whose title was never set).
      title: thread.title?.trim()
        || (existing?.title && existing.title !== 'New chat' ? existing.title : 'Recovered chat'),
      createdAt: existing?.createdAt ?? thread.createdAt,
      updatedAt: thread.updatedAt > (existing?.updatedAt ?? '') ? thread.updatedAt : existing?.updatedAt ?? thread.updatedAt,
      items: existing?.items ?? [],
      threadId: thread.id,
      favorite: thread.favorite ?? existing?.favorite ?? false,
      ...(existing?.titleCustomized ? { titleCustomized: true } : {}),
    };
  });
  // A successful server list is the authority for thread membership. Browser
  // storage may make a response feel instant while this request is in flight,
  // but it may never keep an unmatched thread/answer alive after reconciliation.
  return recovered
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_CONVERSATIONS);
}

/**
 * Boundary captured immediately before the initial durable-thread list starts.
 * It lets the response replace pre-existing browser cache without erasing a
 * genuinely new Ask conversation whose create/submit began while that request
 * was in flight.
 */
export interface AskConversationListSnapshot {
  conversationIds: ReadonlySet<string>;
  threadIdsByConversationId: ReadonlyMap<string, string | undefined>;
  /** Stable item identities from the browser cache before the list began. */
  itemFingerprintsByConversationId: ReadonlyMap<string, ReadonlySet<string>>;
}

function askConversationItemFingerprint(item: ThreadItem): string {
  // A `ThreadItem` is append-only. These IDs are enough to calculate an
  // in-memory boundary delta without retaining question/result text in the
  // snapshot or exposing it to tracing/persistence.
  return item.kind === 'user'
    ? `user:${item.id}`
    : `run:${item.id}:${item.run.id}`;
}

export function snapshotAskConversationList(conversations: readonly Conversation[]): AskConversationListSnapshot {
  return {
    conversationIds: new Set(conversations.map((conversation) => conversation.id)),
    threadIdsByConversationId: new Map(
      conversations.map((conversation) => [conversation.id, conversation.threadId] as const),
    ),
    itemFingerprintsByConversationId: new Map(
      conversations.map((conversation) => [
        conversation.id,
        new Set(conversation.items.map(askConversationItemFingerprint)),
      ] as const),
    ),
  };
}

function postRequestAskConversationCreations(input: {
  local: readonly Conversation[];
  requestSnapshot?: AskConversationListSnapshot;
  requestEpoch?: number;
  mutationEpochByConversationId?: ReadonlyMap<string, number>;
}): Conversation[] {
  const { requestSnapshot, requestEpoch, mutationEpochByConversationId } = input;
  if (!requestSnapshot || requestEpoch === undefined || !mutationEpochByConversationId) return [];
  return input.local.flatMap((conversation) => {
    const mutationEpoch = mutationEpochByConversationId.get(conversation.id);
    if (mutationEpoch === undefined || mutationEpoch <= requestEpoch) return [];
    if (!requestSnapshot.conversationIds.has(conversation.id)) return [conversation];

    // A browser-created starter may exist before the list begins. Its server
    // thread is nevertheless new if assignment completed after the boundary.
    // Do not carry its old rendered transcript across a project boundary: keep
    // only items whose stable identity did not exist at request start.
    const threadIdAtRequest = requestSnapshot.threadIdsByConversationId.get(conversation.id);
    if (!conversation.threadId || conversation.threadId === threadIdAtRequest) return [];
    const itemFingerprintsAtRequest = requestSnapshot.itemFingerprintsByConversationId.get(conversation.id) ?? new Set<string>();
    const postBoundaryItems = conversation.items.filter((item) =>
      !itemFingerprintsAtRequest.has(askConversationItemFingerprint(item)));
    return [{
      // This is a clean shell for the newly bound project-B thread. It must not
      // retain project-A title, favorite state, questions, answers, or result
      // rows merely because the browser reused the same local conversation id.
      id: conversation.id,
      title: deriveTitle(postBoundaryItems),
      createdAt: conversation.updatedAt,
      updatedAt: conversation.updatedAt,
      items: postBoundaryItems,
      threadId: conversation.threadId,
    }];
  });
}

function mergePostRequestAskConversationCreations(
  authoritative: Conversation[],
  creations: Conversation[],
): Conversation[] {
  const merged = [...authoritative];
  for (const creation of creations) {
    const existingIndex = merged.findIndex((conversation) =>
      conversation.id === creation.id
      || Boolean(conversation.threadId && creation.threadId && conversation.threadId === creation.threadId));
    if (existingIndex === -1) {
      merged.push(creation);
      continue;
    }

    const existing = merged[existingIndex];
    const serverTitleIsSpecific = existing.title !== 'Recovered chat' && existing.title !== 'New chat';
    merged[existingIndex] = {
      ...existing,
      id: creation.id,
      title: serverTitleIsSpecific ? existing.title : creation.title,
      createdAt: creation.createdAt < existing.createdAt ? creation.createdAt : existing.createdAt,
      updatedAt: creation.updatedAt > existing.updatedAt ? creation.updatedAt : existing.updatedAt,
      items: creation.items.length > 0 ? creation.items : existing.items,
      threadId: creation.threadId ?? existing.threadId,
      favorite: existing.favorite ?? creation.favorite,
      ...(existing.titleCustomized || creation.titleCustomized ? { titleCustomized: true } : {}),
    };
  }
  return merged
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_CONVERSATIONS);
}

export interface AskConversationCacheReconciliation {
  conversations: Conversation[];
  activeId: string;
  /** Whether it was safe to reuse locally rendered items for matching threads. */
  cacheIdentityMatches: boolean;
  /** Clear stale browser Ask state and remount the current panel. */
  resetBrowserCache: boolean;
}

/**
 * The initial sidebar request is deliberately a small injectable seam. It is
 * used by AnalyticsHome and lets the race regression exercise a real deferred
 * list API response rather than only a static reconciliation helper.
 */
export async function hydrateInitialAskConversationList(input: {
  listAgentThreads: (options: { limit: number }) => Promise<AgentConversationThreadListResponse>;
  requestSnapshot: AskConversationListSnapshot;
  requestEpoch: number;
  deletedAtRequestStart: ReadonlySet<string>;
  getDeletedThreadIds: () => ReadonlySet<string>;
  getConversations: () => Conversation[];
  getActiveId: () => string;
  getTabHadBinding?: () => boolean;
  getMutationEpochByConversationId: () => ReadonlyMap<string, number>;
  getCachedProjectIdentity: () => string | undefined;
  createConversationId?: () => string;
}): Promise<{ projectIdentity?: string; reconciliation: AskConversationCacheReconciliation }> {
  const { threads, projectIdentity } = await input.listAgentThreads({ limit: MAX_CONVERSATIONS });
  // New clients label Ask threads explicitly. Older Ask threads used the
  // generic notebook label without a notebook path, so include those for
  // lossless upgrade recovery.
  const askThreads = threads.filter((thread) =>
    thread.surface === 'ask'
    || (thread.surface === 'notebook' && !thread.notebookPath));
  const deletedThreadIds = new Set([
    ...input.deletedAtRequestStart,
    ...input.getDeletedThreadIds(),
  ]);
  const visibleAskThreads = askThreads.filter((thread) => !deletedThreadIds.has(thread.id));
  return {
    projectIdentity,
    reconciliation: reconcileAskConversationCache({
      local: input.getConversations(),
      threads: visibleAskThreads,
      activeId: input.getActiveId(),
      activeThreadId: input.getConversations().find((conversation) => conversation.id === input.getActiveId())?.threadId,
      tabHadBinding: input.getTabHadBinding?.() ?? false,
      deletedThreadIds,
      cachedProjectIdentity: input.getCachedProjectIdentity(),
      serverProjectIdentity: projectIdentity,
      requestSnapshot: input.requestSnapshot,
      requestEpoch: input.requestEpoch,
      mutationEpochByConversationId: input.getMutationEpochByConversationId(),
      createConversationId: input.createConversationId,
    }),
  };
}

/**
 * Reconcile the temporary browser cache against one successful local runtime
 * response. A browser origin is not a project boundary: a new `zlens notebook`
 * process can serve a different project at the same origin. Treat an absent,
 * changed, or malformed identity as untrusted rather than reusing old rows.
 */
export function reconcileAskConversationCache(input: {
  local: Conversation[];
  threads: AgentConversationThread[];
  activeId: string;
  /** The server thread the active chat had, so a rewritten conversation id still resolves. */
  activeThreadId?: string;
  /** This tab had a chat of its own (URL thread or per-tab pointer): on a miss it gets a new empty chat, never the newest one. */
  tabHadBinding?: boolean;
  deletedThreadIds?: ReadonlySet<string>;
  cachedProjectIdentity?: string;
  serverProjectIdentity?: string;
  createConversationId?: () => string;
  /** Snapshot + epoch from before the durable list request began. */
  requestSnapshot?: AskConversationListSnapshot;
  requestEpoch?: number;
  mutationEpochByConversationId?: ReadonlyMap<string, number>;
}): AskConversationCacheReconciliation {
  const cachedProjectIdentity = normalizeAskConversationProjectIdentity(input.cachedProjectIdentity);
  const serverProjectIdentity = normalizeAskConversationProjectIdentity(input.serverProjectIdentity);
  const cacheIdentityMatches = Boolean(
    cachedProjectIdentity
    && serverProjectIdentity
    && cachedProjectIdentity === serverProjectIdentity,
  );
  const authoritativeConversations = mergePersistedAskConversations(
    input.local,
    input.threads,
    input.deletedThreadIds,
    { retainCachedItems: cacheIdentityMatches },
  );
  // Only creations proven to have happened after this request started are
  // allowed to survive a stale list response. This does not re-authorize the
  // pre-existing browser cache after an empty/different-project response.
  const conversations = mergePostRequestAskConversationCreations(
    authoritativeConversations,
    postRequestAskConversationCreations(input),
  );
  const byThread = input.activeThreadId ? conversations.find((conversation) => conversation.threadId === input.activeThreadId)?.id : undefined;
  const activeId = conversations.some((conversation) => conversation.id === input.activeId)
    ? input.activeId
    : byThread
      ?? (input.tabHadBinding ? undefined : conversations[0]?.id)
      ?? (input.createConversationId ?? makeConversationId)();
  return {
    conversations,
    activeId,
    cacheIdentityMatches,
    // An empty Ask list is authoritative too: it must clear a stale sidebar,
    // selected panel, and rendered answer cache from a prior local runtime.
    resetBrowserCache: !cacheIdentityMatches || authoritativeConversations.length === 0,
  };
}

/** Prevent an unmounted or explicitly revoked Ask panel from writing state. */
export function isAskConversationPanelCallbackCurrent(input: {
  callbackConversationId: string;
  callbackEpoch: number;
  activeConversationId: string;
  activeEpoch: number;
  revokedPanelKeys: ReadonlySet<string>;
}): boolean {
  const callbackKey = `${input.callbackConversationId}:${input.callbackEpoch}`;
  return input.callbackConversationId === input.activeConversationId
    && input.callbackEpoch === input.activeEpoch
    && !input.revokedPanelKeys.has(callbackKey);
}

/**
 * Pure callback application seam so a late thread-create callback cannot add
 * a conversation once the panel which created it has been unmounted/revoked.
 */
export function applyAskThreadIdCallback(input: {
  conversations: Conversation[];
  callbackConversationId: string;
  callbackEpoch: number;
  activeConversationId: string;
  activeEpoch: number;
  revokedPanelKeys: ReadonlySet<string>;
  threadId: string;
  now?: string;
}): Conversation[] {
  if (!isAskConversationPanelCallbackCurrent(input)) return input.conversations;
  const existing = input.conversations.find((conversation) => conversation.id === input.callbackConversationId);
  if (existing?.threadId === input.threadId) return input.conversations;
  const now = input.now ?? new Date().toISOString();
  if (!existing) {
    return [{
      id: input.callbackConversationId,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      items: [],
      threadId: input.threadId,
    }, ...input.conversations].slice(0, MAX_CONVERSATIONS);
  }
  return input.conversations.map((conversation) => conversation.id === input.callbackConversationId
    ? { ...conversation, threadId: input.threadId, updatedAt: now }
    : conversation);
}

/** Apply a panel item callback only while that panel is still current. */
export function applyAskItemsCallback(input: {
  conversations: Conversation[];
  callbackConversationId: string;
  callbackEpoch: number;
  activeConversationId: string;
  activeEpoch: number;
  revokedPanelKeys: ReadonlySet<string>;
  items: ThreadItem[];
  now?: string;
}): Conversation[] {
  if (input.items.length === 0 || !isAskConversationPanelCallbackCurrent(input)) return input.conversations;
  const existing = input.conversations.find((conversation) => conversation.id === input.callbackConversationId);
  // A re-report on mount (resuming) carries the same length — don't reorder.
  if (existing && existing.items.length >= input.items.length) return input.conversations;
  const now = input.now ?? new Date().toISOString();
  const conversation: Conversation = {
    id: input.callbackConversationId,
    // A title the user typed is theirs; only a derived title follows the turns.
    title: existing?.titleCustomized && existing.title.trim() ? existing.title : deriveTitle(input.items),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    items: input.items,
    threadId: existing?.threadId,
    favorite: existing?.favorite,
    ...(existing?.titleCustomized ? { titleCustomized: true } : {}),
  };
  return [conversation, ...input.conversations.filter((entry) => entry.id !== input.callbackConversationId)]
    .slice(0, MAX_CONVERSATIONS);
}

function normalizeAskConversationProjectIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
    ? value
    : undefined;
}

function loadAskConversationProjectIdentity(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return normalizeAskConversationProjectIdentity(window.localStorage.getItem(PROJECT_IDENTITY_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

function persistAskConversationProjectIdentity(identity: string | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    const normalized = normalizeAskConversationProjectIdentity(identity);
    if (normalized) window.localStorage.setItem(PROJECT_IDENTITY_STORAGE_KEY, normalized);
    else window.localStorage.removeItem(PROJECT_IDENTITY_STORAGE_KEY);
  } catch {
    // This only governs an optional rendering cache. The local runtime remains
    // authoritative even if browser storage is unavailable.
  }
}

/** Clear only Ask rendering state. The shared `dql-theme` contract is untouched. */
function clearAskConversationBrowserCache(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    // The per-tab pointer is this tab's identity, not shared cache; the
    // reconciliation that ordered the reset has already chosen this tab's chat.
    window.localStorage.removeItem(DELETED_THREAD_STORAGE_KEY);
    window.localStorage.removeItem(PROJECT_IDENTITY_STORAGE_KEY);
  } catch {
    // A later successful server response still replaces in-memory history.
  }
}

function loadDeletedThreadIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DELETED_THREAD_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistDeletedThreadIds(ids: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DELETED_THREAD_STORAGE_KEY, JSON.stringify([...ids].slice(-MAX_CONVERSATIONS)));
  } catch {
    // The queue is a race-safety layer; server deletion remains authoritative.
  }
}

function queueDeletedThreadId(threadId: string): void {
  const ids = loadDeletedThreadIds();
  ids.add(threadId);
  persistDeletedThreadIds(ids);
}

function clearDeletedThreadId(threadId: string): void {
  const ids = loadDeletedThreadIds();
  ids.delete(threadId);
  persistDeletedThreadIds(ids);
}

// Defensive: persisted/edited runs from any source must have the arrays RunCard
// reads (nextActions/artifacts/evaluations/steps) or rendering throws on resume.
function normalizeItems(items: unknown): ThreadItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((it) => {
    if (!it || typeof it !== 'object') return [];
    const item = it as Record<string, unknown>;
    if (item.kind === 'run' && item.run && typeof item.run === 'object') {
      const run = item.run as Record<string, unknown>;
      run.nextActions = Array.isArray(run.nextActions) ? run.nextActions : [];
      run.artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
      run.evaluations = Array.isArray(run.evaluations) ? run.evaluations : [];
      run.steps = Array.isArray(run.steps) ? run.steps : [];
    }
    return [it as ThreadItem];
  });
}

function loadConversations(): Conversation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const deletedThreadIds = loadDeletedThreadIds();
    return (parsed as Conversation[])
      .filter((conversation) => !conversation.threadId || !deletedThreadIds.has(conversation.threadId))
      .map((c) => ({ ...c, items: normalizeItems(c.items) }));
  } catch {
    return [];
  }
}

/**
 * Which chat a tab reopens: its own last selection (session storage is
 * per tab), then the browser-wide last selection as a fallback for a new
 * tab. Two tabs never overwrite each other's place.
 */
export function resolveActiveConversationId(
  stored: { url?: string | null; tab?: string | null; shared?: string | null },
  known: ReadonlySet<string>,
  byThread: ReadonlyMap<string, string> = new Map(),
): string | undefined {
  const fromUrl = stored.url ? byThread.get(stored.url) : undefined;
  if (fromUrl && known.has(fromUrl)) return fromUrl;
  if (stored.tab && known.has(stored.tab)) return stored.tab;
  if (stored.shared && known.has(stored.shared)) return stored.shared;
  return undefined;
}

/**
 * A URL that names a thread the browser cache does not hold is a PENDING
 * identity, not an unknown one: the link may have been opened in another
 * browser, or the cache may have been cleared, while the thread itself lives
 * on the server. The tab seeds a placeholder chat carrying that thread so
 * reconciliation can map it by thread id, and so the URL is never rewritten
 * to a fresh empty chat before the server has answered.
 */
export function seedPendingThreadConversation(
  conversations: Conversation[],
  threadId: string | undefined,
  now: () => string = () => new Date().toISOString(),
  createId: () => string = makeConversationId,
): { conversations: Conversation[]; activeId?: string } {
  if (!threadId) return { conversations };
  const existing = conversations.find((conversation) => conversation.threadId === threadId);
  if (existing) return { conversations, activeId: existing.id };
  const stamp = now();
  const placeholder: Conversation = { id: createId(), title: 'Restoring chat…', createdAt: stamp, updatedAt: stamp, items: [], threadId };
  return { conversations: [placeholder, ...conversations], activeId: placeholder.id };
}

/** What this tab already knew about its chat before the server list arrived. */
function readTabBinding(): { url?: string; tab: string | null } {
  if (typeof window === 'undefined') return { tab: null };
  let tab: string | null = null;
  try { tab = window.sessionStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY); } catch { /* per-tab memory unavailable */ }
  return { url: askThreadIdFromLocation(window.location), tab };
}

function loadActiveConversationId(conversations: Conversation[]): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const { url, tab } = readTabBinding();
  let shared: string | null = null;
  try { shared = window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY); } catch { /* best-effort */ }
  const known = new Set(conversations.map((conversation) => conversation.id));
  const byThread = new Map(conversations.flatMap((conversation) => conversation.threadId ? [[conversation.threadId, conversation.id] as const] : []));
  return resolveActiveConversationId({ url, tab, shared }, known, byThread);
}

// Strip fields that only matter during a LIVE run before writing to disk. Event
// streams (and their payloads) dominate the serialized size and blow the
// localStorage quota after a handful of chats — which used to silently drop the
// answer cards from history. Answers themselves are recoverable from the
// server-persisted thread (threadId), so the local copy is a fast-path cache.
function slimForPersist(conversations: Conversation[]): Conversation[] {
  return conversations.map((conversation) => ({
    ...conversation,
    items: conversation.items.map((item) =>
      item.kind === 'run' ? { ...item, run: { ...item.run, events: [] } } : item,
    ),
  }));
}

// Returns the set actually persisted, so callers keep in-memory state in sync with
// disk (a quota fallback writes fewer than it was given — don't keep 40 in memory).
function persistConversations(conversations: Conversation[]): Conversation[] {
  const capped = conversations.slice(0, MAX_CONVERSATIONS);
  if (typeof window === 'undefined') return capped;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slimForPersist(capped)));
    return capped;
  } catch {
    // Quota exceeded (large result payloads) — keep only the most recent few.
    const trimmed = capped.slice(0, 8);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slimForPersist(trimmed)));
    } catch {
      /* give up — history is best-effort; answers remain on the server thread */
    }
    return trimmed;
  }
}

function deriveTitle(items: ThreadItem[]): string {
  const firstUser = items.find((item) => item.kind === 'user');
  const text = firstUser && firstUser.kind === 'user' ? firstUser.text.trim() : '';
  if (!text) return 'New chat';
  return text.length > 48 ? `${text.slice(0, 48).trimEnd()}…` : text;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString();
}

export type AskHistoryVerificationState = 'pending' | 'verified' | 'unavailable';

/**
 * Ask must not render a browser-cached conversation until the local runtime
 * confirms both durable thread state and the active project identity. Keeping
 * this gate outside UnifiedAgentRunPanel also prevents stale thread hydration
 * requests before that verification completes.
 */
export function AskHistoryVerificationGate({
  state,
  t,
  onRetry,
  children,
}: {
  state: AskHistoryVerificationState;
  t: Theme;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (state === 'verified') return <>{children}</>;
  const unavailable = state === 'unavailable';
  return (
    <section
      data-ask-history-verification={state}
      aria-busy={!unavailable}
      aria-live="polite"
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 16,
        padding: 32,
        color: t.textSecondary,
      }}
    >
      <div style={{ width: 'min(680px, 100%)', display: 'grid', gap: 10 }} aria-hidden="true">
        <div style={{ height: 18, width: '31%', borderRadius: 6, background: `${t.textPrimary}10` }} />
        <div style={{ height: 12, width: '82%', borderRadius: 6, background: `${t.textPrimary}0b` }} />
        <div style={{ height: 12, width: '65%', borderRadius: 6, background: `${t.textPrimary}0b` }} />
      </div>
      <div style={{ width: 'min(680px, 100%)', padding: 14, borderRadius: 12, border: `1px solid ${t.headerBorder}`, background: t.cellBg }}>
        <input
          disabled
          aria-label="Ask composer unavailable while history is verified"
          placeholder={unavailable ? 'Conversation history is unavailable' : 'Verifying conversation history…'}
          style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', color: t.textMuted, fontSize: 14 }}
        />
      </div>
      {unavailable ? (
        <>
          <p style={{ margin: 0, maxWidth: 560, textAlign: 'center', fontSize: 13, lineHeight: 1.5 }}>
            Conversation history could not be verified from the local runtime. Cached conversations are hidden until it is available.
          </p>
          <button
            type="button"
            onClick={onRetry}
            style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${t.accent}`, background: t.accent, color: 'var(--accent-fg)', fontWeight: 650, cursor: 'pointer' }}
          >
            Retry history verification
          </button>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: 13 }}>Verifying this project’s conversation history…</p>
      )}
    </section>
  );
}

export function AnalyticsHome() {
  const state = useNotebookStore(useShallow((store) => ({
    activeFile: store.activeFile,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const openAnswerInNotebook = useOpenAnswerInNotebook();
  const t = themes[state.themeMode];
  const [domainContext, setDomainContext] = useState<DomainScope | undefined>(() => initialDomainScope());

  // A tab that arrives on /ask?thread=… keeps that identity through hydration.
  const pendingThreadIdRef = React.useRef<string | undefined>(typeof window === 'undefined' ? undefined : askThreadIdFromLocation(window.location));
  // useRef is not lazy: seeding through useState keeps the browser cache from
  // being parsed again on every render of a long conversation.
  const [seeded] = useState(() => seedPendingThreadConversation(loadConversations(), pendingThreadIdRef.current));
  const [conversations, setConversations] = useState<Conversation[]>(() => seeded.conversations);
  const conversationsRef = React.useRef(conversations);
  const [historyVerificationState, setHistoryVerificationState] = useState<AskHistoryVerificationState>('pending');
  const [historyRequestNonce, setHistoryRequestNonce] = useState(0);
  const historyVerified = historyVerificationState === 'verified';
  const [conversationEpoch, setConversationEpoch] = useState(0);
  const conversationEpochRef = React.useRef(0);
  const invalidatedConversationPanelsRef = React.useRef(new Set<string>());
  // The initial durable list is asynchronous. Marking local create/submit
  // mutations lets its stale snapshot replace old cache without deleting a
  // conversation that was genuinely started against the active runtime.
  const conversationMutationEpochRef = React.useRef(0);
  const conversationMutationEpochByIdRef = React.useRef(new Map<string, number>());
  const markConversationMutation = useCallback((conversationId: string) => {
    const nextEpoch = conversationMutationEpochRef.current + 1;
    conversationMutationEpochRef.current = nextEpoch;
    conversationMutationEpochByIdRef.current.set(conversationId, nextEpoch);
  }, []);
  // Keep the selected thread across a page remount/reload. The panel's pending-run
  // handoff uses this server thread id to reconnect rather than asking again.
  const [activeId, setActiveId] = useState<string>(() => {
    const stored = seeded.activeId ?? loadActiveConversationId(conversations);
    return stored ?? makeConversationId();
  });
  const activeIdRef = React.useRef(activeId);
  // Whether this tab arrived with a chat of its own (URL thread or per-tab
  // pointer). A tab that did never falls back to the newest chat.
  const tabHadBindingRef = React.useRef<boolean>((() => { const binding = readTabBinding(); return Boolean(binding.url || binding.tab); })());
  // Switching conversations remounts the panel. A running panel now persists its
  // run id and reconnects on remount, but keeping the selected conversation stable
  // still avoids an unnecessary context switch while an answer is in progress.
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    activeIdRef.current = activeId;
    try { window.sessionStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, activeId); } catch { /* per-tab memory unavailable */ }
    try { window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, activeId); } catch { /* best-effort */ }
  }, [activeId]);
  // The tab's URL names its chat once the chat has a server thread.
  const activeConversationThreadId = conversations.find((conversation) => conversation.id === activeId)?.threadId;
  useEffect(() => {
    if (typeof window === 'undefined' || !/^\/(ask)?$/.test(window.location.pathname)) return;
    // While the URL's thread is still pending, the address bar keeps it: a
    // rewrite here would erase the identity the tab was opened with.
    if (pendingThreadIdRef.current && pendingThreadIdRef.current !== activeConversationThreadId) return;
    const next = askLocationHref(activeConversationThreadId, window.location.hash);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(window.history.state, '', next);
  }, [activeId, activeConversationThreadId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    // A page may close after the browser copy was removed but before the DELETE
    // response arrived. Retry that bounded queue before canonical history is
    // allowed to repopulate the sidebar.
    for (const threadId of loadDeletedThreadIds()) {
      void api.deleteAgentThread(threadId)
        .then(() => clearDeletedThreadId(threadId))
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHistoryVerificationState('pending');
    // Keep the request-start tombstones for this response even if a concurrent
    // retry DELETE succeeds first. Otherwise an older in-flight GET could
    // briefly resurrect the just-deleted thread from its stale response body.
    const deletedAtRequestStart = loadDeletedThreadIds();
    const listRequestEpoch = conversationMutationEpochRef.current;
    const listRequestSnapshot = snapshotAskConversationList(conversationsRef.current);
    void hydrateInitialAskConversationList({
      listAgentThreads: (options) => api.listAgentThreads(options),
      requestSnapshot: listRequestSnapshot,
      requestEpoch: listRequestEpoch,
      deletedAtRequestStart,
      getDeletedThreadIds: loadDeletedThreadIds,
      getConversations: () => conversationsRef.current,
      getActiveId: () => activeIdRef.current,
      getTabHadBinding: () => tabHadBindingRef.current,
      getMutationEpochByConversationId: () => conversationMutationEpochByIdRef.current,
      getCachedProjectIdentity: loadAskConversationProjectIdentity,
    })
      .then(({ projectIdentity, reconciliation }) => {
        if (cancelled) return;
        // The server has now either mapped this tab's URL thread or denied it;
        // either way the identity is settled and the URL may be written again.
        pendingThreadIdRef.current = undefined;
        const activeAtReconciliation = activeIdRef.current;
        if (reconciliation.resetBrowserCache) clearAskConversationBrowserCache();
        persistAskConversationProjectIdentity(projectIdentity);

        // The panel stores initial items at mount. A cache reset must force a
        // remount even if a coincidentally reused thread id leaves the selected
        // conversation id unchanged; otherwise an old result can stay painted.
        if (reconciliation.resetBrowserCache || reconciliation.activeId !== activeAtReconciliation) {
          const previousEpoch = conversationEpochRef.current;
          invalidatedConversationPanelsRef.current.add(`${activeAtReconciliation}:${previousEpoch}`);
          const nextEpoch = previousEpoch + 1;
          conversationEpochRef.current = nextEpoch;
          setConversationEpoch(nextEpoch);
          activeIdRef.current = reconciliation.activeId;
          setActiveId(reconciliation.activeId);
        }
        const nextConversations = persistConversations(reconciliation.conversations);
        conversationsRef.current = nextConversations;
        setConversations(nextConversations);
        setHistoryVerificationState('verified');
      })
      .catch(() => {
        // A failed verification must never reveal local browser cache. The user
        // can explicitly retry after the local runtime becomes available.
        if (!cancelled) setHistoryVerificationState('unavailable');
      })
    return () => { cancelled = true; };
  }, [historyRequestNonce]);

  const activeItems = useMemo(
    () => conversations.find((c) => c.id === activeId)?.items ?? [],
    [conversations, activeId],
  );
  const activeThreadId = useMemo(
    () => conversations.find((c) => c.id === activeId)?.threadId,
    [conversations, activeId],
  );

  const handleItemsChange = useCallback(
    (items: ThreadItem[]) => {
      // An old panel can report one final render while the authoritative server
      // response is replacing it. Never let that revoked panel re-persist a
      // previous project's question, result, or member value.
      const next = applyAskItemsCallback({
        conversations: conversationsRef.current,
        callbackConversationId: activeId,
        callbackEpoch: conversationEpoch,
        activeConversationId: activeIdRef.current,
        activeEpoch: conversationEpochRef.current,
        revokedPanelKeys: invalidatedConversationPanelsRef.current,
        items,
      });
      if (next === conversationsRef.current) return;
      markConversationMutation(activeId);
      const persisted = persistConversations(next);
      conversationsRef.current = persisted;
      setConversations(persisted);
    },
    [activeId, conversationEpoch, markConversationMutation],
  );

  // Remember the server thread backing this conversation, so resuming it (or a
  // page refresh) continues the same server-persisted thread.
  const handleThreadIdChange = useCallback(
    (threadId: string) => {
      const next = applyAskThreadIdCallback({
        conversations: conversationsRef.current,
        callbackConversationId: activeId,
        callbackEpoch: conversationEpoch,
        activeConversationId: activeIdRef.current,
        activeEpoch: conversationEpochRef.current,
        revokedPanelKeys: invalidatedConversationPanelsRef.current,
        threadId,
      });
      if (next === conversationsRef.current) return;
      markConversationMutation(activeId);
      const persisted = persistConversations(next);
      conversationsRef.current = persisted;
      setConversations(persisted);
    },
    [activeId, conversationEpoch, markConversationMutation],
  );

  /**
   * Rename and pin write through to the server thread when there is one, so the
   * change survives a refresh and other surfaces see it. Local state updates
   * first: these are instant, low-stakes edits and should not wait on a round
   * trip. A thread that has not been created yet (no question asked) simply
   * keeps the change locally.
   */
  const renameConversation = useCallback((id: string, title: string) => {
    const clean = title.trim();
    if (!clean) return;
    setConversations((current) => persistConversations(current.map((conversation) =>
      conversation.id === id ? { ...conversation, title: clean, titleCustomized: true } : conversation)));
    const threadId = conversations.find((conversation) => conversation.id === id)?.threadId;
    if (threadId) void api.updateAgentThread(threadId, { title: clean }).catch(() => undefined);
  }, [conversations]);

  const toggleConversationFavorite = useCallback((id: string) => {
    const target = conversations.find((conversation) => conversation.id === id);
    const next = !target?.favorite;
    setConversations((current) => persistConversations(current.map((conversation) =>
      conversation.id === id ? { ...conversation, favorite: next } : conversation)));
    if (target?.threadId) void api.updateAgentThread(target.threadId, { favorite: next }).catch(() => undefined);
  }, [conversations]);

  const newChat = useCallback(() => {
    if (!historyVerified || isRunning) return;
    // An explicit choice settles the identity even if the server never answered.
    pendingThreadIdRef.current = undefined;
    const nextActiveId = makeConversationId();
    tabHadBindingRef.current = true;
    activeIdRef.current = nextActiveId;
    setActiveId(nextActiveId);
  }, [historyVerified, isRunning]);
  const selectConversation = useCallback((id: string) => {
    if (!historyVerified || isRunning) return;
    pendingThreadIdRef.current = undefined;
    tabHadBindingRef.current = true;
    activeIdRef.current = id;
    setActiveId(id);
  }, [historyVerified, isRunning]);

  const deleteConversation = useCallback(
    (id: string) => {
      if (!historyVerified || isRunning) return;
      const threadId = conversations.find((conversation) => conversation.id === id)?.threadId;
      if (threadId) {
        queueDeletedThreadId(threadId);
        void api.deleteAgentThread(threadId)
          .then(() => clearDeletedThreadId(threadId))
          .catch(() => undefined);
      }
      setConversations((prev) => persistConversations(prev.filter((c) => c.id !== id)));
      if (id === activeId) {
        const nextActiveId = makeConversationId();
        activeIdRef.current = nextActiveId;
        setActiveId(nextActiveId);
      }
    },
    [activeId, conversations, historyVerified, isRunning],
  );

  const retryHistoryVerification = useCallback(() => {
    if (historyVerificationState === 'pending') return;
    setHistoryVerificationState('pending');
    setHistoryRequestNonce((nonce) => nonce + 1);
  }, [historyVerificationState]);

  const openApp = (appId: string, dashboardId?: string, draftId?: string) => {
    if (draftId) {
      dispatch({ type: 'OPEN_APP_DRAFT', draftId, appId, dashboardId });
      return;
    }
    dispatch({ type: 'OPEN_APP', appId, dashboardId });
  };

  const openResearch = (researchRunId: string, notebookPath?: string, sourceAskRunId?: string) => {
    // Ask has its own full-page trace surface. The prior Global AI dispatch
    // only mounted a rail on Apps, so this action appeared to do nothing from
    // Ask (including native Enter/Space activation). Route the canonical Ask
    // run to its Research stage instead; the trace graph retains the durable
    // research_branch links and opens the selected Research evidence.
    if (sourceAskRunId) {
      openAskResearchTrace({ sourceAskRunId, dispatch });
      return;
    }

    // Preserve the old contextual handoff for legacy artifacts that predate
    // the canonical source Ask run ID. New Ask Research artifacts always take
    // the addressable trace path above.
    dispatch({
      type: 'OPEN_GLOBAL_AI',
      audience: 'stakeholder',
      context: {
        title: 'Research',
        scopeHint: 'Follow up on this research',
        selectedObject: { kind: 'research', id: researchRunId, path: notebookPath },
      },
    });
  };

  const openEditableNotebookCell = useCallback((payload: InsertDqlPayload) => {
    // With no notebook open, ADD_CELL writes into a store the NotebookEditor is
    // not rendering (it shows the welcome screen whenever there is no active
    // file), so the answer silently vanished. Create and open a notebook that
    // already contains it instead.
    if (!state.activeFile || state.activeFile.type === 'block') {
      void openAnswerInNotebook(payload);
      return;
    }
    const cell = askNotebookCellFromPayload(payload);
    if (!cell) return;
    dispatch({ type: 'ADD_CELL', cell });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'notebook' });
    focusInsertedNotebookCell(cell.id);
  }, [dispatch, openAnswerInNotebook, state.activeFile]);

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', overflow: 'hidden', background: t.appBg }}>
      {/* Do not let cached titles/questions render before identity verification. */}
      <ConversationSidebar
        t={t}
        conversations={historyVerified ? conversations : []}
        activeId={activeId}
        busy={isRunning || !historyVerified}
        loading={historyVerificationState === 'pending'}
        onNewChat={newChat}
        onSelect={selectConversation}
        onDelete={deleteConversation}
        onRename={renameConversation}
        onToggleFavorite={toggleConversationFavorite}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Above Ask on a new chat: my Apps, what moved, and what the host adds. */}
        {historyVerified && activeItems.length === 0 ? (
          <React.Suspense fallback={null}>
            <HomeSummary />
          </React.Suspense>
        ) : null}
        <AskHistoryVerificationGate
          state={historyVerificationState}
          t={t}
          onRetry={retryHistoryVerification}
        >
          <UnifiedAgentRunPanel
            key={`${activeId}:${conversationEpoch}`}
            themeMode={state.themeMode}
            title="Ask your data"
            askLayout
            scopeHint={domainContext ? `Scoped to ${domainContext.domain}${domainContext.modelAreaId ? ` · ${domainContext.modelAreaId.split('::').at(-1)?.replace(/_/g, ' ')}` : ''}${domainContext.purpose ? ` for ${domainContext.purpose}` : ''}` : 'Ask a question or request deep research'}
            onClearScope={domainContext ? () => { setDomainContext(undefined); persistDomainScope(undefined); } : undefined}
            scopeControl={<AskScopePicker scope={domainContext} onChange={(next) => { setDomainContext(next); persistDomainScope(next); }} t={t} />}
            onScopeChange={(next) => { setDomainContext(next); persistDomainScope(next); }}
            workspaceContext={domainContext}
            audience="stakeholder"
            initialMode="auto"
            initialItems={activeItems}
            onItemsChange={handleItemsChange}
            threadId={activeThreadId}
            onThreadIdChange={handleThreadIdChange}
            onRunningChange={setIsRunning}
            onOpenResearch={openResearch}
            onOpenApp={openApp}
            onInsertSql={(sql, title, meta?: SqlNotebookDraftMeta) => openEditableNotebookCell({
              sql,
              title,
              question: meta?.question,
              sourceRunId: meta?.sourceRunId,
            })}
            onInsertDql={openEditableNotebookCell}
            insertDqlActionLabel="Open in notebook"
          />
        </AskHistoryVerificationGate>
      </div>
    </div>
  );
}

function ConversationSidebar({
  t,
  conversations,
  activeId,
  busy,
  loading,
  onNewChat,
  onSelect,
  onDelete,
  onRename,
  onToggleFavorite,
}: {
  t: Theme;
  conversations: Conversation[];
  activeId: string;
  busy?: boolean;
  loading?: boolean;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const switchTitle = busy ? 'Finish the current question first' : undefined;
  const hostUi = useHostUi();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const favorites = conversations.filter((conversation) => conversation.favorite);
  const rest = conversations.filter((conversation) => !conversation.favorite);

  const beginRename = (conversation: Conversation): void => {
    setRenamingId(conversation.id);
    setDraftTitle(conversation.title);
  };
  const commitRename = (): void => {
    if (renamingId && draftTitle.trim()) onRename(renamingId, draftTitle);
    setRenamingId(null);
  };

  const renderConversationRow = (conv: Conversation): JSX.Element => {
    const active = conv.id === activeId;
    const hovered = hoverId === conv.id;
    const renaming = renamingId === conv.id;
    return (
      <div
        key={conv.id}
        onMouseEnter={() => setHoverId(conv.id)}
        onMouseLeave={() => setHoverId((cur) => (cur === conv.id ? null : cur))}
        style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
      >
        {renaming ? (
          <input
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
              if (event.key === 'Escape') { event.preventDefault(); setRenamingId(null); }
            }}
            aria-label="Conversation name"
            style={{
              flex: 1, minWidth: 0, padding: '7px 10px', borderRadius: 7,
              border: `1px solid ${t.accent}`, background: t.appBg,
              color: t.textPrimary, fontSize: 12.5, fontWeight: 600,
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => onSelect(conv.id)}
            onDoubleClick={() => beginRename(conv)}
            disabled={busy && !active}
            title={busy && !active ? switchTitle : `${conv.title} — double-click to rename`}
            style={{
              flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px', borderRadius: 7, border: 'none',
              background: active ? `${t.accent}1f` : hovered ? `${t.textPrimary}0d` : 'transparent',
              // The current chat's words in the accent's ink (the accent mixed toward the text): 4.5:1 on its tint.
              color: active ? `color-mix(in srgb, ${t.accent} 80%, ${t.textPrimary})` : t.textSecondary,
              cursor: busy && !active ? 'not-allowed' : 'pointer',
              opacity: busy && !active ? 0.5 : 1,
              textAlign: 'left', fontSize: 12.5, fontWeight: active ? 600 : 500,
              paddingRight: hovered ? 56 : 10,
            }}
          >
            {active && busy
              ? <Loader2 size={13} style={{ flexShrink: 0, color: t.accent, animation: 'dql-agent-run-spin 0.8s linear infinite' }} />
              : conv.favorite
                ? <Star size={13} style={{ flexShrink: 0, color: t.accent }} fill="currentColor" />
                : <MessageSquare size={13} style={{ flexShrink: 0, opacity: 0.7 }} />}
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {active && busy ? 'Working…' : conv.title}
            </span>
            {!hovered ? (
              <span style={{ flexShrink: 0, fontSize: 11, color: active && busy ? t.accent : t.textMuted, fontWeight: active && busy ? 650 : 400 }}>
                {active && busy ? 'Live' : relativeTime(conv.updatedAt)}
              </span>
            ) : null}
          </button>
        )}
        {hovered && !renaming ? (
          <div style={{ position: 'absolute', right: 4, display: 'inline-flex', gap: 2 }}>
            <RowAction t={t} label={conv.favorite ? 'Unpin conversation' : 'Pin conversation'} onClick={() => onToggleFavorite(conv.id)}>
              <Star size={12} fill={conv.favorite ? 'currentColor' : 'none'} />
            </RowAction>
            <RowAction t={t} label="Rename conversation" onClick={() => beginRename(conv)}>
              <Pencil size={12} />
            </RowAction>
            <RowAction t={t} label="Delete conversation" onClick={() => onDelete(conv.id)}>
              <Trash2 size={12} />
            </RowAction>
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <aside
      style={{
        width: 248,
        flexShrink: 0,
        borderRight: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: 12 }}>
        <button
          type="button"
          onClick={onNewChat}
          disabled={busy}
          title={switchTitle}
          style={{
            width: '100%',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: 'center',
            padding: '9px 12px',
            borderRadius: 8,
            border: `1px solid ${t.accent}`,
            background: t.accent,
            color: 'var(--accent-on, #fff)',
            fontSize: 13,
            fontWeight: 650,
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.55 : 1,
          }}
        >
          <Plus size={15} strokeWidth={2.4} /> New chat
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {loading && conversations.length === 0 ? (
          <div style={{ padding: '10px 8px', display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: t.textMuted }}>
            <Loader2 size={13} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} />
            Restoring project chats…
          </div>
        ) : conversations.length === 0 ? (
          <div style={{ padding: '10px 8px', fontSize: 11.5, color: t.textMuted, lineHeight: 1.5 }}>
            No past chats yet. Your conversations show up here so you can pick up where you left off.
          </div>
        ) : (
          <>
            {favorites.length > 0 ? (
              <>
                <GroupLabel t={t}>Favourites</GroupLabel>
                {favorites.map((conv) => renderConversationRow(conv))}
                <GroupLabel t={t}>Recent</GroupLabel>
              </>
            ) : (
              <GroupLabel t={t}>Recent</GroupLabel>
            )}
            {rest.map((conv) => renderConversationRow(conv))}
          </>
        )}
      </div>
      <div style={{ padding: '10px 12px', borderTop: `1px solid ${t.headerBorder}`, display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: t.textMuted }}>
        <ShieldCheck size={12} style={{ flexShrink: 0, color: t.success }} />
        <span>{hostUi.host || isSnowflakeApp() ? 'Only you see your chats' : 'Private project history · not committed to Git'}</span>
      </div>
    </aside>
  );
}

/** Section heading in the conversation sidebar. */
function GroupLabel({ t, children }: { t: Theme; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ padding: '8px 8px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>
      {children}
    </div>
  );
}

/** Small hover action on a conversation row. */
function RowAction({ t, label, onClick, children }: {
  t: Theme;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: 5, border: 'none',
        background: t.cellBg, color: t.textMuted, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
