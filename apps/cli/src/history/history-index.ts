import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileChange, HistoryAuthor, HistoryAction, HistoryRestoredFrom, HistoryStore, StoredCommit } from './history-store.js';
import { APP_STUDIO_DRAFT_FILE, HistoryItemMapper, domainNameFrom, humanizeName, readableFileLabel, type BlockLookups, type HistoryItemKind, type HistoryItemRef } from './tracked-files.js';
import { isCertifiedVersion, readSavedQueryFields, receiptSummary, type SavedQueryFields } from './saved-query-fields.js';
import { appDraftShape, appEditWords, parseAppDraftHistoryText, publishedAppShape, type AppVersionShape } from './app-drafts.js';

/**
 * THE ITEM VERSION INDEX (V15): for each item, the commits that changed it, numbered v1, v2, … .
 *
 * Everything here is worked out from the repository (the tree differences and the commit messages), so the index
 * is a cache: it is kept beside the repository as one JSON file, and rebuilt from the commits when it is missing,
 * unreadable or behind. History of a busy item is then a lookup instead of a walk through every commit.
 */
export type HistoryChangeKind = 'started' | 'created' | 'drafted' | 'edited' | 'renamed' | 'certified' | 'removed' | 'restored' | 'published';

export interface IndexedChange {
  /** The item's key after this change (its path; `apps/<id>` for an App). */
  item: string;
  kind: HistoryItemKind;
  name: string;
  version: number;
  change: HistoryChangeKind;
  /** This version is certified (the saved query's receipt is for exactly this source). */
  certified: boolean;
  /** The item's key before a rename or move. */
  from?: string;
  /** The files of the item this change touched. */
  files: string[];
  /** A saved query: the file holding this version's source (the draft edit beside it, when there is one). */
  source?: string;
  /** A saved query: that source's companion YAML. */
  companion?: string;
  /** One line about it: the Ask question, the old report, what changed. Never row values. */
  detail?: string;
}

export interface IndexedCommit {
  oid: string;
  at: string;
  author: HistoryAuthor;
  action: HistoryAction;
  message: string;
  restoredFrom?: HistoryRestoredFrom;
  changes: IndexedChange[];
}

/**
 * The saved index's format. 2 (V2): App Studio drafts are Apps' versions, and items have readable names; an index
 * saved in an older format is rebuilt from the commits on the next start, so names already shown change too.
 */
const INDEX_FORMAT = 2;

interface IndexFile {
  format: typeof INDEX_FORMAT;
  head: string | null;
  commits: IndexedCommit[];
}

export interface ItemVersion {
  version: number;
  commitIndex: number;
  change: IndexedChange;
  commit: IndexedCommit;
}

const INDEX_FILE = 'zlens-index.json';
const MAX_DETAIL = 240;

const clip = (value: string) => (value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL - 1)}…` : value);
const decoder = new TextDecoder('utf-8');

export class HistoryIndex {
  head: string | null = null;
  commits: IndexedCommit[] = [];
  private byItem = new Map<string, Array<{ commit: number; change: number }>>();
  private movedTo = new Map<string, string>();
  /** The tracked files at `head`, path → blob id, kept while indexing. */
  private files = new Map<string, string>();
  /** Who owns what among the files at `head` (companions, draft edits). */
  private lookups: BlockLookups;
  private readonly mapper: HistoryItemMapper;

  constructor(private readonly store: HistoryStore, projectRoot: string, private readonly indexPath = join(store.location, INDEX_FILE)) {
    this.mapper = new HistoryItemMapper(projectRoot);
    this.lookups = this.mapper.lookups([]);
  }

  get itemMapper(): HistoryItemMapper {
    return this.mapper;
  }

  /** Loads the saved index when it is the repository's, else rebuilds it from the commits. */
  async load(): Promise<{ rebuilt: boolean }> {
    const head = await this.store.head();
    try {
      if (existsSync(this.indexPath)) {
        const saved = JSON.parse(readFileSync(this.indexPath, 'utf-8')) as IndexFile;
        if (saved?.format === INDEX_FORMAT && Array.isArray(saved.commits) && saved.head === head) {
          this.commits = saved.commits;
          this.head = saved.head;
          this.files = await this.store.files();
          this.rederive();
          return { rebuilt: false };
        }
      }
    } catch {
      // An unreadable index is rebuilt.
    }
    await this.rebuild();
    return { rebuilt: true };
  }

  /** Rebuilds the whole index from the repository. */
  async rebuild(): Promise<void> {
    this.commits = [];
    this.head = null;
    this.byItem.clear();
    this.movedTo.clear();
    this.files = new Map();
    this.lookups = this.mapper.lookups([]);
    const log = (await this.store.log()).reverse();
    for (const commit of log) await this.append(commit, await this.store.diff(commit.parent, commit.oid), { persist: false });
    this.persist();
  }

  /** Re-derives the lookups from `commits` (after loading the saved index). */
  private rederive(): void {
    this.byItem.clear();
    this.movedTo.clear();
    this.commits.forEach((commit, commitIndex) => commit.changes.forEach((change, changeIndex) => this.link(change, commitIndex, changeIndex)));
    this.lookups = this.mapper.lookups(this.files.keys());
  }

  private link(change: IndexedChange, commitIndex: number, changeIndex: number): void {
    const ref = { commit: commitIndex, change: changeIndex };
    if (change.from && change.from !== change.item) {
      const earlier = this.byItem.get(change.from) ?? [];
      this.byItem.delete(change.from);
      this.movedTo.set(change.from, change.item);
      this.byItem.set(change.item, [...earlier, ref]);
    } else {
      const list = this.byItem.get(change.item) ?? [];
      list.push(ref);
      this.byItem.set(change.item, list);
    }
    this.movedTo.delete(change.item);
  }

  private persist(): void {
    const file: IndexFile = { format: INDEX_FORMAT, head: this.head, commits: this.commits };
    const temp = `${this.indexPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(file), 'utf-8');
    renameSync(temp, this.indexPath);
  }

  private async text(oid: string | null | undefined): Promise<string | null> {
    if (!oid) return null;
    try {
      return decoder.decode(await this.store.readBlob(oid));
    } catch {
      return null;
    }
  }

  /** Adds one commit (the newest) to the index. */
  async append(commit: StoredCommit, diff: FileChange[], options: { persist?: boolean } = {}): Promise<IndexedCommit> {
    const before = this.files;
    const after = new Map(before);
    for (const change of diff) {
      if (change.after) after.set(change.path, change.after);
      else after.delete(change.path);
    }
    const touchesBlocks = diff.some((change) => change.path.endsWith('.dql') || change.path.startsWith('semantic-layer/blocks/'));
    const beforeLookups = this.lookups;
    const afterLookups = touchesBlocks ? this.mapper.lookups(after.keys()) : beforeLookups;
    const grouped = new Map<string, { ref: HistoryItemRef; files: string[] }>();
    for (const change of diff) {
      const ref = this.mapper.itemFor(change.path, afterLookups, beforeLookups);
      const group = grouped.get(ref.key) ?? { ref, files: [] };
      group.files.push(change.path);
      grouped.set(ref.key, group);
    }

    const mainFile = (ref: HistoryItemRef) => (ref.kind === 'app' ? `${ref.key}/dql.app.json` : ref.key);
    type Pending = { ref: HistoryItemRef; files: string[]; existed: boolean; exists: boolean };
    const pending: Pending[] = [...grouped.values()].map(({ ref, files }) => ({
      ref,
      files: files.sort(),
      existed: before.has(mainFile(ref)) || (ref.kind === 'app' && files.some((path) => before.has(path))),
      exists: after.has(mainFile(ref)) || (ref.kind === 'app' && files.some((path) => after.has(path))),
    }));

    // A rename or move: in one commit, one item of a kind went and one came (certifying a draft moves it too).
    const renamedFrom = new Map<string, string>();
    for (const kind of ['saved_query', 'app', 'notebook'] as HistoryItemKind[]) {
      const gone = pending.filter((item) => item.ref.kind === kind && item.existed && !item.exists);
      const came = pending.filter((item) => item.ref.kind === kind && !item.existed && item.exists);
      if (gone.length === 1 && came.length === 1 && commit.action !== 'start') {
        renamedFrom.set(came[0]!.ref.key, gone[0]!.ref.key);
      }
    }
    const renamedAway = new Set(renamedFrom.values());

    const changes: IndexedChange[] = [];
    for (const item of pending) {
      if (renamedAway.has(item.ref.key)) continue;
      const from = renamedFrom.get(item.ref.key);
      const history = this.byItem.get(from ?? item.ref.key) ?? [];
      const previous = history.length ? this.changeAt(history[history.length - 1]!) : undefined;
      const version = (previous?.version ?? 0) + 1;
      const filesTouched = from
        ? [...item.files, ...(pending.find((other) => other.ref.key === from)?.files ?? [])].sort()
        : item.files;
      const described = await this.describe(commit, item.ref, { existed: item.existed || Boolean(from), exists: item.exists, from, previous, before, after, beforeLookups, afterLookups });
      changes.push({
        item: item.ref.key,
        kind: item.ref.kind,
        name: described.name,
        version,
        change: described.change,
        certified: described.certified,
        ...(from ? { from } : {}),
        files: filesTouched,
        ...(described.source ? { source: described.source } : {}),
        ...(described.companion ? { companion: described.companion } : {}),
        ...(described.detail ? { detail: clip(described.detail) } : {}),
      });
    }
    changes.sort((a, b) => a.item.localeCompare(b.item));

    const indexed: IndexedCommit = {
      oid: commit.oid,
      at: commit.at,
      author: commit.author,
      action: commit.action,
      message: commit.message,
      ...(commit.restoredFrom ? { restoredFrom: commit.restoredFrom } : {}),
      changes,
    };
    const commitIndex = this.commits.push(indexed) - 1;
    changes.forEach((change, changeIndex) => this.link(change, commitIndex, changeIndex));
    this.lookups = afterLookups;
    this.files = after;
    this.head = commit.oid;
    if (options.persist !== false) this.persist();
    return indexed;
  }

  private changeAt(ref: { commit: number; change: number }): IndexedChange {
    return this.commits[ref.commit]!.changes[ref.change]!;
  }

  private async describe(
    commit: StoredCommit,
    ref: HistoryItemRef,
    state: {
      existed: boolean;
      exists: boolean;
      from?: string;
      previous?: IndexedChange;
      before: Map<string, string>;
      after: Map<string, string>;
      beforeLookups: BlockLookups;
      afterLookups: BlockLookups;
    },
  ): Promise<{ name: string; change: HistoryChangeKind; certified: boolean; detail?: string; source?: string; companion?: string }> {
    const fallbackName = (key: string) => key.split('/').pop()!.replace(/\.(dql|dqlnb|ya?ml|json|md|sql)$/i, '');
    if (ref.kind === 'saved_query') {
      // A version's source: the draft edit beside a certified saved query when there is one, else the file itself.
      const versionOf = async (key: string, files: Map<string, string>, lookups: BlockLookups) => {
        if (!files.has(key)) return null;
        const beside = lookups.besideOf.get(key);
        const sourcePath = beside && files.has(beside) ? beside : key;
        const companionPath = this.mapper.companionOf(sourcePath);
        const source = await this.text(files.get(sourcePath));
        const companion = companionPath ? await this.text(files.get(companionPath)) : null;
        if (source === null) return null;
        return {
          sourcePath,
          companionPath: companionPath && files.has(companionPath) ? companionPath : undefined,
          draftEdit: sourcePath !== key,
          fields: readSavedQueryFields(source),
          companion,
          certified: sourcePath === key && isCertifiedVersion(source, companion),
        };
      };
      const now = state.exists ? await versionOf(ref.key, state.after, state.afterLookups) : null;
      const old = state.existed ? await versionOf(state.from ?? ref.key, state.before, state.beforeLookups) : null;
      const certified = Boolean(now?.certified);
      const name = withoutDraftEditName(now?.fields.name || old?.fields.name || state.previous?.name || fallbackName(ref.key));
      let kind = this.changeKind(commit, state, certified, Boolean(state.previous?.certified));
      let detail: string | undefined;
      if (now && old && !now.draftEdit && old.draftEdit && kind !== 'certified' && kind !== 'restored' && kind !== 'removed') {
        // The draft edit beside a certified saved query went away without being certified.
        kind = 'edited';
        detail = certified ? 'Draft edit discarded: the certified version is current' : 'Draft edit removed';
      } else if (kind === 'certified') {
        detail = receiptSummary(now?.companion ?? null).oldReport ?? undefined;
      } else if (kind === 'drafted' || (kind === 'created' && commit.author.kind === 'ai')) {
        detail = now?.fields.sourceQuestion ? `From Ask: "${now.fields.sourceQuestion}"` : 'From Ask';
      } else if (kind === 'renamed') {
        const oldName = old ? withoutDraftEditName(old.fields.name) : '';
        detail = oldName && oldName !== name ? `Was "${oldName}"` : `Moved from ${state.from}`;
      } else if (kind === 'edited') {
        const words = savedQueryEditWords(old?.fields ?? null, now?.fields ?? null);
        detail = now?.draftEdit && !old?.draftEdit && state.previous?.certified
          ? `Draft edit of certified v${state.previous.version}${words ? `. ${words}` : ''}`
          : words;
        if (now?.draftEdit && !detail?.includes('Not certified yet')) detail = [detail, 'Not certified yet'].filter(Boolean).join('. ');
      } else if (kind === 'restored' && commit.restoredFrom) {
        detail = `Restored v${commit.restoredFrom.version} as v${(state.previous?.version ?? 0) + 1}, as a draft`;
      } else if (kind === 'removed') {
        detail = removedWords(commit);
      }
      return {
        name,
        change: kind,
        certified,
        ...(detail ? { detail } : {}),
        ...(now ? { source: now.sourcePath } : {}),
        ...(now?.companionPath ? { companion: now.companionPath } : {}),
      };
    }
    if (ref.kind === 'app') return this.describeApp(commit, ref, state);
    const files = state.exists ? state.after : state.before;
    const name = ref.kind === 'notebook'
      ? (await this.itemName(ref, files)) || state.previous?.name || fallbackName(ref.key)
      : await this.fileLabel(ref.key, files);
    const kind = this.changeKind(commit, state, false, false);
    let detail: string | undefined;
    if (kind === 'renamed') detail = `Moved from ${state.from}`;
    else if (kind === 'restored') detail = this.restoredWords(commit, ref, state);
    else if (kind === 'removed') detail = removedWords(commit);
    return { name, change: kind, certified: false, ...(detail ? { detail } : {}) };
  }

  /** "Restored v2 as v5", or, for a copy made as a new item, which item and version it came from. */
  private restoredWords(commit: StoredCommit, ref: HistoryItemRef, state: { from?: string; previous?: IndexedChange }): string | undefined {
    const from = commit.restoredFrom;
    if (!from) return undefined;
    const asDraft = ref.kind === 'saved_query' || ref.kind === 'app' ? ', as a draft' : '';
    if (from.item !== ref.key && from.item !== state.from) {
      const history = this.byItem.get(this.currentKey(from.item));
      const source = history?.length ? this.changeAt(history[history.length - 1]!).name : undefined;
      return `Restored from v${from.version}${source ? ` of "${source}"` : ''}${asDraft}`;
    }
    return `Restored v${from.version} as v${(state.previous?.version ?? 0) + 1}${asDraft}`;
  }

  /** A model, domain or semantic layer file's readable name ("Model: Tpch core"), with its domain's own name. */
  private async fileLabel(path: string, files: Map<string, string>): Promise<string> {
    const domain = /^domains\/([^/]+)\//.exec(path)?.[1];
    let domainName: string | undefined;
    if (domain) {
      for (const candidate of [`domains/${domain}/domain.dql`, `domains/${domain}/domain.yaml`, `domains/${domain}/domain.yml`]) {
        domainName = domainNameFrom(await this.text(files.get(candidate)));
        if (domainName) break;
      }
    }
    return readableFileLabel(path, domainName);
  }

  /**
   * An App's change, in words (V2). Its versions are its App Studio draft's saves and its published files: creating
   * it, adding or removing tiles and pages, renaming it, publishing it, discarding a draft, deleting it.
   */
  private async describeApp(
    commit: StoredCommit,
    ref: HistoryItemRef,
    state: { existed: boolean; exists: boolean; from?: string; previous?: IndexedChange; before: Map<string, string>; after: Map<string, string> },
  ): Promise<{ name: string; change: HistoryChangeKind; certified: false; detail?: string }> {
    const now = state.exists ? await this.appShape(ref.key, state.after) : null;
    const old = state.existed ? await this.appShape(state.from ?? ref.key, state.before) : null;
    const nameOf = (shape: { draft: AppVersionShape | null; published: AppVersionShape | null } | null) => shape?.draft?.name || shape?.published?.name;
    const name = nameOf(now) || nameOf(old) || state.previous?.name || humanizeName(ref.key.split('/').pop() ?? ref.key);
    let kind = this.changeKind(commit, state, false, false);
    let detail: string | undefined;
    const tilesWords = (shape: AppVersionShape) => `${shape.pages} page${shape.pages === 1 ? '' : 's'}, ${shape.tiles} tile${shape.tiles === 1 ? '' : 's'}`;
    if (kind === 'removed') {
      detail = removedWords(commit);
    } else if (kind === 'restored') {
      detail = this.restoredWords(commit, ref, state);
    } else if (kind === 'created') {
      if (commit.action === 'trash') detail = 'As it was when it went to the trash';
      else if (commit.action === 'found' && now?.draft && !now.published) detail = 'In App Studio, not published yet. First kept when ZLens started';
      else if (now?.draft && !now.published) detail = 'In App Studio, not published yet';
      else if (now?.published) detail = `Published: ${tilesWords(now.published)}`;
    } else if (kind === 'renamed') {
      const oldName = nameOf(old);
      detail = oldName && oldName !== name ? `Was "${oldName}"` : `Moved from ${state.from}`;
    } else if (kind === 'edited' && now && old) {
      const publishedChanged = Boolean(now.published) && (!old.published || old.published.content !== now.published!.content || old.published.settings !== now.published!.settings || old.published.name !== now.published!.name);
      if (now.published && !now.draft && (old.draft || !old.published) && publishedChanged) {
        kind = 'published';
        detail = tilesWords(now.published);
      } else if (old.draft && !now.draft && now.published && !publishedChanged) {
        detail = 'Draft discarded. The published App did not change';
      } else {
        // A draft's change says what changed from the version before, the published App's or the draft's own.
        const before = old.draft ?? old.published;
        const after = now.draft ?? now.published;
        const oldName = nameOf(old);
        const words = appEditWords(before, after);
        if (oldName && oldName !== name) {
          kind = 'renamed';
          detail = [`Was "${oldName}"`, words].filter(Boolean).join('. ');
        } else {
          detail = words ?? 'Saved';
        }
        if (now.draft && now.published) detail = `${detail}. Not published yet`;
      }
    }
    return { name, change: kind, certified: false, ...(detail ? { detail } : {}) };
  }

  /** An App's draft and published shapes in one version (from the files at that commit). */
  private async appShape(key: string, files: Map<string, string>): Promise<{ draft: AppVersionShape | null; published: AppVersionShape | null }> {
    const draftFile = parseAppDraftHistoryText(await this.text(files.get(`${key}/${APP_STUDIO_DRAFT_FILE}`)));
    const appText = await this.text(files.get(`${key}/dql.app.json`));
    let published: AppVersionShape | null = null;
    if (appText !== null) {
      const pages: string[] = [];
      for (const path of [...files.keys()].filter((candidate) => candidate.startsWith(`${key}/dashboards/`) && candidate.endsWith('.dqld')).sort()) {
        pages.push((await this.text(files.get(path))) ?? '');
      }
      published = publishedAppShape(appText, pages);
    }
    return { draft: draftFile ? appDraftShape(draftFile) : null, published };
  }

  private changeKind(commit: StoredCommit, state: { existed: boolean; exists: boolean; from?: string }, certified: boolean, wasCertified: boolean): HistoryChangeKind {
    if (commit.action === 'start') return 'started';
    if (!state.exists) return 'removed';
    if (commit.action === 'restore') return 'restored';
    if (certified && (!wasCertified || commit.action === 'certify')) return 'certified';
    if (!state.existed) return commit.author.kind === 'ai' ? 'drafted' : 'created';
    if (state.from) return 'renamed';
    return 'edited';
  }

  private async itemName(ref: HistoryItemRef, files: Map<string, string>): Promise<string | undefined> {
    if (ref.kind !== 'app' && ref.kind !== 'notebook') return undefined;
    const text = await this.text(files.get(ref.kind === 'app' ? `${ref.key}/dql.app.json` : ref.key));
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as { title?: unknown; name?: unknown; metadata?: { title?: unknown } };
      const title = [parsed.title, parsed.name, parsed.metadata?.title].find((value) => typeof value === 'string' && value.trim());
      return typeof title === 'string' ? title.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every version of an item, oldest first (following renames). Empty when History has never seen it. */
  versions(itemKey: string): ItemVersion[] {
    let key = itemKey;
    for (let hops = 0; !this.byItem.has(key) && this.movedTo.has(key) && hops < 50; hops += 1) key = this.movedTo.get(key)!;
    return (this.byItem.get(key) ?? []).map((ref) => {
      const change = this.changeAt(ref);
      return { version: change.version, commitIndex: ref.commit, change, commit: this.commits[ref.commit]! };
    });
  }

  /**
   * The item a path is part of now: a saved query for its companion YAML or for the draft edit saved beside it,
   * else the path itself (then followed through renames by `versions`).
   */
  itemKeyFor(path: string): string {
    const ref = this.mapper.itemFor(path, this.lookups);
    return ref.key;
  }

  /** The item key an older key now goes by (after a rename), or the key itself. */
  currentKey(itemKey: string): string {
    let key = itemKey;
    for (let hops = 0; !this.byItem.has(key) && this.movedTo.has(key) && hops < 50; hops += 1) key = this.movedTo.get(key)!;
    return key;
  }

  /** Every tracked path at the newest commit. */
  headFiles(): Map<string, string> {
    return new Map(this.files);
  }
}

/** The name a saved query keeps: a draft edit's copy is named `<name> (draft edit)`. */
export function withoutDraftEditName(name: string): string {
  return name.endsWith(' (draft edit)') ? name.slice(0, -' (draft edit)'.length) : name;
}

function savedQueryEditWords(before: SavedQueryFields | null, after: SavedQueryFields | null): string | undefined {
  if (!before || !after) return undefined;
  const parts: string[] = [];
  if (before.sql !== after.sql) parts.push('SQL');
  if (withoutDraftEditName(before.name) !== withoutDraftEditName(after.name)) parts.push('name');
  if (before.description !== after.description) parts.push('description');
  if (before.owner !== after.owner) parts.push('owner');
  if (before.tags.join('\u0000') !== after.tags.join('\u0000')) parts.push('tags');
  if (before.chart !== after.chart) parts.push('chart');
  if (before.domain !== after.domain) parts.push('domain');
  const status = before.status !== after.status ? `Status ${before.status} became ${after.status}` : '';
  if (!parts.length) return status || 'Settings changed';
  const words = `${parts[0]![0]!.toUpperCase()}${parts[0]!.slice(1)}${parts.length > 1 ? `, ${parts.slice(1).join(', ')}` : ''} changed`;
  return [words, after.status === 'draft' && before.status === 'certified' ? 'Not certified yet' : status].filter(Boolean).join('. ');
}

function removedWords(commit: StoredCommit): string | undefined {
  if (commit.action === 'clear-drafts') return 'An automatic Ask draft nobody edited. It can be restored from History';
  if (commit.action === 'upgrade') return `${commit.message}. It can be restored from History`;
  if (commit.action === 'trash') return `${commit.message}. It can be restored from History`;
  return 'It can be restored from History';
}
