import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { automaticAskDraftState } from '@zlens/agent';
import { applyCompanionCertification } from '../certification-receipt.js';
import { GitHistoryStore } from './git-history-store.js';
import { HistoryIndex, withoutDraftEditName, type HistoryChangeKind, type IndexedChange, type IndexedCommit, type ItemVersion } from './history-index.js';
import { HistorySqlLog, type HistorySqlLogOptions, type SqlLogRow, type SqlLogState } from './history-sql-log.js';
import { AI_ASK_NAME, ZLENS_AUTHOR, type HistoryAction, type HistoryAuthor, type HistoryStore } from './history-store.js';
import { changedLineCount, diffLines, type DiffLine } from './line-diff.js';
import { asDraftSource, compareSavedQueryFields, isCertifiedVersion, readSavedQueryFields, receiptSummary, type FieldChange } from './saved-query-fields.js';
import { appKeyOf, besideSuffix, besideSuffixOf, isAppStudioDraftPath, isDraftPath, isTrackedItemKey, isTrackedPath, listTrackedFiles, type HistoryItemKind } from './tracked-files.js';

/**
 * VERSION HISTORY IN THE ZLENS APP FOR SNOWFLAKE (V15, decisions H1–H10).
 *
 * Every successful save through ZLens makes a version: after a request that changed tracked files, those files are
 * committed, one commit per request, one at a time (a queue). Nobody commits by hand. The author is the Snowflake
 * user who signed in; an automatic Ask draft is "AI (Ask)" with the person who asked; ZLens's own work (the first
 * start, upgrade steps and clean-ups) is "ZLens". Restore writes an old version back as the next version, always as
 * a draft: certifying stays a separate, explicit action, and a certified version and its receipt are never
 * rewritten. A removed item stays in History and can be restored.
 *
 * Only in the Snowflake app. Open source and Enterprise keep Source control and the Git program's history (H10).
 */
export const HISTORY_SIZE_WARNING_BYTES = 1024 ** 3;
const GITDIR = join('.dql', 'history');
const STARTED = 'History starts here';
const SWEEP_DELAY_MS = 30_000;
const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();
/** Which trash bundles History has kept, and since when it keeps App Studio drafts (V2). */
const TRASH_STATE = 'zlens-trash.json';

/**
 * Apps as App Studio keeps them (V2). An App is a draft in ZLens's local store until it is published, so History
 * reads each App's live draft from there (`apps/<id>/studio-draft.json`, kept in History's repository only), and
 * restores an App version as an App Studio draft, never as a published App.
 */
export interface HistoryAppSource {
  /** Each App's live App Studio draft, as History keeps it: `apps/<id>/studio-draft.json` → its text. */
  drafts(): Map<string, string>;
  /**
   * Writes an App version back as an App Studio draft, never publishing. For an App that is there (`asNew` false):
   * into its live draft, else a new draft editing its published App. For a removed App (`asNew` true): always a new
   * draft, under its own name and id when they are free, else a free one, so no other App's draft is touched.
   */
  restore(input: { appId: string; files: Array<{ path: string; content: string }>; asNew: boolean }): Promise<{ appId: string; draftId: string; name: string }>;
  /** Apps in ZLens's trash (a Delete, or an upgrade clean-up), with their files: History keeps each once. */
  trashed?(): HistoryTrashedApp[];
}

export interface HistoryTrashedApp {
  /** The trash bundle's id. */
  id: string;
  appId: string;
  name: string;
  /** ISO-8601. */
  deletedAt: string;
  /** `draft`: an App Studio draft's bundle; `app`: a published App's folder. */
  from: 'draft' | 'app';
  /** One line: why it went to the trash, and when. */
  reason: string;
  /** Its files, by their path inside the App's folder (`studio-draft.json`, `dql.app.json`, `dashboards/<id>.dqld`). */
  files: Array<{ path: string; content: string }>;
}

export interface HistoryServiceOptions {
  projectRoot: string;
  /** Default `<project>/.dql/history`. */
  gitdir?: string;
  store?: HistoryStore;
  sqlLog?: Omit<HistorySqlLogOptions, 'stateFile'>;
  /** Called after a restore wrote files, so ZLens reloads what it caches. */
  onRestored?: (paths: string[]) => Promise<void> | void;
  log?: { info: (message: string) => void; warn: (message: string) => void };
  now?: () => Date;
  /** Seconds after the last request before a quiet look for changes made in the background. 0 turns it off. */
  sweepDelayMs?: number;
  /** Apps as App Studio keeps them (V2): their drafts, restoring one as a draft, and the trash. */
  apps?: HistoryAppSource;
}

export interface HistoryFeedFilters {
  kind?: string;
  by?: string;
  days?: number;
  certifiedOnly?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryFeedItem {
  key: string;
  /** The key the item has now (after renames). */
  current: string;
  name: string;
  kind: HistoryItemKind;
  version: number;
  certified: boolean;
  removed: boolean;
  isCurrentVersion: boolean;
}

export interface HistoryFeedEntry {
  id: string;
  commit: string;
  at: string;
  by: HistoryAuthor;
  /** Why the version was made: a save, a certification, Clear drafts, an upgrade, a restore, … */
  action: HistoryAction;
  change: HistoryChangeKind;
  kind: HistoryItemKind;
  items: HistoryFeedItem[];
  /** Set when one line stands for several items (a clean-up, the first start). */
  count: number;
  version?: number;
  certified: boolean;
  detail?: string;
  canCompare: boolean;
  canRestore: boolean;
}

export interface HistoryVersionRow {
  version: number;
  commit: string;
  /** The file holding this version (a saved query's draft edit, when it was one); absent for a removal. */
  path?: string;
  at: string;
  by: HistoryAuthor;
  change: HistoryChangeKind;
  detail?: string;
  state: 'certified' | 'draft' | 'saved' | 'removed';
  current: boolean;
  canRestore: boolean;
}

export interface HistoryItemResult {
  item: { key: string; kind: HistoryItemKind; name: string; removed: boolean; currentVersion: number };
  versions: HistoryVersionRow[];
  /** A draft on a certified version; `restored` when the draft is a restored copy of that certified version. */
  banner: { draft: number; certified: number; restored?: number } | null;
}

export interface HistoryVersionCard {
  version: number;
  commit: string;
  /** The file holding this version (a saved query's draft edit, when it was one). */
  path?: string;
  at: string;
  by: HistoryAuthor;
  state: HistoryVersionRow['state'];
  certifiedBy?: string;
  oldReport?: string;
}

export interface HistoryCompareResult {
  item: HistoryItemResult['item'];
  from: HistoryVersionCard;
  to: HistoryVersionCard;
  sql?: { lines: DiffLine[]; changed: number };
  fields?: FieldChange[];
  files: Array<{ path: string; status: 'added' | 'removed' | 'changed' | 'same'; lines: DiffLine[]; changed: number }>;
}

export interface HistoryRunResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export type HistoryRunner = (source: string) => Promise<HistoryRunResult>;

export interface HistoryRunCompare {
  from: { columns: string[]; rowCount: number; error?: string };
  to: { columns: string[]; rowCount: number; error?: string };
  keyColumns: string[];
  valueColumns: string[];
  rows: Array<{ key: unknown[]; from: unknown[] | null; to: unknown[] | null; state: 'same' | 'changed' | 'new' | 'removed' }>;
  summary: { same: number; changed: number; new: number; removed: number };
}

export class HistoryError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400, readonly code = 'HISTORY_ERROR') {
    super(message);
  }
}

type PendingChange = { path: string; content: Uint8Array | null; mtimeMs?: number };

export interface HistoryRestoreResult {
  item: string;
  restored: number;
  version: number;
  message: string;
  paths: string[];
  /** An App restored as an App Studio draft: the draft to open. */
  appDraft?: { id: string; appId: string };
}

export class HistoryService {
  readonly store: HistoryStore;
  readonly index: HistoryIndex;
  readonly sqlLog: HistorySqlLog | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** What each tracked file looked like when last read: its stat and blob id. */
  private readonly snapshot = new Map<string, { size: number; mtimeMs: number; oid: string }>();
  private lastPerson: string | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private sqlFlushTimer: NodeJS.Timeout | undefined;
  private started = false;
  private sizeCache: { at: number; bytes: number } | undefined;

  constructor(private readonly options: HistoryServiceOptions) {
    const gitdir = options.gitdir ?? join(options.projectRoot, GITDIR);
    this.store = options.store ?? new GitHistoryStore(gitdir);
    this.index = new HistoryIndex(this.store, options.projectRoot);
    this.sqlLog = options.sqlLog ? new HistorySqlLog({ ...options.sqlLog, stateFile: join(this.store.location, 'zlens-sql-log.json'), ...(options.log ? { warn: options.log.warn } : {}) }) : undefined;
  }

  private get root(): string {
    return this.options.projectRoot;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private log(level: 'info' | 'warn', message: string): void {
    if (this.options.log) this.options.log[level](message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  }

  /** One job at a time, in the order asked. A failed job never stops the ones after it. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Waits until every queued job has run (tests, and before the server stops). */
  async idle(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (seen !== this.queue) {
      seen = this.queue;
      await seen;
    }
  }

  /**
   * Opens History: creates the repository with its first version ("History starts here", by ZLens) on the first
   * start; afterwards, commits as ZLens anything that changed while ZLens was not running.
   */
  async start(): Promise<{ created: boolean; commits: IndexedCommit[] }> {
    return this.enqueue(async () => {
      const { created } = await this.store.open();
      await this.index.load();
      this.started = true;
      const commits = created || !(await this.store.head())
        ? await this.commitNow(ZLENS_AUTHOR, 'start', STARTED, { allowEmpty: true })
        : await this.commitNow(ZLENS_AUTHOR, 'found', 'Changes found when ZLens started');
      commits.push(...(await this.keepTrashedApps()));
      const bytes = await this.store.sizeBytes();
      if (bytes >= HISTORY_SIZE_WARNING_BYTES) {
        this.log('warn', `[zlens] History takes ${(bytes / 1024 ** 3).toFixed(1)} GiB of the app's volume (Settings shows it).`);
      }
      return { created, commits };
    });
  }

  /** Commits whatever tracked files changed, as `author` (ZLens's own steps: upgrades, clean-ups, set-up). */
  commitPending(author: HistoryAuthor, action: HistoryAction, message: string): Promise<IndexedCommit[]> {
    return this.enqueue(() => this.commitNow(author, action, message));
  }

  /** After a request answered: when it changed tracked files, they become a version by the person who sent it. */
  afterRequest(request: { user?: string; method?: string; path: string; status: number }): Promise<IndexedCommit[]> | undefined {
    if (!this.started) return undefined;
    if (request.user) this.lastPerson = request.user;
    this.sweepSoon();
    if (request.status >= 400) return undefined;
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'GET' && request.path === '/api/app-builds' && this.options.apps) {
      // Listing App drafts can tidy them (an empty copy of another App goes to the trash, #341): ZLens's own change.
      // Only drafts that went: an edit saved at the same moment from another tab stays the person's.
      return this.enqueue(() => this.commitNow(ZLENS_AUTHOR, 'upgrade', '', { only: isAppStudioDraftPath, removalsOnly: true }));
    }
    const longRequestDone = method === 'GET' && request.path.startsWith('/api/long-requests/') && request.status !== 202;
    if (!longRequestDone && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return undefined;
    if (request.path.startsWith('/api/history/')) return undefined;
    const author: HistoryAuthor = request.user ? { name: request.user, kind: 'person' } : ZLENS_AUTHOR;
    return this.enqueue(() => this.commitNow(author, actionForRequest(method, request.path), ''));
  }

  /**
   * Work some requests start goes on after they answer (an Ask run, a long App builder request): a quiet look for
   * changes a while after the last request commits them, as the person who used ZLens last (the app has one).
   */
  private sweepSoon(): void {
    const delay = this.options.sweepDelayMs ?? SWEEP_DELAY_MS;
    if (!delay) return;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      void this.sweep();
    }, delay);
    this.sweepTimer.unref?.();
  }

  /** Commits changes made outside a request (background work), as the last person, or ZLens when nobody came. */
  sweep(): Promise<IndexedCommit[]> {
    const author: HistoryAuthor = this.lastPerson ? { name: this.lastPerson, kind: 'person' } : ZLENS_AUTHOR;
    return this.enqueue(() => this.commitNow(author, 'save', '')).catch((error) => {
      this.log('warn', `[zlens] History could not save a version: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
  }

  stop(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    if (this.sqlFlushTimer) clearTimeout(this.sqlFlushTimer);
  }

  // ── Finding changes and committing them ──────────────────────────────────────────────────────────────────────

  /** Each App's live App Studio draft (V2); null when the store could not be read (then nothing counts as removed). */
  private appDrafts(): Map<string, string> | null {
    if (!this.options.apps) return new Map();
    try {
      return this.options.apps.drafts();
    } catch (error) {
      this.log('warn', `[zlens] History could not read the App drafts this time: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** The tracked files that differ from the newest version (only those `only` keeps, when given). */
  private async findChanges(only?: (path: string) => boolean): Promise<PendingChange[]> {
    const head = this.index.headFiles();
    const listed = listTrackedFiles(this.root);
    const drafts = this.appDrafts();
    const changes: PendingChange[] = [];
    for (const path of [...listed.keys()]) {
      if (isAppStudioDraftPath(path) || (only && !only(path))) listed.delete(path);
    }
    for (const [path, text] of drafts ?? []) {
      if (!isAppStudioDraftPath(path) || (only && !only(path))) continue;
      const content = encoder.encode(text);
      if (head.get(path) !== (await this.store.hashContent(content))) changes.push({ path, content });
    }
    for (const [path, stat] of listed) {
      const known = this.snapshot.get(path);
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && head.get(path) === known.oid) continue;
      let content: Uint8Array;
      try {
        content = readFileSync(join(this.root, path));
      } catch {
        continue;
      }
      const oid = await this.store.hashContent(content);
      this.snapshot.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, oid });
      if (head.get(path) !== oid) changes.push({ path, content, mtimeMs: stat.mtimeMs });
    }
    for (const path of head.keys()) {
      if (only && !only(path)) continue;
      if (isAppStudioDraftPath(path)) {
        // A draft is gone when the store no longer has it; when the store could not be read, nothing is gone.
        if (drafts && !drafts.has(path)) changes.push({ path, content: null });
        continue;
      }
      if (!listed.has(path)) {
        changes.push({ path, content: null });
        this.snapshot.delete(path);
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Apps that went to ZLens's trash before History kept them (V2, decision H7): an App Studio draft deleted, or moved
   * there by an upgrade clean-up, before History kept drafts; a published App deleted before History started. Each
   * is kept once, as ZLens: its last content, then its removal, so History lists it as removed and it can be
   * restored. Anything History saw go is not kept twice. Runs inside the queue.
   */
  private async keepTrashedApps(): Promise<IndexedCommit[]> {
    const source = this.options.apps;
    if (!source?.trashed) return [];
    const statePath = join(this.store.location, TRASH_STATE);
    let state: { draftsSince?: string; kept?: string[] } = {};
    try {
      if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf-8')) as typeof state;
    } catch {
      state = {};
    }
    const nowIso = this.now().toISOString();
    const draftsSince = Date.parse(state.draftsSince ?? nowIso);
    const historySince = Date.parse(this.index.commits[0]?.at ?? nowIso);
    const kept = new Set(Array.isArray(state.kept) ? state.kept : []);
    let trashed: HistoryTrashedApp[] = [];
    try {
      trashed = source.trashed();
    } catch (error) {
      this.log('warn', `[zlens] History could not read ZLens's trash: ${error instanceof Error ? error.message : String(error)}`);
    }
    const made: IndexedCommit[] = [];
    for (const bundle of [...trashed].sort((a, b) => a.deletedAt.localeCompare(b.deletedAt) || a.id.localeCompare(b.id))) {
      if (kept.has(bundle.id)) continue;
      kept.add(bundle.id);
      // History saw this one go (it kept drafts, or the App's files, when it was removed).
      const deletedAt = Date.parse(bundle.deletedAt);
      if (!Number.isFinite(deletedAt) || deletedAt >= (bundle.from === 'draft' ? draftsSince : historySince)) continue;
      const key = this.freeAppKey(bundle.appId, bundle.id);
      const files = bundle.files
        .map((file) => ({ path: `${key}/${file.path}`, content: encoder.encode(file.content) }))
        .filter((file) => isTrackedPath(file.path) && file.content.byteLength <= 5 * 1024 * 1024);
      if (!files.length) continue;
      made.push(await this.commitFiles(ZLENS_AUTHOR, 'trash', `Kept from the trash: ${bundle.name}`, files));
      made.push(await this.commitFiles(ZLENS_AUTHOR, 'trash', bundle.reason, files.map((file) => ({ path: file.path, content: null }))));
    }
    try {
      writeFileSync(statePath, `${JSON.stringify({ draftsSince: state.draftsSince ?? nowIso, kept: [...kept].sort() }, null, 2)}\n`, 'utf-8');
    } catch (error) {
      this.log('warn', `[zlens] History could not note which trashed Apps it kept: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (made.length) this.sqlLogSoon();
    return made;
  }

  /** `apps/<id>` for a trashed App, unless an App History knows has that id; then a key of its own. */
  private freeAppKey(appId: string, bundleId: string): string {
    const id = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(appId) ? appId : 'app';
    const key = `apps/${id}`;
    const inUse = this.index.versions(key).length > 0
      || [...this.index.headFiles().keys()].some((path) => path.startsWith(`${key}/`))
      || existsSync(join(this.root, key));
    if (!inUse) return key;
    let n = 0;
    let candidate = `${key}-removed-${bundleId.replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase() || 'x'}`;
    while (this.index.versions(candidate).length && n < 100) candidate = `${key}-removed-${(n += 1)}`;
    return candidate;
  }

  /** Commits the current changes (call inside the queue). An automatic Ask draft is its own version by AI (Ask). */
  private async commitNow(
    author: HistoryAuthor,
    action: HistoryAction,
    message: string,
    options: { allowEmpty?: boolean; restoredFrom?: { item: string; version: number; commit: string }; only?: (path: string) => boolean; removalsOnly?: boolean } = {},
  ): Promise<IndexedCommit[]> {
    const found = await this.findChanges(options.only);
    const changes = options.removalsOnly ? found.filter((change) => change.content === null) : found;
    if (!changes.length && !options.allowEmpty) return [];
    const made: IndexedCommit[] = [];
    let rest = changes;
    if (action !== 'start' && action !== 'clear-drafts' && action !== 'restore' && author.kind !== 'ai') {
      const drafted = this.askDrafts(changes);
      if (drafted.length) {
        const ai: HistoryAuthor = { name: AI_ASK_NAME, kind: 'ai', ...(author.kind === 'person' ? { askedBy: author.name } : {}) };
        made.push(await this.commitFiles(ai, 'ask', `Drafted from Ask: ${names(drafted)}`, drafted));
        const taken = new Set(drafted.map((change) => change.path));
        rest = changes.filter((change) => !taken.has(change.path));
      }
    }
    if (rest.length || (options.allowEmpty && !made.length)) {
      made.push(await this.commitFiles(author, action, message || defaultMessage(action, rest), rest, options.restoredFrom));
    }
    if (made.length) this.sqlLogSoon();
    return made;
  }

  /** New or changed automatic Ask drafts nobody edited, with their companion YAMLs. */
  private askDrafts(changes: PendingChange[]): PendingChange[] {
    const drafts = changes.filter((change) => {
      if (!change.content || !/(^|\/)_drafts\/.+\.dql$/.test(change.path)) return false;
      return automaticAskDraftState(decoder.decode(change.content), change.mtimeMs) === 'untouched';
    });
    if (!drafts.length) return [];
    const companions = new Set(drafts.map((change) => this.index.itemMapper.companionOf(change.path)).filter((path): path is string => Boolean(path)));
    return changes.filter((change) => drafts.includes(change) || companions.has(change.path));
  }

  private async commitFiles(author: HistoryAuthor, action: HistoryAction, message: string, changes: PendingChange[], restoredFrom?: { item: string; version: number; commit: string }): Promise<IndexedCommit> {
    const previous = await this.store.head();
    const commit = await this.store.commit({
      author,
      action,
      message,
      changes: changes.map(({ path, content }) => ({ path, content })),
      at: this.now(),
      ...(restoredFrom ? { restoredFrom } : {}),
    });
    return this.index.append(commit, await this.store.diff(previous, commit.oid));
  }

  // ── Reading History ──────────────────────────────────────────────────────────────────────────────────────────

  /** The project's changes, newest first, grouped by day in the screen. */
  feed(filters: HistoryFeedFilters = {}): { entries: HistoryFeedEntry[]; total: number; people: string[] } {
    const since = filters.days && filters.days > 0 ? this.now().getTime() - filters.days * 86_400_000 : undefined;
    const q = filters.q?.trim().toLowerCase();
    const people = new Set<string>();
    const all: HistoryFeedEntry[] = [];
    for (let i = this.index.commits.length - 1; i >= 0; i -= 1) {
      const commit = this.index.commits[i]!;
      // The "By" choices are the people who saved something; AI drafts have a choice of their own.
      if (commit.author.kind === 'person') people.add(commit.author.name);
      if (since !== undefined && Date.parse(commit.at) < since) continue;
      if (!authorMatches(commit.author, filters.by)) continue;
      for (const entry of this.entriesFor(commit)) {
        if (filters.kind && filters.kind !== 'all' && !entry.items.some((item) => item.kind === filters.kind)) continue;
        if (filters.certifiedOnly && entry.change !== 'certified') continue;
        if (q && ![entry.by.name, entry.by.askedBy ?? '', entry.detail ?? '', ...entry.items.flatMap((item) => [item.name, item.key])]
          .some((text) => text.toLowerCase().includes(q))) continue;
        all.push(entry);
      }
    }
    const offset = Math.max(0, filters.offset ?? 0);
    const limit = Math.min(Math.max(1, filters.limit ?? 200), 1000);
    return { entries: all.slice(offset, offset + limit), total: all.length, people: [...people].sort() };
  }

  private entriesFor(commit: IndexedCommit): HistoryFeedEntry[] {
    const groups = new Map<string, IndexedChange[]>();
    for (const change of commit.changes) {
      // An App kept from the trash shows once, as removed (its content is the version before that).
      if (commit.action === 'trash' && change.change !== 'removed') continue;
      // The first version is one line, whatever it holds.
      const key = change.change === 'started' ? 'started' : `${change.change}:${change.kind}`;
      groups.set(key, [...(groups.get(key) ?? []), change]);
    }
    const entries: HistoryFeedEntry[] = [];
    for (const [key, changes] of groups) {
      const grouped = changes.length > 3 || changes[0]!.change === 'started';
      const parts = grouped ? [changes] : changes.map((change) => [change]);
      for (const part of parts) {
        const first = part[0]!;
        const items = part.map((change) => this.feedItem(change));
        const single = items.length === 1 ? items[0]! : undefined;
        entries.push({
          id: `${commit.oid}:${grouped ? key : first.item}`,
          commit: commit.oid,
          at: commit.at,
          by: commit.author,
          action: commit.action,
          change: first.change,
          kind: first.kind,
          items,
          count: items.length,
          ...(single ? { version: single.version } : {}),
          certified: first.change === 'certified',
          ...(grouped ? (first.change === 'removed' ? { detail: first.detail } : {}) : first.detail ? { detail: first.detail } : {}),
          canCompare: Boolean(single && first.change !== 'removed' && first.change !== 'started' && single.version > 1),
          canRestore: first.change !== 'started' && items.some((item) => item.removed || !item.isCurrentVersion),
        });
      }
    }
    return entries;
  }

  private feedItem(change: IndexedChange): HistoryFeedItem {
    const versions = this.index.versions(change.item);
    const latest = versions.at(-1);
    return {
      key: change.item,
      current: this.index.currentKey(change.item),
      name: change.name,
      kind: change.kind,
      version: change.version,
      certified: change.certified,
      removed: latest?.change.change === 'removed',
      isCurrentVersion: latest?.version === change.version,
    };
  }

  private requireItem(itemKey: string): ItemVersion[] {
    if (!isTrackedItemKey(itemKey)) throw new HistoryError('History keeps saved queries, Apps, notebooks and model files only.', 400, 'HISTORY_NOT_TRACKED');
    // The draft edit beside a certified saved query, or a companion YAML, is part of that saved query's History.
    const versions = this.index.versions(itemKey).length ? this.index.versions(itemKey) : this.index.versions(this.index.itemKeyFor(itemKey));
    if (!versions.length) throw new HistoryError('History has no versions of this item yet.', 404, 'HISTORY_ITEM_NOT_FOUND');
    return versions;
  }

  /** Every version of one item, newest first, with the "draft edit of a certified version" banner when it applies. */
  item(itemKey: string): HistoryItemResult {
    const versions = this.requireItem(itemKey);
    const latest = versions.at(-1)!;
    const removed = latest.change.change === 'removed';
    const rows = versions.map((version): HistoryVersionRow => ({
      version: version.version,
      commit: version.commit.oid,
      ...(version.change.change === 'removed' ? {} : { path: version.change.kind === 'saved_query' ? sourcePathOf(version) : version.change.item }),
      at: version.commit.at,
      by: version.commit.author,
      change: version.change.change,
      ...(version.change.detail ? { detail: version.change.detail } : {}),
      state: stateOf(version.change),
      current: version === latest && !removed,
      canRestore: version.change.change !== 'removed' && (version !== latest || removed),
    })).reverse();
    let banner: HistoryItemResult['banner'] = null;
    if (!removed && latest.change.kind === 'saved_query' && !latest.change.certified) {
      const certified = [...versions].reverse().find((version) => version.change.certified);
      // A restore of a certified version is that version again, as a draft: the banner says so (V2).
      const restoredFrom = latest.change.change === 'restored' ? latest.commit.restoredFrom?.version : undefined;
      const restored = restoredFrom !== undefined && versions.find((version) => version.version === restoredFrom)?.change.certified ? restoredFrom : undefined;
      if (certified) banner = { draft: latest.version, certified: certified.version, ...(restored !== undefined ? { restored } : {}) };
    }
    return {
      item: { key: latest.change.item, kind: latest.change.kind, name: latest.change.name, removed, currentVersion: latest.version },
      versions: rows,
      banner,
    };
  }

  private findVersion(versions: ItemVersion[], version: number): ItemVersion {
    const found = versions.find((candidate) => candidate.version === version);
    if (!found) throw new HistoryError(`There is no v${version} of this item.`, 404, 'HISTORY_VERSION_NOT_FOUND');
    return found;
  }

  /** The files of an item as they were in one version: path → text. */
  async versionFiles(itemKey: string, version: number): Promise<{ version: number; files: Array<{ path: string; content: string }> }> {
    const found = this.findVersion(this.requireItem(itemKey), version);
    return { version, files: await this.filesAt(found) };
  }

  /** A saved query version's companion YAML path. */
  private companionPathOf(version: ItemVersion): string | undefined {
    return version.change.companion ?? this.index.itemMapper.companionOf(sourcePathOf(version)) ?? undefined;
  }

  private async filesAt(version: ItemVersion): Promise<Array<{ path: string; content: string }>> {
    if (version.change.change === 'removed') return [];
    const key = version.change.item;
    const paths = version.change.kind === 'app'
      ? [...(await this.store.files(version.commit.oid)).keys()].filter((path) => path.startsWith(`${key}/`)).sort()
      : version.change.kind === 'saved_query'
        ? [sourcePathOf(version), this.companionPathOf(version)].filter((path): path is string => Boolean(path))
        : [key];
    const out: Array<{ path: string; content: string }> = [];
    for (const path of paths) {
      const bytes = await this.store.readFile(version.commit.oid, path);
      if (bytes) out.push({ path, content: decoder.decode(bytes) });
    }
    return out;
  }

  private card(version: ItemVersion, files: Array<{ path: string; content: string }>): HistoryVersionCard {
    const companionPath = version.change.kind === 'saved_query' ? this.companionPathOf(version) : undefined;
    const companion = companionPath ? files.find((file) => file.path === companionPath)?.content ?? null : null;
    const receipt = version.change.certified ? receiptSummary(companion) : {};
    return {
      version: version.version,
      commit: version.commit.oid,
      ...(version.change.change === 'removed' ? {} : { path: version.change.kind === 'saved_query' ? sourcePathOf(version) : version.change.item }),
      at: version.commit.at,
      by: version.commit.author,
      state: stateOf(version.change),
      ...(receipt.certifiedBy ? { certifiedBy: receipt.certifiedBy } : {}),
      ...(receipt.oldReport ? { oldReport: receipt.oldReport } : {}),
    };
  }

  /** Two versions side by side: the SQL line by line, the saved query's fields, and every file of the item. */
  async compare(itemKey: string, fromVersion: number, toVersion: number): Promise<HistoryCompareResult> {
    const versions = this.requireItem(itemKey);
    const from = this.findVersion(versions, fromVersion);
    const to = this.findVersion(versions, toVersion);
    const fromFiles = await this.filesAt(from);
    const toFiles = await this.filesAt(to);
    const result: HistoryCompareResult = {
      item: this.item(itemKey).item,
      from: this.card(from, fromFiles),
      to: this.card(to, toFiles),
      files: [],
    };
    // A rename moves the files: they are compared by their place in the item, not by path.
    const role = (version: ItemVersion, path: string) => (version.change.kind === 'app' ? path.slice(version.change.item.length) : path === sourcePathOf(version) ? ':main' : ':companion');
    const fromByRole = new Map(fromFiles.map((file) => [role(from, file.path), file]));
    const toByRole = new Map(toFiles.map((file) => [role(to, file.path), file]));
    for (const key of [...new Set([...fromByRole.keys(), ...toByRole.keys()])].sort()) {
      const a = fromByRole.get(key);
      const b = toByRole.get(key);
      const lines = diffLines(a?.content ?? '', b?.content ?? '');
      result.files.push({
        path: b?.path ?? a!.path,
        status: !a ? 'added' : !b ? 'removed' : a.content === b.content ? 'same' : 'changed',
        lines,
        changed: changedLineCount(lines),
      });
    }
    if (to.change.kind === 'saved_query') {
      const aSource = fromByRole.get(':main')?.content ?? null;
      const bSource = toByRole.get(':main')?.content ?? null;
      // A draft edit's copy is named "<name> (draft edit)": compared, it keeps its name.
      const fieldsOf = (source: string | null) => {
        if (source === null) return null;
        const fields = readSavedQueryFields(source);
        return { ...fields, name: withoutDraftEditName(fields.name) };
      };
      const aFields = fieldsOf(aSource);
      const bFields = fieldsOf(bSource);
      const lines = diffLines(aFields?.sql ?? '', bFields?.sql ?? '');
      result.sql = { lines, changed: changedLineCount(lines) };
      result.fields = compareSavedQueryFields(aFields, bFields);
    }
    return result;
  }

  /** Runs both versions' SQL on the app's warehouse and lines the rows up: same, changed, new, removed. */
  async runBoth(itemKey: string, fromVersion: number, toVersion: number, run: HistoryRunner): Promise<HistoryRunCompare> {
    const versions = this.requireItem(itemKey);
    const from = this.findVersion(versions, fromVersion);
    const to = this.findVersion(versions, toVersion);
    if (to.change.kind !== 'saved_query') throw new HistoryError('Only saved queries are run to compare.', 400, 'HISTORY_NOT_RUNNABLE');
    const source = async (version: ItemVersion) => (await this.filesAt(version)).find((file) => file.path === sourcePathOf(version))?.content;
    const attempt = async (version: ItemVersion): Promise<HistoryRunResult & { error?: string }> => {
      const text = await source(version);
      if (!text) return { columns: [], rows: [], error: `v${version.version} has no SQL to run.` };
      try {
        return await run(text);
      } catch (error) {
        return { columns: [], rows: [], error: error instanceof Error ? error.message : String(error) };
      }
    };
    const a = await attempt(from);
    const b = await attempt(to);
    return alignResults(a, b);
  }

  // ── Restore ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Writes an old version back as the next version, always as a draft (H6): a saved query's status becomes draft
   * and its companion keeps no receipt, as any draft's. The old version, certified or not, stays exactly as it was.
   */
  restore(input: { item: string; version: number; user?: string }): Promise<HistoryRestoreResult> {
    return this.enqueue(async () => {
      const author: HistoryAuthor = input.user ? { name: input.user, kind: 'person' } : ZLENS_AUTHOR;
      // Anything not committed yet becomes its own version first, so the restore is exactly the restore.
      await this.commitNow(author, 'save', '');
      const versions = this.requireItem(input.item);
      const target = this.findVersion(versions, input.version);
      const latest = versions.at(-1)!;
      if (target.change.change === 'removed') throw new HistoryError(`v${input.version} is the removal: pick a version before it.`, 400, 'HISTORY_RESTORE_REMOVAL');
      if (target === latest) throw new HistoryError(`v${input.version} is already the current version.`, 409, 'HISTORY_ALREADY_CURRENT');
      if (target.change.kind === 'app' && this.options.apps) return this.restoreApp(author, versions, target);
      const destination = latest.change.item;
      const files = await this.filesAt(target);
      const written = this.writeVersion(target, destination, files);
      const next = latest.version + 1;
      const message = `Restored v${input.version} as v${next}`;
      const made = await this.commitNow(author, 'restore', message, { restoredFrom: { item: destination, version: input.version, commit: target.commit.oid } });
      if (!made.length) throw new HistoryError(`v${input.version} is the same as the current version: nothing to restore.`, 409, 'HISTORY_NOTHING_TO_RESTORE');
      const change = made.flatMap((commit) => commit.changes).find((candidate) => candidate.item === destination);
      try {
        await this.options.onRestored?.(written);
      } catch (error) {
        this.log('warn', `[zlens] Restored ${destination}, but ZLens could not reload it yet: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { item: destination, restored: input.version, version: change?.version ?? next, message, paths: written };
    });
  }

  /**
   * An App version back as an App Studio draft (V2): the App's live draft takes its content, or a new draft is made
   * (an edit of the published App when there is one; a removed App comes back as a new draft). Nothing is
   * published: the published App, if any, stays as it is until someone publishes the draft.
   */
  private async restoreApp(author: HistoryAuthor, versions: ItemVersion[], target: ItemVersion): Promise<HistoryRestoreResult> {
    const latest = versions.at(-1)!;
    const source = latest.change.item;
    const files = (await this.filesAt(target)).map((file) => ({ path: file.path.slice(target.change.item.length + 1), content: file.content }));
    if (!files.length) throw new HistoryError('That version has no files.', 404, 'HISTORY_VERSION_EMPTY');
    let written: { appId: string; draftId: string; name: string };
    try {
      // A removed App comes back as a new draft; an App that is there takes the version into its own draft.
      const removed = latest.change.change === 'removed';
      written = await this.options.apps!.restore({ appId: source.split('/').pop()!, files, asNew: removed });
    } catch (error) {
      if (error instanceof HistoryError) throw error;
      throw new HistoryError(`v${target.version} could not be restored as a draft: ${error instanceof Error ? error.message : String(error)}`, 409, 'HISTORY_RESTORE_FAILED');
    }
    const destination = `apps/${written.appId}`;
    const sameItem = destination === source;
    const next = latest.version + 1;
    const message = sameItem ? `Restored v${target.version} as v${next}` : `Restored v${target.version} as a new draft, "${written.name}"`;
    const made = await this.commitNow(author, 'restore', message, { restoredFrom: { item: source, version: target.version, commit: target.commit.oid } });
    const change = made.flatMap((commit) => commit.changes).find((candidate) => candidate.item === destination);
    if (!change) throw new HistoryError(`v${target.version} is the same as the App's draft now: nothing to restore.`, 409, 'HISTORY_NOTHING_TO_RESTORE');
    return {
      item: destination,
      restored: target.version,
      version: change.version,
      message,
      paths: [],
      appDraft: { id: written.draftId, appId: written.appId },
    };
  }

  private writeVersion(target: ItemVersion, destination: string, files: Array<{ path: string; content: string }>): string[] {
    const written: string[] = [];
    const write = (path: string, content: string) => {
      this.safeWrite(path, content);
      written.push(path);
    };
    if (target.change.kind === 'saved_query') {
      const source = files.find((file) => file.path === sourcePathOf(target))?.content;
      if (source === undefined) throw new HistoryError('That version has no saved query file.', 404, 'HISTORY_VERSION_EMPTY');
      const mapper = this.index.itemMapper;
      const read = (path: string | null | undefined) => (path && existsSync(join(this.root, path)) ? readFileSync(join(this.root, path), 'utf-8') : null);
      const canonicalNow = read(destination);
      const canonicalCompanionPath = mapper.companionOf(destination);
      if (canonicalNow !== null && isCertifiedVersion(canonicalNow, read(canonicalCompanionPath))) {
        // The certified saved query stays exactly as it is, still in use: the restored version becomes its draft
        // edit, saved beside it as any edit of a certified saved query is.
        write(this.besidePathFor(destination, canonicalNow), withDraftEditName(asDraftSource(source)));
        return written;
      }
      write(destination, asDraftSource(stripDraftEditName(source)));
      // The companion as a draft's: no receipt (a certified version's receipt stays in that version).
      const oldCompanion = sourcePathOf(target) === target.change.item ? files.find((file) => file.path === this.companionPathOf(target))?.content : undefined;
      const companion = oldCompanion ?? read(canonicalCompanionPath) ?? undefined;
      if (canonicalCompanionPath && companion !== undefined) write(canonicalCompanionPath, applyCompanionCertification(companion, 'draft', null));
      return written;
    }
    if (target.change.kind === 'app') {
      // The App Studio draft History keeps is not a project file: without an App source it is not written back.
      const wanted = new Map(files.filter((file) => !isAppStudioDraftPath(file.path)).map((file) => [`${destination}${file.path.slice(target.change.item.length)}`, file.content]));
      for (const path of listTrackedFiles(this.root).keys()) {
        if (path.startsWith(`${destination}/`) && !wanted.has(path)) {
          this.safePath(path);
          rmSync(join(this.root, path), { force: true });
          written.push(path);
        }
      }
      for (const [path, content] of wanted) write(path, content);
      return written;
    }
    const file = files.find((candidate) => candidate.path === target.change.item);
    if (!file) throw new HistoryError('That version has no file.', 404, 'HISTORY_VERSION_EMPTY');
    write(destination, file.content);
    return written;
  }

  /** A tracked path inside the project, through no symlink. */
  private safePath(path: string): string {
    if (!isTrackedPath(path)) throw new HistoryError('History writes saved queries, Apps, notebooks and model files only.', 400, 'HISTORY_NOT_TRACKED');
    const root = resolve(this.root);
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`)) throw new HistoryError('The path is outside the project.', 400, 'HISTORY_NOT_TRACKED');
    let current = root;
    for (const segment of path.split('/').slice(0, -1)) {
      current = join(current, segment);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new HistoryError('History does not write through a link.', 400, 'HISTORY_NOT_TRACKED');
    }
    return absolute;
  }

  /**
   * Where the draft edit of a certified saved query is kept: the one there is, else where saving an edit would put
   * it (`<drafts folder>/<slug>-<suffix>.dql`, local-runtime saveBlockStudioDraftArtifacts and draftBesideCanonical).
   */
  private besidePathFor(canonical: string, canonicalSource: string): string {
    const suffix = besideSuffix(canonical);
    const existing = [...listTrackedFiles(this.root).keys()].find((path) => isDraftPath(path) && besideSuffixOf(path) === suffix);
    if (existing) return existing;
    const fields = readSavedQueryFields(canonicalSource);
    const slug = withoutDraftEditName(fields.name).toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'block';
    const domain = fields.domain.trim().toLowerCase().replace(/[^a-z0-9/_-]+/g, '-').replace(/^\/+|\/+$/g, '') || 'uncategorized';
    return existsSync(join(this.root, 'domains'))
      ? `domains/${domain}/blocks/_drafts/${slug}-${suffix}.dql`
      : `blocks/_drafts/${domain}/${slug}-${suffix}.dql`;
  }

  private safeWrite(path: string, content: string): void {
    const absolute = this.safePath(path);
    mkdirSync(dirname(absolute), { recursive: true });
    // Opened in one step that refuses a symlink (O_NOFOLLOW): nothing can swap the file for a link in between.
    let fd: number;
    try {
      fd = openSync(absolute, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new HistoryError('History does not write through a link.', 400, 'HISTORY_NOT_TRACKED');
      throw error;
    }
    try {
      writeFileSync(fd, content, 'utf-8');
    } finally {
      closeSync(fd);
    }
  }

  // ── The SQL log and the repository's size ───────────────────────────────────────────────────────────────────

  /** The change rows the SQL log has not written yet, oldest first. */
  pendingSqlRows(): SqlLogRow[] {
    if (!this.sqlLog) return [];
    const last = this.sqlLog.readState().lastCommit;
    const commits = this.index.commits;
    const start = last ? commits.findIndex((commit) => commit.oid === last) + 1 : 0;
    return commits.slice(start).flatMap((commit) => commit.changes.filter((change) => commit.action !== 'trash' || change.change === 'removed').map((change) => ({
      commit: commit.oid,
      changedAt: commit.at,
      changedBy: commit.author.kind === 'ai' && commit.author.askedBy ? `${commit.author.name} for ${commit.author.askedBy}` : commit.author.name,
      item: change.name,
      kind: change.kind,
      version: change.version,
      change: change.change,
      certified: change.change === 'certified',
    })));
  }

  /** Writes the SQL log when the warehouse is running (or at the daily stop). Never throws. */
  flushSqlLog(options: { atStop?: boolean; force?: boolean } = {}): Promise<SqlLogState> {
    if (!this.sqlLog) return Promise.resolve('off');
    return this.enqueue(async () => {
      try {
        return await this.sqlLog!.flush(this.pendingSqlRows(), options);
      } catch {
        return 'skipped' as const;
      }
    });
  }

  private sqlLogSoon(): void {
    if (!this.sqlLog) return;
    if (this.sqlFlushTimer) clearTimeout(this.sqlFlushTimer);
    this.sqlFlushTimer = setTimeout(() => {
      this.sqlFlushTimer = undefined;
      void this.flushSqlLog();
    }, 60_000);
    this.sqlFlushTimer.unref?.();
  }

  async status(): Promise<{
    enabled: true;
    versions: number;
    items: number;
    sizeBytes: number;
    warnAtBytes: number;
    sizeWarning: boolean;
    sqlLog: { state: SqlLogState; table: string | null; pending: number; lastWrittenAt?: string };
  }> {
    const now = Date.now();
    if (!this.sizeCache || now - this.sizeCache.at > 60_000) this.sizeCache = { at: now, bytes: await this.store.sizeBytes() };
    const items = new Set(this.index.commits.flatMap((commit) => commit.changes.map((change) => this.index.currentKey(change.item))));
    const sql = this.sqlLog?.status();
    return {
      enabled: true,
      versions: this.index.commits.length,
      items: items.size,
      sizeBytes: this.sizeCache.bytes,
      warnAtBytes: HISTORY_SIZE_WARNING_BYTES,
      sizeWarning: this.sizeCache.bytes >= HISTORY_SIZE_WARNING_BYTES,
      sqlLog: sql
        ? { state: sql.state, table: sql.table, pending: this.pendingSqlRows().length, ...(sql.lastWrittenAt ? { lastWrittenAt: sql.lastWrittenAt } : {}) }
        : { state: 'off', table: null, pending: 0 },
    };
  }

  /** The Git-history response the saved query's History tab has always read (`/api/blocks/history`). */
  blockHistory(path: string): { entries: Array<{ hash: string; date: string; author: string; message: string }>; status: 'ok' } {
    if (!isTrackedItemKey(path)) return { entries: [], status: 'ok' };
    const versions = this.index.versions(path).length ? this.index.versions(path) : this.index.versions(this.index.itemKeyFor(path));
    return {
      status: 'ok',
      entries: versions.map((version) => ({
        hash: version.commit.oid,
        date: version.commit.at,
        author: version.commit.author.kind === 'ai' && version.commit.author.askedBy ? `${version.commit.author.name} for ${version.commit.author.askedBy}` : version.commit.author.name,
        message: `v${version.version} ${version.change.change}${version.change.detail ? `: ${version.change.detail}` : ''}`,
      })).reverse(),
    };
  }
}

/** The file holding a saved query version's source: its draft edit, when it was one. */
function sourcePathOf(version: ItemVersion): string {
  return version.change.source ?? version.change.item;
}

const DRAFT_EDIT = ' (draft edit)';

/** A draft edit's copy is named `<name> (draft edit)`, so nothing looking a name up picks it over the certified one. */
function withDraftEditName(source: string): string {
  return source.replace(/(\bblock\s+")([^"]*)(")/, (match, open: string, name: string, close: string) => (name.endsWith(DRAFT_EDIT) ? match : `${open}${name}${DRAFT_EDIT}${close}`));
}

function stripDraftEditName(source: string): string {
  return source.replace(/(\bblock\s+")([^"]*)(")/, (_match, open: string, name: string, close: string) => `${open}${withoutDraftEditName(name)}${close}`);
}

function stateOf(change: IndexedChange): HistoryVersionRow['state'] {
  if (change.change === 'removed') return 'removed';
  if (change.kind !== 'saved_query') return 'saved';
  return change.certified ? 'certified' : 'draft';
}

function authorMatches(author: HistoryAuthor, by: string | undefined): boolean {
  if (!by || by === 'anyone') return true;
  if (by === 'ai') return author.kind === 'ai';
  if (by === 'zlens') return author.kind === 'zlens';
  if (by.startsWith('person:')) {
    // A person's own saves; their automatic Ask drafts are under "AI drafts".
    const name = by.slice('person:'.length).toUpperCase();
    return author.kind === 'person' && author.name.toUpperCase() === name;
  }
  return true;
}

export function actionForRequest(method: string, path: string): HistoryAction {
  if (path === '/api/blocks/ask-drafts/clear') return 'clear-drafts';
  if (/\/certify$/.test(path)) return 'certify';
  if (method === 'DELETE') return 'delete';
  return 'save';
}

function names(changes: PendingChange[]): string {
  const items = [...new Set(changes.map((change) => appKeyOf(change.path)?.split('/').pop() ?? change.path.split('/').pop()!.replace(/\.[a-z]+$/i, '')))];
  return items.length <= 3 ? items.join(', ') : `${items.length} items`;
}

function defaultMessage(action: HistoryAction, changes: PendingChange[]): string {
  const what = names(changes.filter((change) => !change.path.startsWith('semantic-layer/blocks/')).length ? changes.filter((change) => !change.path.startsWith('semantic-layer/blocks/')) : changes);
  switch (action) {
    case 'start': return STARTED;
    case 'found': return 'Changes found when ZLens started';
    case 'certify': return `Certified ${what}`;
    case 'clear-drafts': return `Cleared ${changes.filter((change) => change.path.endsWith('.dql')).length} automatic Ask drafts`;
    case 'delete': return `Removed ${what}`;
    case 'upgrade': {
      const removed = changes.filter((change) => change.content === null && isAppStudioDraftPath(change.path)).length;
      if (removed && removed === changes.length) return removed === 1 ? 'An empty copy of another App, moved to the trash' : `${removed} empty copies of other Apps, moved to the trash`;
      return `Updated ${what}`;
    }
    case 'ask': return `Drafted from Ask: ${what}`;
    default: return `Saved ${what}`;
  }
}

/** Lines two results up by their text columns; numbers are what is compared. */
export function alignResults(
  a: HistoryRunResult & { error?: string },
  b: HistoryRunResult & { error?: string },
): HistoryRunCompare {
  const shared = a.columns.filter((column) => b.columns.includes(column));
  const isNumber = (value: unknown) => typeof value === 'number' || typeof value === 'bigint';
  const numericIn = (rows: Array<Record<string, unknown>>, column: string) => rows.length > 0 && rows.every((row) => row[column] === null || row[column] === undefined || isNumber(row[column]));
  let keyColumns = shared.filter((column) => !(numericIn(a.rows, column) && numericIn(b.rows, column)));
  // A first column of years or ids is still the key when every other shared column is a number too.
  if (!keyColumns.length && shared.length) keyColumns = [shared[0]!];
  const valueColumns = [...new Set([...a.columns, ...b.columns])].filter((column) => !keyColumns.includes(column));
  const keyOf = (row: Record<string, unknown>) => JSON.stringify(keyColumns.map((column) => normal(row[column])));
  const values = (row: Record<string, unknown>) => valueColumns.map((column) => normal(row[column]));
  const left = new Map<string, Record<string, unknown>>();
  for (const row of a.rows) if (!left.has(keyOf(row))) left.set(keyOf(row), row);
  const seen = new Set<string>();
  const rows: HistoryRunCompare['rows'] = [];
  const summary = { same: 0, changed: 0, new: 0, removed: 0 };
  for (const row of b.rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const before = left.get(key);
    const state = !before ? 'new' : JSON.stringify(values(before)) === JSON.stringify(values(row)) ? 'same' : 'changed';
    summary[state] += 1;
    rows.push({ key: keyColumns.map((column) => normal(row[column])), from: before ? values(before) : null, to: values(row), state });
  }
  for (const [key, row] of left) {
    if (seen.has(key)) continue;
    summary.removed += 1;
    rows.push({ key: keyColumns.map((column) => normal(row[column])), from: values(row), to: null, state: 'removed' });
  }
  return {
    from: { columns: a.columns, rowCount: a.rows.length, ...(a.error ? { error: a.error } : {}) },
    to: { columns: b.columns, rowCount: b.rows.length, ...(b.error ? { error: b.error } : {}) },
    keyColumns,
    valueColumns,
    rows,
    summary,
  };
}

function normal(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}
