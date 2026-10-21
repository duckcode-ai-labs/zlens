/**
 * Server-side conversation session store: threads + ordered turns, persisted in
 * `.dql/local/agent-conversations.sqlite` so multi-turn context survives page
 * refreshes, process restarts, cache rebuilds, and DQL upgrades.
 *
 * This is the SESSION layer — auto-captured, compactable, per-thread. It is
 * strictly separate from the governed durable memory (`MemoryStore`): raw chat
 * is never a correctness signal and never enters `agent_memory` except through
 * an explicit promotion action. Modeled on `memory/sqlite-memory.ts`
 * (better-sqlite3, WAL, FTS5 porter).
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { sanitizeFtsQuery } from '../memory/fts-query.js';
import type { AgentDqlArtifactReference } from '../answer-loop.js';
import type { CascadeAnswerResult } from '../cascade/cascade.js';
import type { KnowledgeLens } from '../domain-context.js';
import type { ConversationSummaryV1 } from './rolling-summary.js';
import type { NarrationIntegrityReceiptV1 } from '../agent-run-engine.js';
import type { Awaitable, AwaitableMethods } from '../store-types.js';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

/** Caps applied at write time so stored turns stay bounded (mirrors the in-request caps). */
// Wide enough that a cross-result follow-up ("of the results above, the
// average") computes over a realistic top-N result, not just a preview slice.
// The sample is used for member resolution + deterministic compute, not dumped
// into the prompt, so this does not bloat follow-up calls.
const MAX_SAMPLE_ROWS = 50;
const MAX_COLUMNS = 24;
const MAX_DIMENSION_KEYS = 8;
const MAX_DIMENSION_VALUES = 24;
const MAX_ANSWER_TEXT = 4000;
const MAX_SUMMARY = 1200;
const MAX_DQL_SOURCE = 3000;
const MAX_COMPILED_SQL = 12_000;

export interface ConversationThread {
  id: string;
  surface: string;
  title?: string;
  notebookPath?: string;
  /** Opaque working-state JSON — owned/typed by conversation/working-state.ts. */
  workingState: Record<string, unknown>;
  rollingSummary?: string;
  /** Trust-aware structured compaction. `rollingSummary` remains the v1 text compatibility view. */
  structuredSummary?: ConversationSummaryV1;
  /** Highest turn seq already folded into rollingSummary (compaction cursor). */
  summaryTurnSeq: number;
  archived: boolean;
  /** User-pinned conversation, surfaced ahead of the rest in the sidebar. */
  favorite: boolean;
  /**
   * Who the conversation belongs to, when a host said who is asking (RFC 0010).
   * Unset for conversations from the local single-user notebook.
   */
  ownerId?: string;
  /**
   * The App page this conversation is about (`app:<appId>:<pageId>`), bound
   * by its first question asked from an App. A question asked from another
   * App page never continues it: its turns never become that page's context.
   */
  scopeKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTurnResult {
  columns?: string[];
  rowsSample?: unknown[][];
  /** Units per column (the executed result's contract), capped with the columns. */
  columnsMeta?: Array<{ name: string; kind: string; unit?: string; decimals?: number; ref?: string; grain?: string }>;
  dimensionValues?: Record<string, string[]>;
  /**
   * Content-free identity of the canonical executed result.  Unlike a member
   * set, this remains available for a successful result that has no recognised
   * display entity (for example a grouped aggregate).  It is local continuity
   * evidence only and is absent from legacy persisted rows.
   */
  resultFingerprint?: string;
  /**
   * Bounded, typed entity sets projected from an executed result. These are
   * local conversation continuity material: they let a later question such as
   * "which of those customers" bind to the displayed set after a restart
   * without treating a prior answer's prose, SQL, or first row as authority.
   *
   * `resultFingerprint` is a content-free linkage to the executed result.
   * The values remain in the local conversation store and must not be copied
   * into portable traces or diagnostic exports.
   */
  memberSets?: ConversationResultMemberSetV1[];
  measureColumns?: string[];
  rowCount?: number;
}

export type ConversationResultMemberEntityV1 =
  | 'customer'
  | 'account'
  | 'product'
  | 'user'
  | 'other';

export interface ConversationResultMemberSetV1 {
  version: 1;
  entity: ConversationResultMemberEntityV1;
  /** Human-readable result column used for a deictic entity reference. */
  displayColumn: string;
  displayValues: string[];
  /** Optional stable key when the executed result exposed one. */
  keyColumn?: string;
  keyValues?: string[];
  /** Content-free canonical result linkage; absent for legacy persisted rows. */
  resultFingerprint?: string;
}

export interface ConversationTurnInput {
  /** Canonical persisted AgentRun backing this presentation turn. */
  agentRunId?: string;
  question: string;
  answerSummary?: string;
  answerText?: string;
  route?: string;
  trustLabel?: string;
  runStatus?: string;
  stopReason?: string;
  /**
   * Refusal code and execution error from the underlying run. Persisted so
   * `conversationTurnTrust` can tell a genuine answer from a refusal — a
   * grounding gap and a good uncertified answer share `runStatus`, so without
   * these a failed turn is indistinguishable from a usable one.
   */
  refusalCode?: string;
  executionError?: string;
  certification?: string;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  /** Immutable domain capsule and skill selection used for this turn. */
  knowledgeLens?: KnowledgeLens;
  sql?: string;
  dqlArtifact?: AgentDqlArtifactReference;
  cascade?: CascadeAnswerResult;
  /** Content-free narration result retained with the conversational history. */
  narrationIntegrityReceipt?: NarrationIntegrityReceiptV1;
  result?: ConversationTurnResult;
  /** The turn's answer contract / requested shape, for working-state reduction. */
  contract?: Record<string, unknown>;
}

export interface ConversationTurn extends ConversationTurnInput {
  id: string;
  threadId: string;
  seq: number;
  createdAt: string;
}

export interface ConversationTurnSearchOptions {
  query: string;
  threadId?: string;
  /** Only this person's conversations. */
  ownerId?: string;
  limit?: number;
}

export function defaultConversationPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'agent-conversations.sqlite');
}

export function legacyConversationPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'cache', 'agent-conversations.sqlite');
}

/**
 * Move the original conversation database out of rebuildable cache storage.
 * SQLite backup reads committed WAL pages too, so history is retained even
 * when the legacy store last closed with a non-empty WAL file.
 *
 * Keep the legacy database as a recovery copy until `.dql/cache` is next
 * cleared. Only the durable `.dql/local` copy is opened after migration.
 */
export async function prepareConversationPath(projectRoot: string): Promise<string> {
  const target = defaultConversationPath(projectRoot);
  const legacy = legacyConversationPath(projectRoot);
  if (existsSync(target) || !existsSync(legacy)) return target;

  mkdirSync(dirname(target), { recursive: true });
  const temporaryTarget = `${target}.migrating-${process.pid}-${Date.now()}`;
  const Database = loadDatabase();
  const legacyDb = new Database(legacy, { readonly: true });
  try {
    await legacyDb.backup(temporaryTarget);
    if (existsSync(target)) {
      rmSync(temporaryTarget, { force: true });
    } else {
      renameSync(temporaryTarget, target);
    }
  } catch {
    rmSync(temporaryTarget, { force: true });
    // History availability must not block Notebook startup. Keep using the
    // intact legacy store for this process and retry migration next restart.
    return legacy;
  } finally {
    legacyDb.close();
  }
  return target;
}

export class ConversationStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = loadDatabase();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        id                 TEXT PRIMARY KEY,
        surface            TEXT NOT NULL DEFAULT 'notebook',
        title              TEXT,
        notebook_path      TEXT,
        working_state_json TEXT NOT NULL DEFAULT '{}',
        rolling_summary    TEXT,
        summary_json       TEXT NOT NULL DEFAULT '{}',
        summary_turn_seq   INTEGER NOT NULL DEFAULT 0,
        archived           INTEGER NOT NULL DEFAULT 0,
        favorite           INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_threads_updated
        ON conversation_threads(archived, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id                     TEXT PRIMARY KEY,
        thread_id              TEXT NOT NULL,
        agent_run_id           TEXT,
        seq                    INTEGER NOT NULL,
        question               TEXT NOT NULL,
        answer_summary         TEXT,
        answer_text            TEXT,
        route                  TEXT,
        trust_label            TEXT,
        run_status             TEXT,
        stop_reason            TEXT,
        refusal_code           TEXT,
        execution_error        TEXT,
        certification          TEXT,
        source_certified_block TEXT,
        context_pack_id        TEXT,
        knowledge_lens_json    TEXT NOT NULL DEFAULT '{}',
        sql                    TEXT,
        dql_artifact_json      TEXT NOT NULL DEFAULT '{}',
        cascade_json           TEXT NOT NULL DEFAULT '{}',
        narration_integrity_json TEXT NOT NULL DEFAULT '{}',
        result_json            TEXT NOT NULL DEFAULT '{}',
        contract_json          TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        UNIQUE (thread_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_turns_thread
        ON conversation_turns(thread_id, seq DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
        id UNINDEXED,
        thread_id UNINDEXED,
        question,
        answer_summary,
        tags,
        tokenize = 'porter unicode61'
      );
    `);
    this.ensureColumn('conversation_turns', 'dql_artifact_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('conversation_turns', 'cascade_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('conversation_turns', 'knowledge_lens_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('conversation_turns', 'agent_run_id', 'TEXT');
    this.ensureColumn('conversation_turns', 'run_status', 'TEXT');
    this.ensureColumn('conversation_turns', 'stop_reason', 'TEXT');
    this.ensureColumn('conversation_turns', 'refusal_code', 'TEXT');
    this.ensureColumn('conversation_turns', 'execution_error', 'TEXT');
    this.ensureColumn('conversation_turns', 'narration_integrity_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('conversation_threads', 'summary_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('conversation_threads', 'favorite', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('conversation_threads', 'owner_id', 'TEXT');
    this.ensureColumn('conversation_threads', 'scope_key', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_conversation_threads_owner ON conversation_threads(owner_id, archived, updated_at DESC)');
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  }

  createThread(input: { id?: string; surface?: string; title?: string; notebookPath?: string; ownerId?: string } = {}): ConversationThread {
    const thread = newConversationThread(input);
    const now = thread.createdAt;
    this.db.prepare(`
      INSERT INTO conversation_threads (
        id, surface, title, notebook_path, working_state_json, rolling_summary, summary_json,
        summary_turn_seq, archived, owner_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '{}', NULL, '{}', 0, 0, ?, ?, ?)
    `).run(thread.id, thread.surface, thread.title ?? null, thread.notebookPath ?? null, thread.ownerId ?? null, now, now);
    return thread;
  }

  /**
   * Bind an unscoped conversation to the App page it is being asked from.
   * Returns false when it is already bound (to that scope or another).
   */
  bindThreadScope(id: string, scopeKey: string): boolean {
    const info = this.db.prepare('UPDATE conversation_threads SET scope_key = ? WHERE id = ? AND scope_key IS NULL')
      .run(scopeKey, id) as { changes?: number };
    return (info.changes ?? 0) > 0;
  }

  /** The conversation a run was answered in, for a link to that answer (`/ask?run=<id>`). */
  threadIdForRun(runId: string): string | null {
    const row = this.db.prepare('SELECT thread_id FROM conversation_turns WHERE agent_run_id = ? ORDER BY seq LIMIT 1').get(runId) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  }

  getThread(id: string): ConversationThread | null {
    const row = this.db.prepare('SELECT * FROM conversation_threads WHERE id = ?').get(id) as ThreadRow | undefined;
    return row ? rowToThread(row) : null;
  }

  /**
   * `ownerId` lists only that person's conversations (a host's signed-in person);
   * `notebookPath` only the Notebook AI conversations held in that notebook.
   */
  listThreads(options: { limit?: number; includeArchived?: boolean; ownerId?: string; notebookPath?: string } = {}): ConversationThread[] {
    // Pinned conversations lead, then recency. Ordering here rather than in the
    // client keeps the `limit` meaningful: a favourite must not fall off the end
    // of the page simply because it has not been used lately.
    const where: string[] = [];
    const params: unknown[] = [];
    if (!options.includeArchived) where.push('archived = 0');
    if (options.ownerId !== undefined) {
      where.push('owner_id = ?');
      params.push(options.ownerId);
    }
    if (options.notebookPath !== undefined) {
      where.push('notebook_path = ?');
      params.push(options.notebookPath);
    }
    const rows = this.db.prepare(`SELECT * FROM conversation_threads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY favorite DESC, updated_at DESC LIMIT ?`)
      .all(...params, options.limit ?? 50);
    return (rows as ThreadRow[]).map(rowToThread);
  }

  archiveThread(id: string): void {
    this.db.prepare('UPDATE conversation_threads SET archived = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  /**
   * Rename a conversation. `updated_at` deliberately does NOT move: renaming is
   * housekeeping, and bumping it would jump the thread to the top of a list
   * ordered by recency and reshuffle the sidebar under the user's cursor.
   */
  renameThread(id: string, title: string): boolean {
    const clean = title.trim().slice(0, 200);
    const result = this.db
      .prepare('UPDATE conversation_threads SET title = ? WHERE id = ?')
      .run(clean || null, id);
    return result.changes > 0;
  }

  /** Pin or unpin a conversation. Same recency rule as renaming. */
  setThreadFavorite(id: string, favorite: boolean): boolean {
    const result = this.db
      .prepare('UPDATE conversation_threads SET favorite = ? WHERE id = ?')
      .run(favorite ? 1 : 0, id);
    return result.changes > 0;
  }

  /**
   * Permanently delete one conversation thread and its searchable turn history.
   * Explicitly promoted memories and immutable agent-run audit receipts live in
   * separate stores and are not silently deleted with chat presentation state.
   */
  deleteThread(id: string): boolean {
    let deleted = false;
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM conversation_turns_fts WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM conversation_turns WHERE thread_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM conversation_threads WHERE id = ?').run(id);
      deleted = result.changes > 0;
    });
    txn();
    return deleted;
  }

  /**
   * Append a turn to a thread (assigns the next seq, dual-writes the FTS index,
   * bumps the thread, and sets the thread title from the first question).
   */
  appendTurn(threadId: string, input: ConversationTurnInput): ConversationTurn {
    const turn = conversationTurnForStorage(threadId, input);
    const now = turn.createdAt;
    const txn = this.db.transaction(() => {
      const seqRow = this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM conversation_turns WHERE thread_id = ?'
      ).get(threadId) as { next: number };
      turn.seq = seqRow.next;
      this.db.prepare(`
        INSERT INTO conversation_turns (
          id, thread_id, agent_run_id, seq, question, answer_summary, answer_text, route,
          trust_label, run_status, stop_reason, refusal_code, execution_error,
          certification, source_certified_block, context_pack_id,
          knowledge_lens_json, sql, dql_artifact_json, cascade_json, narration_integrity_json,
          result_json, contract_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        turn.id,
        threadId,
        turn.agentRunId ?? null,
        turn.seq,
        turn.question,
        turn.answerSummary ?? null,
        turn.answerText ?? null,
        turn.route ?? null,
        turn.trustLabel ?? null,
        turn.runStatus ?? null,
        turn.stopReason ?? null,
        turn.refusalCode ?? null,
        turn.executionError ?? null,
        turn.certification ?? null,
        turn.sourceCertifiedBlock ?? null,
        turn.contextPackId ?? null,
        JSON.stringify(turn.knowledgeLens ?? {}),
        turn.sql ?? null,
        JSON.stringify(turn.dqlArtifact ?? {}),
        JSON.stringify(turn.cascade ?? {}),
        JSON.stringify(turn.narrationIntegrityReceipt ?? {}),
        JSON.stringify(turn.result ?? {}),
        JSON.stringify(turn.contract ?? {}),
        now,
      );
      const tags = conversationTurnSearchTags(turn);
      this.db.prepare(`
        INSERT INTO conversation_turns_fts (id, thread_id, question, answer_summary, tags)
        VALUES (?, ?, ?, ?, ?)
      `).run(turn.id, threadId, turn.question, turn.answerSummary ?? '', tags);
      this.db.prepare(`
        UPDATE conversation_threads
        SET updated_at = ?, title = COALESCE(title, ?)
        WHERE id = ?
      `).run(now, turn.question.slice(0, 120), threadId);
    });
    txn();
    return turn;
  }

  recentTurns(threadId: string, limit = 4): ConversationTurn[] {
    const rows = this.db.prepare(`
      SELECT * FROM conversation_turns WHERE thread_id = ? ORDER BY seq DESC LIMIT ?
    `).all(threadId, limit) as TurnRow[];
    return rows.map(rowToTurn).reverse();
  }

  /**
   * Which cascade tiers have answered recently, across all threads. Powers a
   * tier-distribution surface so you can see the governance ladder shift upward
   * (more certified/semantic answers) as usage compounds.
   */
  tierDistribution(options: { limit?: number; ownerId?: string } = {}): {
    total: number;
    byRouteTier: Record<string, number>;
    byTerminalLane: Record<string, number>;
  } {
    const limit = options.limit ?? 500;
    // With an owner (a host's signed-in person): only the turns of their own threads.
    const rows = (options.ownerId !== undefined
      ? this.db.prepare(`
          SELECT * FROM conversation_turns
          WHERE thread_id IN (SELECT id FROM conversation_threads WHERE owner_id = ?)
          ORDER BY created_at DESC LIMIT ?
        `).all(options.ownerId, limit)
      : this.db.prepare(`
          SELECT * FROM conversation_turns ORDER BY created_at DESC LIMIT ?
        `).all(limit)) as TurnRow[];
    const byRouteTier: Record<string, number> = {};
    const byTerminalLane: Record<string, number> = {};
    let total = 0;
    for (const turn of rows.map(rowToTurn)) {
      const routeTier = turn.cascade?.routeTier;
      const terminalLane = turn.cascade?.terminalLane;
      if (routeTier) {
        byRouteTier[routeTier] = (byRouteTier[routeTier] ?? 0) + 1;
        total += 1;
      }
      if (terminalLane) byTerminalLane[terminalLane] = (byTerminalLane[terminalLane] ?? 0) + 1;
    }
    return { total, byRouteTier, byTerminalLane };
  }

  /** Turns older than the compaction cursor and outside the recent window (for rolling summary). */
  turnsForCompaction(threadId: string, afterSeq: number, beforeSeq: number): ConversationTurn[] {
    const rows = this.db.prepare(`
      SELECT * FROM conversation_turns
      WHERE thread_id = ? AND seq > ? AND seq < ?
      ORDER BY seq ASC
    `).all(threadId, afterSeq, beforeSeq) as TurnRow[];
    return rows.map(rowToTurn);
  }

  updateThreadState(
    threadId: string,
    input: {
      workingState?: Record<string, unknown>;
      rollingSummary?: string;
      structuredSummary?: ConversationSummaryV1;
      summaryTurnSeq?: number;
    },
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];
    if (input.workingState !== undefined) {
      sets.push('working_state_json = ?');
      params.push(JSON.stringify(input.workingState));
    }
    if (input.rollingSummary !== undefined) {
      sets.push('rolling_summary = ?');
      params.push(input.rollingSummary || null);
    }
    if (input.structuredSummary !== undefined) {
      sets.push('summary_json = ?');
      params.push(JSON.stringify(input.structuredSummary));
    }
    if (input.summaryTurnSeq !== undefined) {
      sets.push('summary_turn_seq = ?');
      params.push(input.summaryTurnSeq);
    }
    params.push(threadId);
    this.db.prepare(`UPDATE conversation_threads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** FTS keyword search over turns; hybrid embedding re-ranking layers on top (P5). */
  searchTurns(options: ConversationTurnSearchOptions): ConversationTurn[] {
    const query = sanitizeFtsQuery(options.query);
    if (!query) return [];
    const params: unknown[] = [query];
    let threadFilter = '';
    if (options.threadId) {
      threadFilter = 'AND t.thread_id = ?';
      params.push(options.threadId);
    }
    if (options.ownerId !== undefined) {
      threadFilter += ' AND t.thread_id IN (SELECT id FROM conversation_threads WHERE owner_id = ?)';
      params.push(options.ownerId);
    }
    const rows = this.db.prepare(`
      SELECT t.*, bm25(conversation_turns_fts) AS rank
      FROM conversation_turns_fts AS f
      JOIN conversation_turns AS t ON t.id = f.id
      WHERE conversation_turns_fts MATCH ?
        ${threadFilter}
      ORDER BY rank
      LIMIT ?
    `).all(...params, options.limit ?? 6) as TurnRow[];
    return rows.map(rowToTurn);
  }

  /** Housekeeping: hard-delete archived threads (and their turns) older than the cutoff. */
  pruneThreads(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    let pruned = 0;
    const txn = this.db.transaction(() => {
      const stale = this.db.prepare(
        'SELECT id FROM conversation_threads WHERE archived = 1 AND updated_at < ?'
      ).all(cutoff) as Array<{ id: string }>;
      for (const { id } of stale) {
        if (this.deleteThread(id)) pruned += 1;
      }
    });
    txn();
    return pruned;
  }

  close(): void {
    this.db.close();
  }
}

/** The conversation store surface ZLens calls (RFC 0010 HH-6). */
export type ConversationStoreMethods = Pick<ConversationStore,
  | 'createThread' | 'threadIdForRun' | 'getThread' | 'listThreads' | 'archiveThread' | 'renameThread'
  | 'setThreadFavorite' | 'deleteThread' | 'appendTurn' | 'recentTurns' | 'tierDistribution'
  | 'turnsForCompaction' | 'updateThreadState' | 'searchTurns'>;

/**
 * A conversation store as ZLens uses it: this SQLite store, or a host's own
 * (RFC 0010 HH-6) whose methods return Promises. ZLens awaits every call.
 */
export type ConversationStoreLike = AwaitableMethods<ConversationStoreMethods> & {
  pruneThreads?(olderThanDays: number): Awaitable<number>;
  /** Optional for a host's own store: without it, App-page scoping of a conversation is not recorded. */
  bindThreadScope?(id: string, scopeKey: string): Awaitable<boolean>;
  close?(): Awaitable<void>;
};

/**
 * A new thread, exactly as `createThread` records it: a caller-named id when
 * it is a safe one, otherwise a fresh id. For a host's own store (HH-6).
 */
export function newConversationThread(input: { id?: string; surface?: string; title?: string; notebookPath?: string; ownerId?: string } = {}): ConversationThread {
  const now = new Date().toISOString();
  // A caller may NAME a thread. `zlens agent ask --thread my-session` is
  // documented as continuing a conversation, but nothing ever created the
  // thread, so every turn was dropped on the floor and each follow-up
  // started from zero. Naming is not new authority: an id that can be
  // supplied to read and append to a thread can equally open one.
  const named = typeof input.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(input.id.trim())
    ? input.id.trim()
    : undefined;
  const id = named ?? `thr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    surface: input.surface?.trim() || 'notebook',
    title: input.title?.trim() || undefined,
    notebookPath: input.notebookPath?.trim() || undefined,
    workingState: {},
    rollingSummary: undefined,
    structuredSummary: undefined,
    summaryTurnSeq: 0,
    archived: false,
    favorite: false,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A turn as `appendTurn` stores it: a fresh id, bounded text, result sample
 * and DQL artifact. `seq` is 0 until the store assigns the thread's next one.
 * For a host's own store (HH-6), so both keep the same bounds.
 */
export function conversationTurnForStorage(threadId: string, input: ConversationTurnInput): ConversationTurn {
  return {
    ...input,
    answerText: input.answerText?.slice(0, MAX_ANSWER_TEXT),
    answerSummary: input.answerSummary?.slice(0, MAX_SUMMARY),
    dqlArtifact: capDqlArtifact(input.dqlArtifact),
    result: capTurnResult(input.result),
    id: `trn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    seq: 0,
    createdAt: new Date().toISOString(),
  };
}

/** The words a turn is found by besides its question and summary (the FTS `tags` column). */
export function conversationTurnSearchTags(turn: ConversationTurn): string {
  return [
    turn.sourceCertifiedBlock ?? '',
    turn.route ?? '',
    turn.cascade?.terminalLane ?? '',
    turn.cascade?.routeTier ?? '',
    turn.dqlArtifact?.name ?? '',
    turn.dqlArtifact?.kind ?? '',
    ...(turn.dqlArtifact?.metrics ?? []),
    ...(turn.dqlArtifact?.dimensions ?? []),
    ...(turn.result?.columns ?? []),
    ...Object.keys(turn.result?.dimensionValues ?? {}),
  ].filter(Boolean).join(' ');
}

/** A stored turn read back the way `recentTurns` reads it (the DQL artifact re-bounded). */
export function conversationTurnFromStorage(turn: ConversationTurn): ConversationTurn {
  return { ...turn, dqlArtifact: turn.dqlArtifact && Object.keys(turn.dqlArtifact).length > 0 ? capDqlArtifact(turn.dqlArtifact) : undefined };
}

function capTurnResult(result: ConversationTurnResult | undefined): ConversationTurnResult | undefined {
  if (!result) return undefined;
  const columns = result.columns?.slice(0, MAX_COLUMNS);
  const columnsMeta = result.columnsMeta?.filter((meta) => meta && typeof meta.name === 'string' && typeof meta.kind === 'string').slice(0, MAX_COLUMNS);
  const rowsSample = result.rowsSample?.slice(0, MAX_SAMPLE_ROWS)
    .map((row) => Array.isArray(row) ? row.slice(0, MAX_COLUMNS) : row);
  const dimensionValues = result.dimensionValues
    ? Object.fromEntries(
        Object.entries(result.dimensionValues)
          .slice(0, MAX_DIMENSION_KEYS)
          .map(([key, values]) => [key, values.slice(0, MAX_DIMENSION_VALUES)]),
      )
    : undefined;
  const memberSets = result.memberSets
    ?.slice(0, MAX_DIMENSION_KEYS)
    .flatMap((set): ConversationResultMemberSetV1[] => {
      if (!set || set.version !== 1 || !set.displayColumn?.trim()) return [];
      const displayValues = Array.from(new Set(set.displayValues
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())))
        .slice(0, MAX_DIMENSION_VALUES);
      if (displayValues.length === 0) return [];
      const keyValues = set.keyValues
        ? Array.from(new Set(set.keyValues
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim())))
          .slice(0, MAX_DIMENSION_VALUES)
        : undefined;
      const resultFingerprint = typeof set.resultFingerprint === 'string'
        && /^[a-f0-9]{64}$/i.test(set.resultFingerprint)
        ? set.resultFingerprint.toLowerCase()
        : undefined;
      return [{
        version: 1,
        entity: set.entity,
        displayColumn: set.displayColumn.trim().slice(0, 180),
        displayValues,
        ...(set.keyColumn?.trim() && keyValues?.length
          ? { keyColumn: set.keyColumn.trim().slice(0, 180), keyValues }
          : {}),
        ...(resultFingerprint ? { resultFingerprint } : {}),
      }];
    });
  const resultFingerprint = typeof result.resultFingerprint === 'string'
    && /^[a-f0-9]{64}$/i.test(result.resultFingerprint)
    ? result.resultFingerprint.toLowerCase()
    : undefined;
  return {
    columns,
    rowsSample,
    ...(columnsMeta?.length ? { columnsMeta } : {}),
    dimensionValues,
    ...(memberSets?.length ? { memberSets } : {}),
    ...(resultFingerprint ? { resultFingerprint } : {}),
    measureColumns: result.measureColumns?.slice(0, MAX_COLUMNS),
    rowCount: result.rowCount,
  };
}

function capDqlArtifact(artifact: AgentDqlArtifactReference | undefined): AgentDqlArtifactReference | undefined {
  if (!artifact?.source?.trim()) return undefined;
  return {
    kind: artifact.kind,
    source: artifact.source.slice(0, MAX_DQL_SOURCE),
    name: artifact.name?.slice(0, 180),
    sourcePath: artifact.sourcePath?.slice(0, 400),
    metrics: artifact.metrics?.slice(0, MAX_COLUMNS),
    dimensions: artifact.dimensions?.slice(0, MAX_COLUMNS),
    filters: artifact.filters?.slice(0, MAX_DIMENSION_KEYS).map((filter) => ({
      dimension: filter.dimension.slice(0, 180),
      operator: filter.operator.slice(0, 80),
      values: filter.values.slice(0, MAX_DIMENSION_VALUES).map((value) => value.slice(0, 240)),
    })),
    timeDimension: artifact.timeDimension
      ? {
          name: artifact.timeDimension.name.slice(0, 180),
          granularity: artifact.timeDimension.granularity.slice(0, 80),
        }
      : undefined,
    orderBy: artifact.orderBy?.slice(0, MAX_COLUMNS).map((order) => ({
      name: order.name.slice(0, 180),
      direction: order.direction,
    })),
    limit: artifact.limit,
    parameters: artifact.parameters?.slice(0, MAX_COLUMNS).map((parameter) => ({
      ...parameter,
      name: parameter.name.slice(0, 180),
      ...(parameter.default === undefined ? {} : { default: capArtifactValue(parameter.default) }),
      ...(parameter.binding?.kind === 'semantic_filter'
        ? {
            binding: {
              ...parameter.binding,
              field: parameter.binding.field.slice(0, 180),
            },
          }
        : {}),
    })),
    parameterValues: artifact.parameterValues
      ? Object.fromEntries(
          Object.entries(artifact.parameterValues)
            .slice(0, MAX_COLUMNS)
            .map(([key, value]) => [key.slice(0, 180), capArtifactValue(value)]),
        )
      : undefined,
    persistence: artifact.persistence,
    trustState: artifact.trustState,
    compiledSql: artifact.compiledSql?.slice(0, MAX_COMPILED_SQL),
    executionReceipt: artifact.executionReceipt ? { ...artifact.executionReceipt } : undefined,
  };
}

/** Keep persisted repair inputs JSON-safe and bounded without changing their scalar types. */
function capArtifactValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DIMENSION_VALUES).map((item) => capArtifactValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_DIMENSION_KEYS)
        .map(([key, item]) => [key.slice(0, 180), capArtifactValue(item, depth + 1)]),
    );
  }
  return undefined;
}

type ThreadRow = {
  id: string;
  surface: string;
  title: string | null;
  notebook_path: string | null;
  working_state_json: string;
  rolling_summary: string | null;
  summary_json: string;
  summary_turn_seq: number;
  archived: number;
  /** Nullable on rows written before the column existed (see ensureColumn). */
  favorite?: number | null;
  owner_id?: string | null;
  scope_key?: string | null;
  created_at: string;
  updated_at: string;
};

type TurnRow = {
  id: string;
  thread_id: string;
  agent_run_id: string | null;
  seq: number;
  question: string;
  answer_summary: string | null;
  answer_text: string | null;
  route: string | null;
  trust_label: string | null;
  run_status: string | null;
  stop_reason: string | null;
  /** Nullable on rows written before these columns existed (see ensureColumn). */
  refusal_code?: string | null;
  execution_error?: string | null;
  certification: string | null;
  source_certified_block: string | null;
  context_pack_id: string | null;
  knowledge_lens_json: string;
  sql: string | null;
  dql_artifact_json: string;
  cascade_json: string;
  narration_integrity_json?: string | null;
  result_json: string;
  contract_json: string;
  created_at: string;
};

function rowToThread(row: ThreadRow): ConversationThread {
  return {
    id: row.id,
    surface: row.surface,
    title: row.title ?? undefined,
    notebookPath: row.notebook_path ?? undefined,
    workingState: safeJSON(row.working_state_json, {} as Record<string, unknown>),
    rollingSummary: row.rolling_summary ?? undefined,
    structuredSummary: nonEmptySummary(safeJSON(row.summary_json, {} as ConversationSummaryV1)),
    summaryTurnSeq: row.summary_turn_seq,
    archived: Boolean(row.archived),
    favorite: Boolean(row.favorite),
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(row.scope_key ? { scopeKey: row.scope_key } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTurn(row: TurnRow): ConversationTurn {
  const result = safeJSON(row.result_json, {} as ConversationTurnResult);
  const dqlArtifact = safeJSON(row.dql_artifact_json, {} as AgentDqlArtifactReference);
  const cascade = safeJSON(row.cascade_json, {} as CascadeAnswerResult);
  const narrationIntegrityReceipt = safeJSON(
    row.narration_integrity_json,
    {} as NarrationIntegrityReceiptV1,
  );
  const contract = safeJSON(row.contract_json, {} as Record<string, unknown>);
  const knowledgeLens = safeJSON(row.knowledge_lens_json, {} as KnowledgeLens);
  return {
    id: row.id,
    threadId: row.thread_id,
    agentRunId: row.agent_run_id ?? undefined,
    seq: row.seq,
    question: row.question,
    answerSummary: row.answer_summary ?? undefined,
    answerText: row.answer_text ?? undefined,
    route: row.route ?? undefined,
    trustLabel: row.trust_label ?? undefined,
    runStatus: row.run_status ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    refusalCode: row.refusal_code ?? undefined,
    executionError: row.execution_error ?? undefined,
    certification: row.certification ?? undefined,
    sourceCertifiedBlock: row.source_certified_block ?? undefined,
    contextPackId: row.context_pack_id ?? undefined,
    knowledgeLens: Object.keys(knowledgeLens).length > 0 ? knowledgeLens : undefined,
    sql: row.sql ?? undefined,
    dqlArtifact: Object.keys(dqlArtifact).length > 0 ? capDqlArtifact(dqlArtifact) : undefined,
    cascade: Object.keys(cascade).length > 0 ? cascade : undefined,
    narrationIntegrityReceipt: narrationIntegrityReceipt.version === 1 ? narrationIntegrityReceipt : undefined,
    result: Object.keys(result).length > 0 ? result : undefined,
    contract: Object.keys(contract).length > 0 ? contract : undefined,
    createdAt: row.created_at,
  };
}

function nonEmptySummary(summary: ConversationSummaryV1): ConversationSummaryV1 | undefined {
  return summary?.version === 1 && Array.isArray(summary.entries) ? summary : undefined;
}

function safeJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
