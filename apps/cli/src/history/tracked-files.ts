import { readdirSync, statSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { blockCompanionRelativePath, loadDomainPackageRegistry } from '@zlens/core';

/**
 * WHAT HISTORY KEEPS (V15 decision H5): an allow-list, never "everything but".
 *
 * Kept: saved queries (`.dql`) with their receipt companion files, Apps, notebooks, the semantic layer, and the
 * model and domain files. Never kept: caches, run results and snapshots, chat history, `.dql/` (local state,
 * settings, secrets), the project's connection settings, data or build folders, and anything named like a secret.
 * A path is kept only when every rule below says yes.
 */
export const TRACKED_ROOTS = ['blocks', 'domains', 'semantic-layer', 'apps', 'notebooks'] as const;
const TRACKED_EXTENSIONS = new Set(['.dql', '.dqlnb', '.dqld', '.yaml', '.yml', '.json', '.md', '.sql']);
/** Folders inside the tracked roots that hold evidence, caches or data, never a person's work. */
const UNTRACKED_FOLDERS = new Set(['report-matches', 'node_modules', 'target', 'data', 'dist', 'logs', 'seeds', 'runs', 'cache']);
const SECRET_NAME = /secret|credential|password|token|private[-_]?key/i;
/** Bigger files are not project content (an export, a dump): History leaves them out. */
export const MAX_TRACKED_FILE_BYTES = 5 * 1024 * 1024;

export type HistoryItemKind = 'saved_query' | 'app' | 'notebook' | 'semantic' | 'model';

/** Whether History keeps this project-relative path (POSIX separators). */
export function isTrackedPath(path: string): boolean {
  if (typeof path !== 'string' || !path || path.length > 512) return false;
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) return false;
  if (!(TRACKED_ROOTS as readonly string[]).includes(segments[0]!) || segments.length < 2) return false;
  if (segments.slice(0, -1).some((segment) => UNTRACKED_FOLDERS.has(segment.toLowerCase()))) return false;
  const name = segments.at(-1)!.toLowerCase();
  if (SECRET_NAME.test(name)) return false;
  if (name.endsWith('.run.json') || name === 'dql.config.json' || name === 'profiles.yml' || name === 'profiles.yaml') return false;
  return TRACKED_EXTENSIONS.has(extname(name));
}

/** Every tracked file in the project, with its stat, walking only the tracked roots. */
export function listTrackedFiles(projectRoot: string): Map<string, Stats> {
  const found = new Map<string, Stats>();
  const walk = (relativeDir: string, depth: number) => {
    if (depth > 12) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(projectRoot, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = `${relativeDir}/${entry.name}`;
      // A symlink is never followed: it could lead out of the project.
      if (entry.isDirectory()) {
        if (!UNTRACKED_FOLDERS.has(entry.name.toLowerCase())) walk(child, depth + 1);
      } else if (entry.isFile() && isTrackedPath(child)) {
        try {
          const stat = statSync(join(projectRoot, child));
          if (stat.size <= MAX_TRACKED_FILE_BYTES) found.set(child, stat);
        } catch {
          // Gone between the listing and the stat: not there.
        }
      }
    }
  };
  for (const root of TRACKED_ROOTS) walk(root, 0);
  return found;
}

/** The thing a person sees in History: one saved query (with its receipt), one App, one notebook, one file. */
export interface HistoryItemRef {
  /** Stable key: the saved query's or notebook's path, `apps/<id>` for an App, else the file's path. */
  key: string;
  kind: HistoryItemKind;
}

export function isBlockPath(path: string): boolean {
  if (!path.endsWith('.dql') || path.endsWith('/domain.dql')) return false;
  return path.startsWith('blocks/') || /^domains\/[^/]+\/(?:.+\/)?blocks\//.test(path);
}

/** A draft folder's file (`…/_drafts/…`). */
export function isDraftPath(path: string): boolean {
  return /(^|\/)_drafts\//.test(path);
}

const besideKeys = new Map<string, string>();
/**
 * The suffix the copy saved beside a certified saved query carries (`<slug>-<suffix>.dql` in a drafts folder):
 * the first 16 hex characters of the sha256 of the certified file's path (local-runtime draftBesideCanonical).
 */
export function besideSuffix(canonicalPath: string): string {
  let key = besideKeys.get(canonicalPath);
  if (!key) {
    key = createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16);
    if (besideKeys.size > 50_000) besideKeys.clear();
    besideKeys.set(canonicalPath, key);
  }
  return key;
}

/** The suffix a drafts-folder file names, when it is a draft edit beside a certified saved query. */
export function besideSuffixOf(draftPath: string): string | undefined {
  if (!isDraftPath(draftPath)) return undefined;
  return /-([0-9a-f]{16})\.dql$/.exec(draftPath)?.[1];
}

/** Who owns what among a set of tracked files: each companion's saved query, each draft edit's certified one. */
export interface BlockLookups {
  /** Companion YAML → the saved query file it belongs to. */
  companionOwner: Map<string, string>;
  /** Suffix → the (non-draft) saved query file it names. */
  canonicalBySuffix: Map<string, string>;
  /** Saved query file → the draft edit saved beside it. */
  besideOf: Map<string, string>;
}

/**
 * Maps tracked paths to items. A companion YAML belongs to its saved query, and a draft edit saved beside a
 * certified saved query (with its companion) belongs to that saved query: it is the saved query's next version,
 * a draft, until it is certified. The mapping is made against the project's current domain packages (a companion
 * is named after its package), cached per path.
 */
export class HistoryItemMapper {
  private readonly companionOfBlock = new Map<string, string | null>();
  private registry: ReturnType<typeof loadDomainPackageRegistry> | undefined;

  constructor(private readonly projectRoot: string) {}

  /** The companion YAML path of a saved query file, or null. */
  companionOf(blockPath: string): string | null {
    if (!isBlockPath(blockPath)) return null;
    let cached = this.companionOfBlock.get(blockPath);
    if (cached === undefined) {
      try {
        cached = blockCompanionRelativePath(this.projectRoot, blockPath, {
          packageForPath: (filePath: string) => {
            try {
              return (this.registry ??= loadDomainPackageRegistry(this.projectRoot)).packageForPath(filePath);
            } catch {
              return undefined;
            }
          },
        });
      } catch {
        cached = null;
      }
      if (this.companionOfBlock.size > 50_000) this.companionOfBlock.clear();
      this.companionOfBlock.set(blockPath, cached);
    }
    return cached;
  }

  /** Who owns what among `paths`. */
  lookups(paths: Iterable<string>): BlockLookups {
    const companionOwner = new Map<string, string>();
    const canonicalBySuffix = new Map<string, string>();
    const drafts: string[] = [];
    for (const path of paths) {
      if (!isBlockPath(path)) continue;
      const companion = this.companionOf(path);
      if (companion) companionOwner.set(companion, path);
      if (isDraftPath(path)) drafts.push(path);
      else canonicalBySuffix.set(besideSuffix(path), path);
    }
    const besideOf = new Map<string, string>();
    for (const draft of drafts.sort()) {
      const canonical = canonicalBySuffix.get(besideSuffixOf(draft) ?? '');
      if (canonical && !besideOf.has(canonical)) besideOf.set(canonical, draft);
    }
    return { companionOwner, canonicalBySuffix, besideOf };
  }

  /** The item a path belongs to, judged against the files before and after the change being read. */
  itemFor(path: string, ...states: BlockLookups[]): HistoryItemRef {
    const block = isBlockPath(path)
      ? path
      : path.startsWith('semantic-layer/blocks/')
        ? states.map((state) => state.companionOwner.get(path)).find(Boolean)
        : undefined;
    if (block) {
      const suffix = besideSuffixOf(block);
      const canonical = suffix ? states.map((state) => state.canonicalBySuffix.get(suffix)).find(Boolean) : undefined;
      return { key: canonical ?? block, kind: 'saved_query' };
    }
    if (path.endsWith('.dqlnb')) return { key: path, kind: 'notebook' };
    const app = /^apps\/([^/]+)\//.exec(path);
    if (app) return { key: `apps/${app[1]}`, kind: 'app' };
    if (path.startsWith('semantic-layer/')) return { key: path, kind: 'semantic' };
    return { key: path, kind: 'model' };
  }
}

/** Whether an item key names something History keeps (for request paths). */
export function isTrackedItemKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (/^apps\/[^/]+$/.test(key)) return isTrackedPath(`${key}/dql.app.json`);
  return isTrackedPath(key);
}
