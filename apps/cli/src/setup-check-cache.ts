/**
 * What the background data checks have already asked the warehouse, kept on
 * the project's disk (onboarding design P4, "Resumable"):
 * `.dql/local/setup-checks.jsonl`, one line per statement answered.
 *
 * The checks are deterministic given the catalog and the answers, so a run
 * that stopped (Stop, a restart, the idle stop, an upgrade) is resumed by
 * running the checks again: every statement answered before is served from
 * here, and only the ones never answered reach the warehouse. A statement
 * that failed or ran over the time limit is kept as such, so a resume does
 * not spend the time limit on it again; "check it anyway" clears it.
 *
 * The file belongs to one catalog: a new read (another choice of schemas, a
 * changed table) starts it afresh.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Row = Record<string, unknown>;

interface CacheHeader { kind: 'header'; version: 1; catalog: string; createdAt: string }
interface CacheAnswer { kind: 'answer'; key: string; relations?: string[]; rows: unknown[] }
interface CacheFailure { kind: 'failure'; key: string; relations?: string[]; error: string; timedOut?: boolean }
type CacheLine = CacheHeader | CacheAnswer | CacheFailure;

export class CheckStatementFailure extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
    this.name = 'CheckStatementFailure';
  }
}

export function setupCheckCachePath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'setup-checks.jsonl');
}

/** JSON keeps no BigInt or Date: they are tagged, so a resumed check reads the same values. */
function encode(value: unknown): unknown {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Row).map(([key, item]) => [key, encode(item)]));
  return value;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const record = value as Row;
    if (typeof record.$bigint === 'string' && Object.keys(record).length === 1) return BigInt(record.$bigint);
    if (typeof record.$date === 'string' && Object.keys(record).length === 1) return new Date(record.$date);
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

export class SetupCheckCache {
  private readonly answers = new Map<string, CacheAnswer | CacheFailure>();
  /** Answers on disk when this run opened them. */
  private readonly before = new Set<string>();
  private readonly servedFromBefore = new Set<string>();
  /** Statements served from the kept answers in this run (a statement asked twice counts twice). */
  hits = 0;
  /** Statements asked of the warehouse in this run. */
  asked = 0;

  private constructor(private readonly path: string, readonly catalog: string) {}

  /** The cache for a catalog: the one on disk when it is that catalog's, else a fresh one. */
  static open(projectRoot: string, catalog: string): SetupCheckCache {
    const path = setupCheckCachePath(projectRoot);
    const cache = new SetupCheckCache(path, catalog);
    let lines: CacheLine[] = [];
    if (existsSync(path)) {
      lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as CacheLine]; } catch { return []; }
      });
    }
    const header = lines[0];
    if (header?.kind === 'header' && header.catalog === catalog) {
      for (const line of lines.slice(1)) {
        if (line.kind === 'header') continue;
        cache.answers.set(line.key, line);
        cache.before.add(line.key);
      }
    } else {
      cache.reset();
    }
    return cache;
  }

  /** Forget every answer: the next run asks the warehouse again. */
  reset(): void {
    this.answers.clear();
    this.before.clear();
    this.servedFromBefore.clear();
    mkdirSync(dirname(this.path), { recursive: true });
    const header: CacheHeader = { kind: 'header', version: 1, catalog: this.catalog, createdAt: new Date().toISOString() };
    writeFileSync(this.path, `${JSON.stringify(header)}\n`, 'utf-8');
  }

  get size(): number {
    return this.answers.size;
  }

  /** Distinct statements an earlier run answered that this run did not ask again: what the resume saved. */
  get resumed(): number {
    return this.servedFromBefore.size;
  }

  /** Statements that failed or ran over the time limit, by the tables they read. */
  failures(): Array<{ relations: string[]; error: string; timedOut: boolean }> {
    return [...this.answers.values()].flatMap((entry) => entry.kind === 'failure' ? [{ relations: entry.relations ?? [], error: entry.error, timedOut: entry.timedOut === true }] : []);
  }

  /** Forget the failed statements that read these tables (or every failed one), so they run again. */
  forgetFailures(relations?: string[]): number {
    const wanted = relations ? new Set(relations.map((relation) => relation.toLowerCase())) : undefined;
    let forgotten = 0;
    for (const [key, entry] of this.answers) {
      if (entry.kind !== 'failure') continue;
      if (wanted && !(entry.relations ?? []).some((relation) => wanted.has(relation.toLowerCase()))) continue;
      this.answers.delete(key);
      forgotten += 1;
    }
    if (forgotten > 0) {
      mkdirSync(dirname(this.path), { recursive: true });
      const header: CacheHeader = { kind: 'header', version: 1, catalog: this.catalog, createdAt: new Date().toISOString() };
      writeFileSync(this.path, [header, ...this.answers.values()].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
    }
    return forgotten;
  }

  /**
   * A runner that answers from the cache, else runs the statement and keeps
   * its answer (or its failure). `relationsOf` names the tables a statement
   * reads, kept with a failure so the problem list can name the table.
   */
  wrap<T extends { rows: Row[] }>(
    run: (sql: string) => Promise<T>,
    options: { relationsOf?: (sql: string) => string[]; isTimeout?: (error: unknown) => boolean; signal?: AbortSignal } = {},
  ): (sql: string) => Promise<{ rows: Row[] }> {
    return async (sql) => {
      const key = createHash('sha256').update(sql).digest('hex');
      const known = this.answers.get(key);
      if (known) {
        this.hits += 1;
        if (this.before.has(key)) this.servedFromBefore.add(key);
        if (known.kind === 'failure') throw new CheckStatementFailure(known.error, known.timedOut === true);
        return { rows: decode(known.rows) as Row[] };
      }
      this.asked += 1;
      const relations = options.relationsOf?.(sql);
      try {
        const result = await run(sql);
        const line: CacheAnswer = { kind: 'answer', key, ...(relations?.length ? { relations } : {}), rows: encode(result.rows) as unknown[] };
        this.answers.set(key, line);
        appendFileSync(this.path, `${JSON.stringify(line)}\n`, 'utf-8');
        return result;
      } catch (error) {
        // A statement Stop cancelled did not fail: it is asked again on resume.
        if (options.signal?.aborted) throw error;
        const message = error instanceof Error ? error.message.split('\n')[0]!.slice(0, 300) : String(error);
        const timedOut = options.isTimeout?.(error) === true;
        const line: CacheFailure = { kind: 'failure', key, ...(relations?.length ? { relations } : {}), error: message, ...(timedOut ? { timedOut } : {}) };
        this.answers.set(key, line);
        appendFileSync(this.path, `${JSON.stringify(line)}\n`, 'utf-8');
        throw error;
      }
    };
  }
}
