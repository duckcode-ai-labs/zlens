/**
 * VERSION HISTORY STORE (V15, decisions H2 and H9).
 *
 * The ZLens app for Snowflake keeps a version of every saved query, App, notebook and model file each time it is
 * saved through ZLens. This is the storage side of that: an append-only list of commits, each the whole tracked
 * project as it was, with who made it and why. The app's implementation is a Git repository of its own beside the
 * project (git-history-store.ts); this interface is what the rest of ZLens uses, so a later version can add a
 * remote and push (V16) without the callers changing. Nothing here makes an outside connection.
 */

/** Who made a version. `ai` is an automatic Ask draft (with the person who asked); `zlens` is ZLens itself. */
export interface HistoryAuthor {
  name: string;
  kind: 'person' | 'ai' | 'zlens';
  /** For `ai`: the Snowflake user who asked. */
  askedBy?: string;
}

export const ZLENS_AUTHOR: HistoryAuthor = { name: 'ZLens', kind: 'zlens' };
export const AI_ASK_NAME = 'AI (Ask)';

/** Why a version was made. */
export type HistoryAction =
  | 'start'      // the repository's first version: "History starts here"
  | 'found'      // changes found when ZLens started (made while it was not running)
  | 'upgrade'    // an upgrade step or clean-up ZLens ran
  | 'setup'      // ZLens set the app up by itself (drafted models)
  | 'save'       // a person's save through ZLens
  | 'certify'    // an explicit Certify
  | 'clear-drafts'
  | 'delete'
  | 'ask'        // an automatic Ask draft
  | 'restore';   // Restore from History (always a draft)

export interface HistoryRestoredFrom {
  item: string;
  version: number;
  commit: string;
}

export interface StoredCommit {
  oid: string;
  parent: string | null;
  /** ISO-8601, UTC. */
  at: string;
  author: HistoryAuthor;
  action: HistoryAction;
  /** The first line of the message. */
  message: string;
  restoredFrom?: HistoryRestoredFrom;
}

export interface HistoryCommitInput {
  author: HistoryAuthor;
  action: HistoryAction;
  message: string;
  restoredFrom?: HistoryRestoredFrom;
  /** Changed paths only: new content, or null when the file was removed. */
  changes: Array<{ path: string; content: Uint8Array | null }>;
  /** Test seam: the commit time. */
  at?: Date;
}

export interface FileChange {
  path: string;
  /** Blob ids before and after; null when absent on that side. */
  before: string | null;
  after: string | null;
}

export interface HistoryStore {
  /** Where the repository is, for logs (never shown with an account name). */
  readonly location: string;
  /** Creates the repository when it does not exist yet. */
  open(): Promise<{ created: boolean }>;
  head(): Promise<string | null>;
  /** Every tracked path at a commit (default: the newest), with its blob id. */
  files(commit?: string): Promise<Map<string, string>>;
  commit(input: HistoryCommitInput): Promise<StoredCommit>;
  readCommit(oid: string): Promise<StoredCommit>;
  /** Commits newest first, from the newest back to the first (or until `stopAt`, not included). */
  log(options?: { stopAt?: string | null }): Promise<StoredCommit[]>;
  /** The files that differ between two commits (`from` null: everything in `to`). */
  diff(from: string | null, to: string): Promise<FileChange[]>;
  readBlob(oid: string): Promise<Uint8Array>;
  /** A file's content at a commit, or null when it was not there. */
  readFile(commit: string, path: string): Promise<Uint8Array | null>;
  /** The blob id the content would have, without storing it. */
  hashContent(content: Uint8Array): Promise<string>;
  /** Bytes the repository takes on the volume. */
  sizeBytes(): Promise<number>;
}

const TRAILER = /^ZLens-([A-Za-z-]+):\s*(.*)$/;

/** The commit message: the summary line, then the facts History reads back, as Git trailers. */
export function formatCommitMessage(input: Pick<HistoryCommitInput, 'author' | 'action' | 'message' | 'restoredFrom'>): string {
  const summary = input.message.replace(/[\r\n]+/g, ' ').trim() || 'Saved';
  const trailers = [
    `ZLens-Action: ${input.action}`,
    `ZLens-By-Kind: ${input.author.kind}`,
    ...(input.author.askedBy ? [`ZLens-Asked-By: ${oneLine(input.author.askedBy)}`] : []),
    ...(input.restoredFrom ? [`ZLens-Restored-From: ${oneLine(input.restoredFrom.item)} v${input.restoredFrom.version} ${input.restoredFrom.commit}`] : []),
  ];
  return `${summary}\n\n${trailers.join('\n')}\n`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

const ACTIONS = new Set<HistoryAction>(['start', 'found', 'upgrade', 'setup', 'save', 'certify', 'clear-drafts', 'delete', 'ask', 'restore']);

/** Reads a commit message written by formatCommitMessage (and copes with any other). */
export function parseCommitMessage(message: string, authorName: string): Pick<StoredCommit, 'author' | 'action' | 'message' | 'restoredFrom'> {
  const lines = message.split('\n');
  const facts = new Map<string, string>();
  for (const line of lines) {
    const match = TRAILER.exec(line.trim());
    if (match) facts.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  const kind = facts.get('by-kind');
  const author: HistoryAuthor = {
    name: authorName,
    kind: kind === 'ai' || kind === 'zlens' ? kind : kind === 'person' ? 'person' : authorName === 'ZLens' ? 'zlens' : 'person',
    ...(facts.get('asked-by') ? { askedBy: facts.get('asked-by') } : {}),
  };
  const action = facts.get('action') as HistoryAction | undefined;
  const restored = /^(.+) v(\d+) ([0-9a-f]{40})$/.exec(facts.get('restored-from') ?? '');
  return {
    author,
    action: action && ACTIONS.has(action) ? action : 'save',
    message: lines[0]?.trim() ?? '',
    ...(restored ? { restoredFrom: { item: restored[1]!, version: Number(restored[2]), commit: restored[3]! } } : {}),
  };
}
