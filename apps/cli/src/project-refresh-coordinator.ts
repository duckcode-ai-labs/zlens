import { Worker } from 'node:worker_threads';
import {
  LocalOperationCoordinator,
  type LocalOperation,
  type LocalOperationProgress,
} from './local-operation-coordinator.js';
import type {
  ProjectRefreshWorkerInput,
  ProjectRefreshWorkerResult,
} from './project-refresh-worker.js';

interface PendingRefresh {
  operationId: string;
  input: ProjectRefreshWorkerInput;
  reasons: Set<string>;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
/**
 * How many refreshes in a row may find the project changed under them before
 * the lane stops queueing another. Each project save queues its own refresh as
 * well, so stopping only ends a loop nothing else would end.
 */
const MAX_SUPERSEDED_IN_A_ROW = 3;

/** Runs one refresh off the main thread (the worker); replaceable in tests. */
export type ProjectRefreshRunner = (
  input: ProjectRefreshWorkerInput,
  signal: AbortSignal,
  report: (progress: Partial<LocalOperationProgress>) => void,
) => Promise<ProjectRefreshWorkerResult>;

/** Coalesces project mutations into a single worker-thread rebuild lane. */
export class ProjectRefreshCoordinator {
  private activeOperationId: string | null = null;
  private pending: PendingRefresh | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private supersededInARow = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly operations: LocalOperationCoordinator,
    private readonly onActivated: (result: ProjectRefreshWorkerResult) => void,
    private readonly debounceMs = 250,
    private readonly runRefresh: ProjectRefreshRunner = runRefreshWorker,
  ) {
    this.unsubscribe = operations.subscribe((operation) => {
      if (operation.id === this.activeOperationId && TERMINAL.has(operation.status)) {
        this.activeOperationId = null;
        this.startPending();
      }
      if (operation.id === this.pending?.operationId && TERMINAL.has(operation.status)) {
        this.pending = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      }
    });
  }

  schedule(input: ProjectRefreshWorkerInput & { reason: string }): LocalOperation {
    if (this.pending) {
      this.pending.input = {
        projectRoot: input.projectRoot,
        dbtManifestPath: input.dbtManifestPath,
        writeManifest: this.pending.input.writeManifest || input.writeManifest,
      };
      this.pending.reasons.add(input.reason);
      return this.operations.get(this.pending.operationId)!;
    }

    const operation = this.operations.create({
      type: 'project_refresh',
      scope: 'project',
      phase: 'queued',
      message: 'Project search and lineage refresh queued.',
      cancellable: true,
    });
    this.pending = {
      operationId: operation.id,
      input: {
        projectRoot: input.projectRoot,
        dbtManifestPath: input.dbtManifestPath,
        writeManifest: input.writeManifest,
      },
      reasons: new Set([input.reason]),
    };
    if (!this.activeOperationId) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.startPending();
      }, this.debounceMs);
    }
    return operation;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribe();
  }

  private startPending(): void {
    if (this.activeOperationId || !this.pending) return;
    const next = this.pending;
    this.pending = null;
    this.activeOperationId = next.operationId;
    this.operations.run<ProjectRefreshWorkerResult>(
      next.operationId,
      async (signal, report) => {
        report({
          phase: 'starting',
          progress: 5,
          message: `Refreshing project state (${Array.from(next.reasons).join(', ')}).`,
        });
        const result = await this.runRefresh(next.input, signal, report);
        this.onActivated(result);
        // A file changed while the worker built its snapshot, so it left the
        // active one alone. Read the project again, after this one ends.
        if (result.superseded && this.supersededInARow < MAX_SUPERSEDED_IN_A_ROW) {
          this.supersededInARow += 1;
          this.schedule({ ...next.input, reason: 'the project changed during the last refresh' });
        } else if (!result.superseded) {
          this.supersededInARow = 0;
        }
        return result;
      },
    );
  }
}

function runRefreshWorker(
  input: ProjectRefreshWorkerInput,
  signal: AbortSignal,
  report: (progress: Partial<LocalOperationProgress>) => void,
): Promise<ProjectRefreshWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./project-refresh-worker.js', import.meta.url), {
      workerData: input,
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      void worker.terminate();
      finish(() => reject(Object.assign(new Error('Project refresh cancelled.'), { code: 'OPERATION_CANCELLED' })));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message: any) => {
      if (message?.type === 'progress') {
        report({
          phase: String(message.phase ?? 'running'),
          progress: Number(message.progress ?? 1),
          message: String(message.message ?? 'Refreshing project state.'),
        });
      } else if (message?.type === 'complete') {
        finish(() => {
          void worker.terminate();
          resolve(message.result as ProjectRefreshWorkerResult);
        });
      } else if (message?.type === 'error') {
        const error = Object.assign(
          new Error(String(message.error?.message ?? 'Project refresh failed.')),
          { code: String(message.error?.code ?? 'PROJECT_REFRESH_FAILED') },
        );
        finish(() => {
          void worker.terminate();
          reject(error);
        });
      }
    });
    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`Project refresh worker exited with code ${code}.`)));
    });
  });
}
