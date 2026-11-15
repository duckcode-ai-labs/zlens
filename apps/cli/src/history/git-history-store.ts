import * as fs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// The core module only: isomorphic-git's network client (`isomorphic-git/http/*`) is never imported. History in
// V15 makes no outside connection (ZLENS_NO_EGRESS); V16 adds a remote behind the same interface.
import git from 'isomorphic-git';
import {
  formatCommitMessage,
  parseCommitMessage,
  type FileChange,
  type HistoryCommitInput,
  type HistoryStore,
  type StoredCommit,
} from './history-store.js';

const BRANCH = 'main';
const REF = `refs/heads/${BRANCH}`;
const FILE_MODE = '100644';
const TREE_MODE = '040000';

type TreeEntry = { mode: string; path: string; oid: string; type: 'blob' | 'tree' | 'commit' };

/**
 * History as a Git repository of its own: a bare repository (objects, refs, no working copy) in a folder ZLens
 * owns, beside the project files on the same volume (by default `<project>/.dql/history`). The project's own
 * `.git`, if it has one, is never read or written. Commits are built directly from blobs and trees, so there is no
 * index file to keep in step and no Git program is needed. Commits form one line: each has the one before as its
 * parent.
 */
export class GitHistoryStore implements HistoryStore {
  readonly location: string;
  private headFiles: Map<string, string> | undefined;
  private headOid: string | null | undefined;
  private readonly treeCache = new Map<string, { signature: string; oid: string }>();
  private readonly cache = {};

  constructor(gitdir: string) {
    this.location = gitdir;
  }

  private get base() {
    return { fs, gitdir: this.location, cache: this.cache };
  }

  async open(): Promise<{ created: boolean }> {
    const created = !existsSync(join(this.location, 'HEAD'));
    if (created) {
      mkdirSync(this.location, { recursive: true });
      await git.init({ fs, gitdir: this.location, bare: true, defaultBranch: BRANCH });
    }
    // An outer Git (the project exported and put in a repository) ignores this folder.
    const ignore = join(this.location, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf-8');
    return { created };
  }

  async head(): Promise<string | null> {
    if (this.headOid !== undefined) return this.headOid;
    try {
      this.headOid = await git.resolveRef({ fs, gitdir: this.location, ref: REF });
    } catch {
      this.headOid = null;
    }
    return this.headOid;
  }

  async files(commit?: string): Promise<Map<string, string>> {
    const oid = commit ?? await this.head();
    if (!oid) return new Map();
    if (!commit && this.headFiles) return new Map(this.headFiles);
    const { commit: parsed } = await git.readCommit({ ...this.base, oid });
    const files = new Map<string, string>();
    await this.walkTree(parsed.tree, '', files);
    if (!commit) this.headFiles = new Map(files);
    return files;
  }

  private async walkTree(treeOid: string, prefix: string, into: Map<string, string>): Promise<void> {
    const { tree } = await git.readTree({ ...this.base, oid: treeOid });
    for (const entry of tree) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'tree') await this.walkTree(entry.oid, path, into);
      else if (entry.type === 'blob') into.set(path, entry.oid);
    }
  }

  async commit(input: HistoryCommitInput): Promise<StoredCommit> {
    const parent = await this.head();
    const files = await this.files();
    for (const change of input.changes) {
      if (change.content === null) {
        files.delete(change.path);
      } else {
        const oid = await git.writeBlob({ fs, gitdir: this.location, blob: change.content });
        files.set(change.path, oid);
      }
    }
    const tree = await this.writeTrees(files);
    const when = input.at ?? new Date();
    const signature = { name: input.author.name, email: '', timestamp: Math.floor(when.getTime() / 1000), timezoneOffset: 0 };
    const message = formatCommitMessage(input);
    const oid = await git.writeCommit({
      fs,
      gitdir: this.location,
      commit: { message, tree, parent: parent ? [parent] : [], author: signature, committer: signature },
    });
    await git.writeRef({ fs, gitdir: this.location, ref: REF, value: oid, force: true });
    this.headOid = oid;
    this.headFiles = files;
    return {
      oid,
      parent,
      at: new Date(signature.timestamp * 1000).toISOString(),
      ...parseCommitMessage(message, input.author.name),
    };
  }

  /** Writes the tree of every folder (reusing a folder's tree when its entries did not change); the root's id. */
  private async writeTrees(files: Map<string, string>): Promise<string> {
    type Folder = { files: Map<string, string>; folders: Map<string, Folder> };
    const root: Folder = { files: new Map(), folders: new Map() };
    for (const [path, oid] of files) {
      const parts = path.split('/');
      let folder = root;
      for (const part of parts.slice(0, -1)) {
        let next = folder.folders.get(part);
        if (!next) folder.folders.set(part, (next = { files: new Map(), folders: new Map() }));
        folder = next;
      }
      folder.files.set(parts.at(-1)!, oid);
    }
    const write = async (folder: Folder, path: string): Promise<string> => {
      const entries: TreeEntry[] = [];
      for (const [name, child] of folder.folders) entries.push({ mode: TREE_MODE, path: name, oid: await write(child, path ? `${path}/${name}` : name), type: 'tree' });
      for (const [name, oid] of folder.files) entries.push({ mode: FILE_MODE, path: name, oid, type: 'blob' });
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const signature = entries.map((entry) => `${entry.mode} ${entry.oid} ${entry.path}`).join('\n');
      const cached = this.treeCache.get(path);
      if (cached && cached.signature === signature) return cached.oid;
      const oid = await git.writeTree({ fs, gitdir: this.location, tree: entries });
      this.treeCache.set(path, { signature, oid });
      return oid;
    };
    return write(root, '');
  }

  async readCommit(oid: string): Promise<StoredCommit> {
    const { commit } = await git.readCommit({ ...this.base, oid });
    return {
      oid,
      parent: commit.parent[0] ?? null,
      at: new Date(commit.author.timestamp * 1000).toISOString(),
      ...parseCommitMessage(commit.message, commit.author.name),
    };
  }

  async log(options: { stopAt?: string | null } = {}): Promise<StoredCommit[]> {
    const commits: StoredCommit[] = [];
    let oid = await this.head();
    const seen = new Set<string>();
    while (oid && oid !== options.stopAt && !seen.has(oid)) {
      seen.add(oid);
      const commit = await this.readCommit(oid);
      commits.push(commit);
      oid = commit.parent;
    }
    return commits;
  }

  async diff(from: string | null, to: string): Promise<FileChange[]> {
    const treeOf = async (commit: string | null) => commit ? (await git.readCommit({ ...this.base, oid: commit })).commit.tree : null;
    const changes: FileChange[] = [];
    await this.diffTrees(await treeOf(from), await treeOf(to), '', changes);
    return changes;
  }

  /** Compares two trees, reading only the folders whose trees differ. */
  private async diffTrees(before: string | null, after: string | null, prefix: string, into: FileChange[]): Promise<void> {
    if (before === after) return;
    const entries = async (oid: string | null) => oid ? (await git.readTree({ ...this.base, oid })).tree : [];
    const left = new Map((await entries(before)).map((entry) => [entry.path, entry]));
    const right = new Map((await entries(after)).map((entry) => [entry.path, entry]));
    for (const name of new Set([...left.keys(), ...right.keys()])) {
      const a = left.get(name);
      const b = right.get(name);
      if (a?.oid === b?.oid && a?.type === b?.type) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const aTree = a?.type === 'tree' ? a.oid : null;
      const bTree = b?.type === 'tree' ? b.oid : null;
      if (aTree || bTree) await this.diffTrees(aTree, bTree, path, into);
      const aBlob = a?.type === 'blob' ? a.oid : null;
      const bBlob = b?.type === 'blob' ? b.oid : null;
      if (aBlob !== bBlob) into.push({ path, before: aBlob, after: bBlob });
    }
  }

  async readBlob(oid: string): Promise<Uint8Array> {
    return (await git.readBlob({ ...this.base, oid })).blob;
  }

  async readFile(commit: string, path: string): Promise<Uint8Array | null> {
    try {
      return (await git.readBlob({ ...this.base, oid: commit, filepath: path })).blob;
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'NotFoundError') return null;
      throw error;
    }
  }

  async hashContent(content: Uint8Array): Promise<string> {
    return (await git.hashBlob({ object: content })).oid;
  }

  async sizeBytes(): Promise<number> {
    let total = 0;
    const walk = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const path = join(dir, name);
        try {
          const stat = statSync(path);
          if (stat.isDirectory()) walk(path);
          else total += stat.size;
        } catch {
          // Gone while counting.
        }
      }
    };
    walk(this.location);
    return total;
  }
}
