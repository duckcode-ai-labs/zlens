import type { BlockCertificationOperationResult, LocalOperation } from '../../api/client';

export type TaskOutcomeTone = 'active' | 'success' | 'attention' | 'failure' | 'neutral';

export interface TaskOutcomePresentation {
  active: boolean;
  tone: TaskOutcomeTone;
  statusLabel: string;
  message: string;
  guidance?: string;
}

export interface TaskCenterProjection {
  operations: LocalOperation[];
  activeCount: number;
  attentionCount: number;
}

const TERMINAL_OPERATION_STATUSES = new Set<LocalOperation['status']>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

/**
 * Build the bounded presentation model used by Task Center without mutating
 * or pruning the provider's durable operation history.
 */
export function taskCenterProjection(
  operations: LocalOperation[],
  visibleLimit = 8,
): TaskCenterProjection {
  const presentable = coalesceBlockCertificationOperations(operations)
    .filter((operation) => (
      !TERMINAL_OPERATION_STATUSES.has(operation.status)
      || operation.type !== 'project_refresh'
    ));
  const presentations = presentable.map(taskOutcomePresentation);

  return {
    operations: presentable.slice(0, visibleLimit),
    activeCount: presentations.filter((presentation) => presentation.active).length,
    attentionCount: presentations.filter((presentation) => presentation.tone === 'attention').length,
  };
}

/**
 * Task Center represents the current state of each block, not every attempt.
 * Certification results retain draft, certified, and block artifact aliases,
 * so group all operations connected by one of those exact normalized paths
 * and keep only the newest attempt. Other operation types and distinct blocks
 * are left untouched.
 */
export function coalesceBlockCertificationOperations(
  operations: LocalOperation[],
): LocalOperation[] {
  const certifications = operations.filter((operation) => operation.type === 'block_certification');
  const parents = certifications.map((_, index) => index);
  const aliasOwners = new Map<string, number>();

  const find = (index: number): number => {
    let current = index;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]];
      current = parents[current];
    }
    return current;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  certifications.forEach((operation, index) => {
    for (const alias of blockCertificationPathAliases(operation)) {
      const owner = aliasOwners.get(alias);
      if (owner === undefined) aliasOwners.set(alias, index);
      else union(index, owner);
    }
  });

  const newestByGroup = new Map<number, LocalOperation>();
  certifications.forEach((operation, index) => {
    const group = find(index);
    const current = newestByGroup.get(group);
    if (!current || compareCertificationAttempts(operation, current) < 0) {
      newestByGroup.set(group, operation);
    }
  });
  const visibleCertificationIds = new Set(
    [...newestByGroup.values()].map((operation) => operation.id),
  );

  return operations.filter((operation) => (
    operation.type !== 'block_certification'
    || visibleCertificationIds.has(operation.id)
  ));
}

/**
 * Convert transport completion into the business outcome shown to a person.
 * A certification operation can finish successfully while its governed result
 * is still a saved draft with blockers; calling that result "succeeded" or
 * "complete" is misleading even though the background worker did its job.
 */
export function taskOutcomePresentation(operation: LocalOperation): TaskOutcomePresentation {
  const active = operation.status === 'queued' || operation.status === 'running';
  if (active) {
    return {
      active: true,
      tone: 'active',
      statusLabel: operation.status,
      message: operation.message,
      guidance: operation.type === 'block_certification'
        ? 'You can change pages while certification continues.'
        : undefined,
    };
  }

  if (operation.type === 'block_certification' && operation.status === 'succeeded') {
    const result = operation.result as BlockCertificationOperationResult | undefined;
    if (result?.outcome === 'draft_saved_with_blockers') {
      const blockerCount = result.checklist?.issues?.length
        ?? result.blockers?.length
        ?? result.checklist?.blockers.length
        ?? 0;
      return {
        active: false,
        tone: 'attention',
        statusLabel: 'needs attention',
        message: blockerCount > 0
          ? `Draft saved with ${blockerCount} certification blocker${blockerCount === 1 ? '' : 's'}.`
          : 'Draft saved, but certification requirements are not ready.',
        guidance: 'Open Saved queries to review the exact fixes and retry.',
      };
    }
    if (result?.outcome === 'certified') {
      return {
        active: false,
        tone: 'success',
        statusLabel: 'certified',
        message: 'The saved query passed its required gates and was certified.',
      };
    }
  }

  if (operation.status === 'failed' || operation.status === 'interrupted') {
    return {
      active: false,
      tone: 'failure',
      statusLabel: operation.status,
      message: operation.error?.message ?? operation.message,
      guidance: operation.type === 'block_certification'
        ? 'The saved draft is preserved for review or retry.'
        : undefined,
    };
  }

  if (operation.status === 'cancelled') {
    return {
      active: false,
      tone: 'neutral',
      statusLabel: 'cancelled',
      message: operation.message,
    };
  }

  return {
    active: false,
    tone: operation.status === 'succeeded' ? 'success' : 'neutral',
    statusLabel: operation.status,
    message: operation.error?.message ?? operation.message,
  };
}

function blockCertificationPathAliases(operation: LocalOperation): string[] {
  const result = objectValue(operation.result);
  const block = objectValue(result?.block);
  const metadata = objectValue(block?.metadata);
  const scopePath = operation.scope.startsWith('block:')
    ? operation.scope.slice('block:'.length)
    : undefined;
  return Array.from(new Set([
    normalizeBlockPath(block?.path),
    normalizeBlockPath(metadata?.path),
    normalizeBlockPath(result?.oldPath),
    normalizeBlockPath(result?.draftPath),
    normalizeBlockPath(result?.newPath),
    normalizeBlockPath(scopePath),
  ].filter((value): value is string => Boolean(value))));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeBlockPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function compareCertificationAttempts(left: LocalOperation, right: LocalOperation): number {
  return right.createdAt.localeCompare(left.createdAt)
    || right.updatedAt.localeCompare(left.updatedAt)
    || right.id.localeCompare(left.id);
}
