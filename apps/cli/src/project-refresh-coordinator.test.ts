import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalOperationCoordinator } from './local-operation-coordinator.js';
import { ProjectRefreshCoordinator, type ProjectRefreshRunner } from './project-refresh-coordinator.js';
import type { ProjectRefreshWorkerResult } from './project-refresh-worker.js';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const result = (snapshotId: string, superseded = false): ProjectRefreshWorkerResult => ({
  snapshotId,
  objectCount: 1,
  edgeCount: 0,
  metadataFingerprint: `metadata-${snapshotId}`,
  kgFingerprint: `kg-${snapshotId}`,
  ...(superseded ? { superseded: true } : {}),
});

function lane(answers: boolean[]) {
  const root = mkdtempSync(join(tmpdir(), 'dql-refresh-lane-'));
  roots.push(root);
  const operations = new LocalOperationCoordinator(join(root, 'operations.sqlite'));
  const runs: number[] = [];
  const activated: ProjectRefreshWorkerResult[] = [];
  const messages: string[] = [];
  const unsubscribe = operations.subscribe((operation) => messages.push(operation.message ?? ''));
  // Each run answers whether the project changed under it: true = superseded.
  const runRefresh: ProjectRefreshRunner = async () => {
    const index = runs.length;
    runs.push(index);
    return result(`snap-${index}`, answers[index] ?? false);
  };
  const coordinator = new ProjectRefreshCoordinator(operations, (done) => activated.push(done), 0, runRefresh);
  closers.push(() => {
    unsubscribe();
    coordinator.close();
    operations.close();
  });
  return { operations, coordinator, runs, activated, messages, root };
}

async function settle(operations: LocalOperationCoordinator, expectedRuns: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const busy = operations.list(50).some((operation) => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(operation.status));
    if (!busy && expectedRuns()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The refresh lane did not settle.');
}

describe('ProjectRefreshCoordinator', () => {
  it('reads the project again when a refresh finds its files changed under it', async () => {
    const { operations, coordinator, runs, activated, messages, root } = lane([true, false]);
    coordinator.schedule({ projectRoot: root, writeManifest: true, reason: 'certify' });
    await settle(operations, () => runs.length === 2);
    expect(runs).toHaveLength(2);
    expect(activated.map((done) => Boolean(done.superseded))).toEqual([true, false]);
    expect(messages.some((message) => message.includes('the project changed during the last refresh'))).toBe(true);
  });

  it('runs once when nothing changed under the refresh', async () => {
    const { operations, coordinator, runs, root } = lane([false]);
    coordinator.schedule({ projectRoot: root, writeManifest: true, reason: 'save' });
    await settle(operations, () => runs.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs).toHaveLength(1);
  });

  it('stops queueing after three superseded refreshes in a row', async () => {
    const { operations, coordinator, runs, root } = lane([true, true, true, true, true, true]);
    coordinator.schedule({ projectRoot: root, writeManifest: true, reason: 'save' });
    await settle(operations, () => runs.length >= 4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs).toHaveLength(4);
  });
});
