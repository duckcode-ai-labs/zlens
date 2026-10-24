import { describe, expect, it, vi } from 'vitest';
import {
  applyAppBuildDraftOperations,
  type AppBuildDraft,
  type AppBuildDraftOperation,
  type AppBuildDraftSource,
  type DatasetDescriptor,
} from '@zlens/core';
import type { AppBlockRecommendation, AppStudioBuildDraft, AppStudioDraftOperation } from '../../api/client';
import {
  isDatasetSourceRecoveryTask,
  planDatasetSourceRecovery,
  runDatasetSourceRecoveryAction,
} from './app-dataset-source-recovery';

const sourceId = 'app:block:commerce:order-lines';
const sourceRevision = 'sha256:order-lines-stable';
const contractFingerprint = 'sha256:order-lines-contract';

function descriptor(
  revision = sourceRevision,
  contract = contractFingerprint,
): DatasetDescriptor {
  return {
    version: 1,
    id: 'dataset:order-lines',
    kind: 'block',
    sourceRevision: revision,
    snapshotId: 'snapshot-current',
    contractRef: { kind: 'block_source', id: sourceId, fingerprint: contract },
    binding: {
      sourceQualifiedId: sourceId,
      sourceRevision: revision,
      contractFingerprint: contract,
      state: 'target_required',
    },
    label: 'Order lines Dataset',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof:order-lines' },
    fields: [
      { kind: 'physical', name: 'order_line_id', qualifiedId: `${sourceId}:order_line_id`, type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'region', qualifiedId: `${sourceId}:region`, type: 'string', role: 'dimension', status: 'approved' },
      {
        kind: 'measure', name: 'revenue', qualifiedId: `${sourceId}:revenue`, aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'],
        additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved',
      },
    ],
    operations: ['filter', 'group'],
    execution: { route: 'certified' },
  };
}

function catalogCandidate(
  revision = sourceRevision,
  contract = contractFingerprint,
): AppBlockRecommendation {
  const dataset = descriptor(revision, contract);
  return {
    id: sourceId,
    sourceId,
    qualifiedIdentity: sourceId,
    sourceRevision: revision,
    snapshotId: 'snapshot-current',
    lifecycle: 'certified',
    trust: 'certified',
    name: 'Order lines Dataset',
    domain: 'commerce',
    status: 'certified',
    owner: null,
    tags: ['commerce'],
    path: 'domains/commerce/blocks/order-lines.dql',
    fingerprint: revision,
    lastModified: '',
    description: 'Certified order lines.',
    score: 1,
    reasons: ['current governed source'],
    capabilities: {
      measures: ['revenue'], dimensions: ['region'], outputs: ['revenue'], filters: ['region'], parameters: [], dataset,
    },
    eligibility: { discoverable: true, localPreview: true, projectPublish: true, reasonCodes: [] },
  };
}

function placeholderSource(): AppBuildDraftSource {
  return {
    id: sourceId,
    kind: 'block',
    sourceRef: sourceId,
    qualifiedIdentity: 'Order lines Dataset',
    sourceRevision,
    sourceFingerprint: sourceRevision,
    lifecycle: 'unknown',
    trustState: 'review_required',
    reviewStatus: 'required',
  };
}

function draftFixture(): AppStudioBuildDraft {
  const binding = {
    id: 'dataset-order-lines', sourceId, sourceRevision, snapshotId: 'snapshot-published', contractFingerprint,
  };
  const query = { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true };
  return {
    version: 3,
    id: 'build-recovery',
    appId: 'commerce-app',
    name: 'Commerce App',
    revision: 7,
    proposalHash: 'sha256:build-recovery',
    authoringMode: 'manual',
    template: 'operational_dashboard',
    // A restore placeholder is allowed only in this local repair lane. The
    // recovery itself never changes this policy.
    sourcePolicy: 'include_review_required',
    state: 'local_draft',
    frame: { goal: 'Monitor commerce', audience: 'Operators', metrics: ['revenue'], dimensions: ['region'], filters: [], desiredOutput: 'Operational App' },
    requirements: [],
    coverage: [],
    sources: [placeholderSource()],
    pages: [
      {
        version: 3,
        id: 'overview',
        metadata: { title: 'Overview', domain: 'commerce', audience: 'Operators', visibility: 'private', lifecycle: 'draft' },
        datasets: [binding],
        filters: [{
          id: 'region', label: 'Region', type: 'select', bindsTo: 'region', field: { name: 'region' }, options: ['CA', 'US'],
          datasetBindings: { [binding.id]: { field: 'region' } },
        }],
        interactions: {
          crossFilter: { mappings: [{ fromTileId: 'revenue-kpi', fromField: 'region', toDataset: binding.id, toField: 'region' }] },
          detail: { dataset: binding.id, columns: ['order_line_id'] },
        },
        layout: {
          kind: 'grid', cols: 12, rowHeight: 80,
          items: [{
            i: 'revenue-kpi', x: 0, y: 0, w: 4, h: 2,
            sourceId, sourceRevision, query, viz: { type: 'kpi' }, title: 'Revenue KPI',
            sourceClass: 'certified_block', trustState: 'review_required', reviewStatus: 'review_required',
            review: { status: 'required', sourceFingerprint: sourceRevision, preflightReceiptId: 'old-receipt' },
          }],
        },
      },
      {
        version: 3,
        id: 'details',
        metadata: { title: 'Details', domain: 'commerce', audience: 'Operators', visibility: 'private', lifecycle: 'draft' },
        datasets: [{ ...binding, id: 'dataset-order-lines-details' }],
        layout: {
          kind: 'grid', cols: 12, rowHeight: 80,
          items: [{
            i: 'revenue-table', x: 0, y: 0, w: 8, h: 4,
            sourceId, sourceRevision, query, viz: { type: 'table' }, title: 'Revenue details',
            sourceClass: 'certified_block', trustState: 'review_required', reviewStatus: 'review_required',
            review: { status: 'required', sourceFingerprint: sourceRevision },
          }],
        },
      },
    ],
    reviewTasks: [
      {
        id: 'published-dataset-overview', message: 'Revenue KPI changed Dataset source revision after publication. Refresh or reselect the Dataset before previewing.', status: 'open',
        sourceId, pageId: 'overview', tileId: 'revenue-kpi',
      },
      {
        id: 'published-dataset-details', message: 'Revenue details changed Dataset source revision after publication. Refresh or reselect the Dataset before previewing.', status: 'open',
        sourceId, pageId: 'details', tileId: 'revenue-table',
      },
      {
        id: 'review-grain', message: 'Confirm the grain documentation before publication.', status: 'open',
        sourceId, pageId: 'overview', tileId: 'revenue-kpi',
      },
    ],
    previewReceipts: [{
      id: 'old-preview', pageId: 'overview', revision: 7, snapshotId: 'old-snapshot', filterFingerprint: 'old-filters', resultFingerprint: 'old-results', createdAt: '2026-09-11T00:00:00.000Z',
    }],
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
  };
}

describe('Dataset source recovery plan (APP-047)', () => {
  it('restores an exact current source atomically while preserving the authored page graph', () => {
    const draft = draftFixture();
    const task = draft.reviewTasks[0]!;
    expect(isDatasetSourceRecoveryTask(draft, task)).toBe(true);
    expect(isDatasetSourceRecoveryTask(draft, draft.reviewTasks[2]!)).toBe(false);

    const plan = planDatasetSourceRecovery(draft, task, catalogCandidate());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.taskIds).toEqual(['published-dataset-overview', 'published-dataset-details']);
    expect(plan.operations.filter((operation) => operation.type === 'upsert_page')).toEqual([]);
    expect(plan.operations.filter((operation) => operation.type === 'update_tile')).toHaveLength(2);

    // The server, not the browser, supplies this canonical source operation.
    const canonicalSource: AppBuildDraftSource = {
      ...placeholderSource(),
      sourceRef: 'domains/commerce/blocks/order-lines.dql',
      sourcePath: 'domains/commerce/blocks/order-lines.dql',
      executionRef: 'domains/commerce/blocks/order-lines.dql',
      snapshotId: 'snapshot-current',
      lifecycle: 'certified',
      capabilities: catalogCandidate().capabilities,
      trustState: 'certified',
      reviewStatus: 'not_required',
    };
    const canonicalOperations = plan.operations.map((operation) => operation.type === 'upsert_source'
      ? { ...operation, source: canonicalSource }
      : operation);
    const coreOperations = canonicalOperations.map((operation): AppBuildDraftOperation => {
      if (operation.type === 'upsert_source') return { type: 'upsert_source', source: operation.source };
      if (operation.type === 'update_tile') return {
        type: 'update_tile',
        pageId: operation.pageId,
        tileId: operation.tileId,
        patch: {
          sourceClass: operation.patch.sourceClass,
          trustState: operation.patch.trustState,
          reviewStatus: operation.patch.reviewStatus,
          review: operation.patch.review,
        },
      };
      if (operation.type === 'remove_review_task') return { type: 'remove_review_task', taskId: operation.taskId };
      throw new Error(`Unexpected Dataset recovery operation: ${operation.type}`);
    });
    const recovered = applyAppBuildDraftOperations(
      draft as AppBuildDraft,
      draft.revision,
      coreOperations,
      '2026-09-11T00:01:00.000Z',
    );

    expect(recovered.revision).toBe(8);
    expect(recovered.sources[0]).toMatchObject({
      sourceRevision,
      lifecycle: 'certified',
      trustState: 'certified',
      reviewStatus: 'not_required',
      capabilities: { dataset: { contractRef: { fingerprint: contractFingerprint } } },
    });
    expect(recovered.pages[0]?.datasets).toEqual(draft.pages[0]?.datasets);
    expect(recovered.pages[0]?.filters).toEqual(draft.pages[0]?.filters);
    expect(recovered.pages[0]?.interactions).toEqual(draft.pages[0]?.interactions);
    expect(recovered.pages.flatMap((page) => page.layout.items.map((tile) => tile.query))).toEqual(
      draft.pages.flatMap((page) => page.layout.items.map((tile) => tile.query)),
    );
    expect(recovered.pages.flatMap((page) => page.layout.items.map((tile) => tile.review))).toEqual([
      { status: 'not_required', sourceFingerprint: sourceRevision },
      { status: 'not_required', sourceFingerprint: sourceRevision },
    ]);
    expect(recovered.reviewTasks.map((item) => item.id)).toEqual(['review-grain']);
    expect(recovered.previewReceipts).toBeUndefined();
  });

  it('does not create a partial repair when the source is missing, changed, or no longer certified', () => {
    const draft = draftFixture();
    const task = draft.reviewTasks[0]!;
    for (const candidate of [
      undefined,
      catalogCandidate('sha256:changed-source'),
      catalogCandidate(sourceRevision, 'sha256:changed-contract'),
      { ...catalogCandidate(), lifecycle: 'review' as const, trust: 'review_required' as const, eligibility: { discoverable: true, localPreview: true, projectPublish: false, reasonCodes: ['REVIEW_REQUIRED_SOURCE'] } },
    ]) {
      const plan = planDatasetSourceRecovery(draft, task, candidate);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.error).toMatch(/current governed catalog|different data version|currently review/i);
    }
  });

  it('runs the Studio Resolve action through current-source lookup, one atomic patch, and preview invalidation', async () => {
    const draft = draftFixture();
    const task = draft.reviewTasks[0]!;
    const expectedPlan = planDatasetSourceRecovery(draft, task, catalogCandidate());
    expect(expectedPlan.ok).toBe(true);
    if (!expectedPlan.ok) return;
    const resolveCandidates = vi.fn(async (draftId: string, sourceIds: string[]) => ({
      items: draftId === draft.id && sourceIds[0] === sourceId ? [catalogCandidate()] : [],
      missingSourceIds: [],
    }));
    const patchDraft = vi.fn(async (
      draftId: string,
      expectedRevision: number,
      operations: AppStudioDraftOperation[],
      expectedProposalHash?: string,
    ) => {
      expect(draftId).toBe(draft.id);
      expect(expectedRevision).toBe(draft.revision);
      expect(expectedProposalHash).toBe(draft.proposalHash);
      expect(operations).toEqual(expectedPlan.operations);
      return { draft: { ...draft, revision: draft.revision + 1, reviewTasks: [draft.reviewTasks[2]!] } };
    });
    const onPreviewInvalidated = vi.fn();

    const result = await runDatasetSourceRecoveryAction({
      draft,
      task,
      resolveCandidates,
      patchDraft,
      onPreviewInvalidated,
    });

    expect(result).toMatchObject({ ok: true, draft: { revision: 8 } });
    expect(resolveCandidates).toHaveBeenCalledTimes(1);
    expect(resolveCandidates).toHaveBeenCalledWith(draft.id, [sourceId]);
    expect(patchDraft).toHaveBeenCalledTimes(1);
    expect(onPreviewInvalidated).toHaveBeenCalledTimes(1);
  });

  it('keeps the Studio draft unchanged when current catalog resolution is missing or drifted', async () => {
    const draft = draftFixture();
    const task = draft.reviewTasks[0]!;
    for (const items of [[], [catalogCandidate('sha256:changed-source')]]) {
      const patchDraft = vi.fn();
      const onPreviewInvalidated = vi.fn();
      const result = await runDatasetSourceRecoveryAction({
        draft,
        task,
        resolveCandidates: async () => ({ items, missingSourceIds: items.length ? [] : [sourceId] }),
        patchDraft,
        onPreviewInvalidated,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/current governed catalog|different data version/i);
      expect(patchDraft).not.toHaveBeenCalled();
      expect(onPreviewInvalidated).not.toHaveBeenCalled();
    }
  });
});
