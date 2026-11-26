import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { claimRuntimeOwner, releaseRuntimeOwner, runtimeOwnerAlive } from '@zlens/agent';

export type LocalOperationStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface LocalOperationError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface LocalOperation<TResult = unknown> {
  id: string;
  type: string;
  scope: string;
  resourceRevision?: string;
  status: LocalOperationStatus;
  phase: string;
  progress: number;
  message: string;
  cancellable: boolean;
  /**
   * Who started it (RFC 0010): the person a host placed, recorded when the
   * operation was created inside their request. Absent for work nobody asked
   * for and without a host.
   */
  ownerId?: string;
  /**
   * Counts a long operation reports as it goes (the setup's tables read and
   * checked, for one): plain JSON, shown by pages that know the type.
   */
  detail?: Record<string, unknown>;
  result?: TResult;
  error?: LocalOperationError;
  createdAt: string;
  updatedAt: string;
}

export type LocalOperationProgress = Pick<
  LocalOperation,
  'phase' | 'progress' | 'message'
> & { resourceRevision?: string; detail?: Record<string, unknown> };

type OperationListener = (operation: LocalOperation) => void;

interface OperationRow {
  id: string;
  type: string;
  scope: string;
  resource_revision: string | null;
  status: LocalOperationStatus;
  phase: string;
  progress: number;
  message: string;
  cancellable: number;
  owner_id?: string | null;
  detail_json?: string | null;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Durable, project-local operation registry used by the OSS notebook runtime.
 *
 * Jobs remain in-process, but their lifecycle is independent from a mounted
 * page. A browser can navigate away, reconnect to progress, or retry after a
 * runtime restart without coupling the work to React component state.
 */
export class LocalOperationCoordinator {
  private readonly db: Database.Database;
  private readonly listeners = new Set<OperationListener>();
  private readonly controllers = new Map<string, AbortController>();
  private closed = false;
  private readonly ownerOf: () => string | undefined;
  /** This coordinator's runtime owner token, stamped on the operations it runs. */
  private readonly runtimeOwner = claimRuntimeOwner();

  constructor(dbPath: string, options: { ownerOf?: () => string | undefined } = {}) {
    this.ownerOf = options.ownerOf ?? (() => undefined);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_operations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource_revision TEXT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        progress INTEGER NOT NULL,
        message TEXT NOT NULL,
        cancellable INTEGER NOT NULL,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_operations_updated
        ON local_operations(updated_at DESC);
    `);
    // Operations recorded before owners were kept have none.
    const columns = this.db.prepare('PRAGMA table_info(local_operations)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'owner_id')) this.db.exec('ALTER TABLE local_operations ADD COLUMN owner_id TEXT');
    if (!columns.some((column) => column.name === 'runtime_owner')) this.db.exec('ALTER TABLE local_operations ADD COLUMN runtime_owner TEXT');
    if (!columns.some((column) => column.name === 'detail_json')) this.db.exec('ALTER TABLE local_operations ADD COLUMN detail_json TEXT');

    // Only work whose runtime is gone is interrupted: another ZLens process
    // opening this project (a second notebook, `zlens agent ask`) must not
    // close the operations the running notebook server is still doing.
    const now = new Date().toISOString();
    const interrupted: LocalOperationError = {
      code: 'RUNTIME_RESTARTED',
      message: 'The ZLens runtime running this operation stopped before it completed.',
      retryable: true,
    };
    const orphaned = (this.db.prepare(
      "SELECT id, runtime_owner, updated_at FROM local_operations WHERE status IN ('queued', 'running')",
    ).all() as Array<{ id: string; runtime_owner: string | null; updated_at: string | null }>)
      .filter((row) => !runtimeOwnerAlive(row.runtime_owner, row.updated_at));
    const close = this.db.prepare(`
      UPDATE local_operations
      SET status = 'interrupted', phase = 'interrupted', cancellable = 0,
          error_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `);
    this.db.transaction(() => {
      for (const row of orphaned) close.run(JSON.stringify(interrupted), now, row.id);
    })();
    this.prune();
  }

  create(input: {
    type: string;
    scope: string;
    resourceRevision?: string;
    phase?: string;
    message?: string;
    cancellable?: boolean;
  }): LocalOperation {
    const now = new Date().toISOString();
    const ownerId = this.ownerOf();
    const operation: LocalOperation = {
      id: `op_${randomUUID()}`,
      type: input.type,
      scope: input.scope,
      ...(input.resourceRevision ? { resourceRevision: input.resourceRevision } : {}),
      status: 'queued',
      phase: input.phase ?? 'queued',
      progress: 0,
      message: input.message ?? 'Queued.',
      cancellable: input.cancellable ?? true,
      ...(ownerId ? { ownerId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.persist(operation);
    this.emit(operation);
    return operation;
  }

  run<TResult>(
    operationId: string,
    task: (
      signal: AbortSignal,
      report: (progress: Partial<LocalOperationProgress>) => void,
    ) => Promise<TResult>,
  ): Promise<LocalOperation<TResult> | null> {
    const operation = this.get(operationId);
    if (!operation || operation.status !== 'queued') return Promise.resolve(null);
    const controller = new AbortController();
    this.controllers.set(operationId, controller);
    this.update(operationId, {
      status: 'running',
      phase: 'starting',
      progress: Math.max(operation.progress, 1),
      message: 'Starting.',
    });

    return task(controller.signal, (progress) => {
      if (this.closed) return;
      const current = this.get(operationId);
      if (!current || current.status !== 'running') return;
      this.update(operationId, progress);
    }).then((result) => {
      if (this.closed) return null;
      const current = this.get(operationId);
      if (!current || current.status !== 'running') return current as LocalOperation<TResult> | null;
      return this.update(operationId, {
        status: 'succeeded',
        phase: 'complete',
        progress: 100,
        message: 'Complete.',
        result,
        cancellable: false,
        error: undefined,
      }) as LocalOperation<TResult> | null;
    }).catch((error: unknown) => {
      if (this.closed) return null;
      const current = this.get(operationId);
      if (!current || current.status === 'cancelled') return current as LocalOperation<TResult> | null;
      const aborted = controller.signal.aborted;
      return this.update(operationId, {
        status: aborted ? 'cancelled' : 'failed',
        phase: aborted ? 'cancelled' : 'failed',
        message: aborted ? 'Cancelled.' : 'Operation failed.',
        cancellable: false,
        error: {
          code: aborted ? 'OPERATION_CANCELLED' : operationErrorCode(error),
          message: aborted
            ? 'The operation was cancelled.'
            : error instanceof Error ? error.message : String(error),
          retryable: !aborted,
        },
      }) as LocalOperation<TResult> | null;
    }).finally(() => {
      this.controllers.delete(operationId);
      if (!this.closed) this.prune();
    });
  }

  cancel(operationId: string): LocalOperation | null {
    const current = this.get(operationId);
    if (!current || !current.cancellable || !['queued', 'running'].includes(current.status)) {
      return current;
    }
    this.controllers.get(operationId)?.abort();
    return this.update(operationId, {
      status: 'cancelled',
      phase: 'cancelled',
      message: 'Cancelled.',
      cancellable: false,
      error: {
        code: 'OPERATION_CANCELLED',
        message: 'The operation was cancelled.',
        retryable: false,
      },
    });
  }

  get(operationId: string): LocalOperation | null {
    const row = this.db.prepare('SELECT * FROM local_operations WHERE id = ?')
      .get(operationId) as OperationRow | undefined;
    return row ? operationFromRow(row) : null;
  }

  /** The latest operations; with `ownerId`, only that person's. */
  list(limit = 50, filter: { ownerId?: string } = {}): LocalOperation[] {
    const bounded = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 50)));
    const owned = filter.ownerId !== undefined;
    const ownerClause = owned ? 'AND owner_id = ?' : '';
    const ownerArgs = owned ? [filter.ownerId] : [];
    const activeRows = this.db.prepare(`
      SELECT * FROM local_operations
      WHERE status IN ('queued', 'running') ${ownerClause}
      ORDER BY updated_at DESC, created_at DESC, id DESC
    `).all(...ownerArgs) as OperationRow[];
    const terminalRows = this.db.prepare(`
      SELECT * FROM local_operations
      WHERE status NOT IN ('queued', 'running') ${ownerClause}
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT ?
    `).all(...ownerArgs, bounded) as OperationRow[];
    return [...activeRows, ...terminalRows]
      .sort((left, right) => (
        right.updated_at.localeCompare(left.updated_at)
        || right.created_at.localeCompare(left.created_at)
        || right.id.localeCompare(left.id)
      ))
      .map(operationFromRow);
  }

  subscribe(listener: OperationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.listeners.clear();
    releaseRuntimeOwner(this.runtimeOwner);
    this.db.close();
  }

  private update(operationId: string, patch: Partial<LocalOperation>): LocalOperation | null {
    const current = this.get(operationId);
    if (!current) return null;
    const next: LocalOperation = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.persist(next);
    this.emit(next);
    return next;
  }

  private persist(operation: LocalOperation): void {
    this.db.prepare(`
      INSERT INTO local_operations (
        id, type, scope, resource_revision, status, phase, progress, message,
        cancellable, result_json, error_json, created_at, updated_at, owner_id, runtime_owner, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        resource_revision = excluded.resource_revision,
        status = excluded.status,
        phase = excluded.phase,
        progress = excluded.progress,
        message = excluded.message,
        cancellable = excluded.cancellable,
        result_json = excluded.result_json,
        error_json = excluded.error_json,
        updated_at = excluded.updated_at,
        runtime_owner = excluded.runtime_owner,
        detail_json = excluded.detail_json
    `).run(
      operation.id,
      operation.type,
      operation.scope,
      operation.resourceRevision ?? null,
      operation.status,
      operation.phase,
      Math.max(0, Math.min(100, Math.round(operation.progress))),
      operation.message,
      operation.cancellable ? 1 : 0,
      operation.result === undefined ? null : JSON.stringify(operation.result),
      operation.error === undefined ? null : JSON.stringify(operation.error),
      operation.createdAt,
      operation.updatedAt,
      operation.ownerId ?? null,
      this.runtimeOwner,
      operation.detail === undefined ? null : JSON.stringify(operation.detail),
    );
  }

  private emit(operation: LocalOperation): void {
    for (const listener of this.listeners) listener(operation);
  }

  private prune(): void {
    this.db.prepare(`
      DELETE FROM local_operations
      WHERE id IN (
        SELECT id FROM local_operations
        WHERE status NOT IN ('queued', 'running')
        ORDER BY updated_at DESC
        LIMIT -1 OFFSET 100
      )
    `).run();
  }
}

function operationFromRow(row: OperationRow): LocalOperation {
  return {
    id: row.id,
    type: row.type,
    scope: row.scope,
    ...(row.resource_revision ? { resourceRevision: row.resource_revision } : {}),
    status: row.status,
    phase: row.phase,
    progress: row.progress,
    message: row.message,
    cancellable: row.cancellable === 1,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(row.detail_json ? { detail: safeJson(row.detail_json) as Record<string, unknown> } : {}),
    ...(row.result_json ? { result: safeJson(row.result_json) } : {}),
    ...(row.error_json ? { error: safeJson(row.error_json) as LocalOperationError } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function operationErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? '').trim();
    if (code) return code;
  }
  return 'OPERATION_FAILED';
}
