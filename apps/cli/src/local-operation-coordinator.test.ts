import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalOperationCoordinator } from './local-operation-coordinator.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('LocalOperationCoordinator', () => {
  it('persists progress and a terminal result independently from the caller', async () => {
    const coordinator = createCoordinator();
    const operation = coordinator.create({ type: 'project_refresh', scope: 'project' });
    coordinator.run(operation.id, async (_signal, report) => {
      report({ phase: 'indexing', progress: 60, message: 'Indexing.' });
      return { snapshotId: 'snap-1' };
    });

    const complete = await waitForOperation(coordinator, operation.id, 'succeeded');
    expect(complete).toMatchObject({
      phase: 'complete',
      progress: 100,
      result: { snapshotId: 'snap-1' },
      cancellable: false,
    });
    coordinator.close();
  });

  it('keeps the counts an operation reports as it goes, across a reopen (onboarding design P2)', async () => {
    const coordinator = createCoordinator();
    const operation = coordinator.create({ type: 'warehouse-setup', scope: 'warehouse-setup:SALES' });
    let release: () => void = () => undefined;
    void coordinator.run(operation.id, async (_signal, report) => {
      report({ phase: 'names', progress: 18, message: 'Reading names', detail: { kind: 'warehouse-setup', tables: 420 } });
      await new Promise<void>((resolve) => { release = resolve; });
      return { relations: 420 };
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(coordinator.get(operation.id)).toMatchObject({ status: 'running', phase: 'names', detail: { kind: 'warehouse-setup', tables: 420 } });
    expect(coordinator.list(5).find((item) => item.id === operation.id)?.detail).toEqual({ kind: 'warehouse-setup', tables: 420 });
    release();
    const complete = await waitForOperation(coordinator, operation.id, 'succeeded');
    // The last counts stay with the finished operation.
    expect(complete?.detail).toEqual({ kind: 'warehouse-setup', tables: 420 });
    coordinator.close();
  });

  it('propagates cancellation and never lets a late result overwrite it', async () => {
    const coordinator = createCoordinator();
    const operation = coordinator.create({ type: 'certification', scope: 'block:revenue' });
    coordinator.run(operation.id, async (signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
        }, { once: true });
      });
      return { outcome: 'certified' };
    });

    expect(coordinator.cancel(operation.id)).toMatchObject({ status: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.get(operation.id)).toMatchObject({
      status: 'cancelled',
      error: { code: 'OPERATION_CANCELLED', retryable: false },
    });
    coordinator.close();
  });

  it('marks unfinished work as retryable after a runtime restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-operations-restart-'));
    roots.push(root);
    const dbPath = join(root, 'operations.sqlite');
    const first = new LocalOperationCoordinator(dbPath);
    const operation = first.create({ type: 'project_refresh', scope: 'project' });
    first.close();

    const second = new LocalOperationCoordinator(dbPath);
    expect(second.get(operation.id)).toMatchObject({
      status: 'interrupted',
      error: { code: 'RUNTIME_RESTARTED', retryable: true },
    });
    second.close();
  });

  it('leaves operations a live runtime is still running to that runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-operations-live-'));
    roots.push(root);
    const dbPath = join(root, 'operations.sqlite');
    const live = new LocalOperationCoordinator(dbPath);
    const operation = live.create({ type: 'project_refresh', scope: 'project' });
    const other = new LocalOperationCoordinator(dbPath);
    expect(other.get(operation.id)).toMatchObject({ status: 'queued' });
    other.close();
    live.close();
    const afterExit = new LocalOperationCoordinator(dbPath);
    expect(afterExit.get(operation.id)).toMatchObject({ status: 'interrupted', error: { code: 'RUNTIME_RESTARTED', retryable: true } });
    afterExit.close();
  });

  it('lists every active operation alongside only the bounded recent terminal history', async () => {
    const coordinator = createCoordinator();
    const olderActive = coordinator.create({
      type: 'block_certification',
      scope: 'block:blocks/_drafts/older-active.dql',
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    for (let index = 0; index < 55; index += 1) {
      const terminal = coordinator.create({ type: 'project_refresh', scope: `project:${index}` });
      await coordinator.run(terminal.id, async () => ({ index }));
    }

    const listed = coordinator.list(50);
    expect(listed.find((operation) => operation.id === olderActive.id)).toMatchObject({
      type: 'block_certification',
      status: 'queued',
    });
    expect(listed.filter((operation) => operation.status !== 'queued' && operation.status !== 'running')).toHaveLength(50);
    expect(listed).toHaveLength(51);
    coordinator.close();
  });
});

function createCoordinator(): LocalOperationCoordinator {
  const root = mkdtempSync(join(tmpdir(), 'dql-operations-'));
  roots.push(root);
  return new LocalOperationCoordinator(join(root, 'operations.sqlite'));
}

async function waitForOperation(
  coordinator: LocalOperationCoordinator,
  operationId: string,
  status: string,
) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const operation = coordinator.get(operationId);
    if (operation?.status === status) return operation;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Operation ${operationId} did not reach ${status}.`);
}
