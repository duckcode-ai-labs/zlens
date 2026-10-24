import { describe, expect, it, vi } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { AppBlockRecommendation, AppStudioBuildDraft, AppStudioDraftOperation } from '../../api/client';
import {
  planDatasetSourceRebind,
  runDatasetSourceRebindAction,
} from './app-dataset-source-rebind';

const sourceId = 'app:block:commerce:order-lines';
const oldRevision = 'sha256:order-lines-old';
const newRevision = 'sha256:order-lines-new';
const oldContract = 'sha256:contract-old';
const newContract = 'sha256:contract-new';

function descriptor(revision = newRevision, contract = newContract, lifecycle: 'certified' | 'review' = 'review'): DatasetDescriptor {
  return {
    version: 1 as const,
    id: sourceId,
    kind: 'block' as const,
    sourceRevision: revision,
    snapshotId: 'snapshot-current',
    contractRef: { kind: 'block_source' as const, id: sourceId, fingerprint: contract },
    binding: { sourceQualifiedId: sourceId, sourceRevision: revision, contractFingerprint: contract, state: 'target_required' as const },
    label: 'Order lines Dataset', lifecycle, trust: lifecycle === 'certified' ? 'certified' as const : 'review_required' as const,
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof:order-lines' },
    fields: [
      { kind: 'physical' as const, name: 'order_line_id', qualifiedId: 'field:key', type: 'string' as const, role: 'key' as const, status: 'approved' as const },
      { kind: 'physical' as const, name: 'region', qualifiedId: 'field:region', type: 'string' as const, role: 'dimension' as const, status: 'approved' as const },
      { kind: 'physical' as const, name: 'order_date', qualifiedId: 'field:date', type: 'date' as const, role: 'time' as const, status: 'approved' as const, time: { grains: ['day', 'month'], primary: true } },
      { kind: 'physical' as const, name: 'net_amount', qualifiedId: 'field:amount', type: 'number' as const, role: 'attribute' as const, status: 'approved' as const },
      { kind: 'measure' as const, name: 'revenue', qualifiedId: 'measure:revenue', aggregation: 'sum' as const, from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive' as const, time: 'additive' as const }, allowedAggs: ['sum' as const], format: { kind: 'currency' as const, currency: 'USD' }, status: 'approved' as const },
    ],
    operations: ['filter', 'group', 'trend', 'detail'],
    execution: { route: 'governed_sql' as const },
  };
}

function candidate(lifecycle: 'certified' | 'review' = 'review'): AppBlockRecommendation {
  const dataset = descriptor(newRevision, newContract, lifecycle);
  return {
    id: sourceId, sourceId, qualifiedIdentity: sourceId, sourceRevision: newRevision, snapshotId: 'snapshot-current',
    name: 'Order lines Dataset', domain: 'commerce', status: lifecycle, owner: null, tags: [],
    path: 'domains/commerce/blocks/order-lines.dql', fingerprint: newRevision, lastModified: '', description: 'Current Dataset', score: 1, reasons: [],
    lifecycle, trust: lifecycle === 'certified' ? 'certified' : 'review_required',
    capabilities: { measures: ['revenue'], dimensions: ['region'], outputs: [], filters: ['region'], parameters: [], dataset },
    eligibility: { discoverable: true, localPreview: true, projectPublish: lifecycle === 'certified', reasonCodes: lifecycle === 'certified' ? [] : ['REVIEW_REQUIRED_SOURCE'] },
  };
}

function draftFixture(): AppStudioBuildDraft {
  const oldDataset = descriptor(oldRevision, oldContract, 'certified');
  const source = {
    id: sourceId, kind: 'block' as const, sourceRef: 'domains/commerce/blocks/order-lines.dql', qualifiedIdentity: sourceId,
    sourcePath: 'domains/commerce/blocks/order-lines.dql', executionRef: 'domains/commerce/blocks/order-lines.dql', snapshotId: 'snapshot-old', sourceRevision: oldRevision, sourceFingerprint: oldRevision,
    lifecycle: 'certified' as const, capabilities: { measures: ['revenue'], dimensions: ['region'], outputs: [], filters: ['region'], parameters: [], dataset: oldDataset },
    trustState: 'certified' as const, reviewStatus: 'not_required' as const,
  };
  const query = { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true };
  const binding = { sourceId, sourceRevision: oldRevision, snapshotId: 'snapshot-old', contractFingerprint: oldContract };
  return {
    version: 3, id: 'build-rebind', appId: 'commerce-app', name: 'Commerce App', revision: 4, proposalHash: 'sha256:rebind', authoringMode: 'manual', template: 'operational_dashboard', sourcePolicy: 'governed_only', state: 'local_draft',
    frame: { goal: 'Monitor commerce', audience: 'Operators', metrics: ['revenue'], dimensions: ['region'], filters: [], desiredOutput: 'Operational App' },
    requirements: [], coverage: [], sources: [source], reviewTasks: [],
    pages: [
      {
        version: 3, id: 'overview', metadata: { title: 'Overview', domain: 'commerce', audience: 'Operators', visibility: 'private', lifecycle: 'draft' },
        datasets: [{ id: 'orders', ...binding }],
        filters: [{ id: 'region', label: 'Region', type: 'select', field: { name: 'region' }, datasetBindings: { orders: { field: 'region' } }, options: ['CA', 'US'] }],
        interactions: { crossFilter: { mappings: [{ fromTileId: 'revenue-region', fromField: 'region', toDataset: 'orders', toField: 'region' }] }, detail: { dataset: 'orders', columns: ['order_line_id', 'region'] } },
        layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'revenue-region', x: 0, y: 0, w: 6, h: 4, sourceId, sourceRevision: oldRevision, query, viz: { type: 'bar' }, title: 'Revenue by region', sourceClass: 'certified_block', trustState: 'certified', reviewStatus: 'certified', review: { status: 'not_required', sourceFingerprint: oldRevision } }] },
      },
      {
        version: 3, id: 'details', metadata: { title: 'Details', domain: 'commerce', audience: 'Operators', visibility: 'private', lifecycle: 'draft' },
        datasets: [{ id: 'orders-details', ...binding }],
        layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'revenue-table', x: 0, y: 0, w: 8, h: 4, sourceId, sourceRevision: oldRevision, query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true }, viz: { type: 'table' }, title: 'Revenue table', sourceClass: 'certified_block', trustState: 'certified', reviewStatus: 'certified', review: { status: 'not_required', sourceFingerprint: oldRevision } }] },
      },
    ],
    createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
  } as AppStudioBuildDraft;
}

describe('Dataset source rebind plan (APP-056)', () => {
  it('rewrites the complete current-App binding graph atomically for data nobody certified, with no data rule and no review task (T3)', () => {
    const draft = draftFixture();
    for (const options of [{}, { enableReviewPreview: true }]) {
      const plan = planDatasetSourceRebind(draft, candidate(), options);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.operations.some((operation) => operation.type === 'set_source_policy')).toBe(false);
      expect(plan.operations.filter((operation) => operation.type === 'upsert_source')).toHaveLength(1);
      const pages = plan.operations.filter((operation): operation is Extract<AppStudioDraftOperation, { type: 'upsert_page' }> => operation.type === 'upsert_page');
      expect(pages).toHaveLength(2);
      expect(pages.flatMap((operation) => operation.page.datasets ?? []).map((binding) => [binding.sourceRevision, binding.contractFingerprint])).toEqual([
        [newRevision, newContract], [newRevision, newContract],
      ]);
      expect(pages.flatMap((operation) => operation.page.layout.items).filter((tile) => tile.query).every((tile) => (
        tile.sourceRevision === newRevision && tile.trustState === 'review_required' && tile.review?.status === 'required'
      ))).toBe(true);
      expect(plan.operations.filter((operation) => operation.type === 'set_review_task')).toHaveLength(0);
    }
    expect(draft.pages[0]!.datasets![0]!.sourceRevision).toBe(oldRevision);
  });

  it('does not patch if the changed definition removes a selected measure or mapped field', async () => {
    const draft = draftFixture();
    const incompatible = candidate('certified');
    incompatible.capabilities!.dataset = {
      ...incompatible.capabilities!.dataset!,
      fields: incompatible.capabilities!.dataset!.fields.filter((field) => field.name !== 'revenue' && field.name !== 'region'),
    } as any;
    const plan = planDatasetSourceRebind(draft, incompatible);
    expect(plan).toMatchObject({ ok: false, code: 'SOURCE_INCOMPATIBLE' });

    const patchDraft = vi.fn();
    const result = await runDatasetSourceRebindAction({
      draft,
      sourceId,
      resolveCandidates: async () => ({ items: [incompatible], missingSourceIds: [] }),
      patchDraft,
    });
    expect(result.ok).toBe(false);
    expect(patchDraft).not.toHaveBeenCalled();
  });

  it('resolves current source authority after reload and sends exactly one atomic patch only after validation', async () => {
    const draft = draftFixture();
    const patchDraft = vi.fn(async (
      draftId: string,
      expectedRevision: number,
      operations: AppStudioDraftOperation[],
      expectedProposalHash?: string,
    ) => {
      expect(draftId).toBe(draft.id);
      expect(expectedRevision).toBe(draft.revision);
      expect(expectedProposalHash).toBe(draft.proposalHash);
      expect(operations.some((operation) => operation.type === 'upsert_page')).toBe(true);
      return { draft: { ...draft, revision: 5, sourcePolicy: 'include_review_required' as const } };
    });
    const invalidate = vi.fn();
    const resolveCandidates = vi.fn(async (_draftId: string, sourceIds: string[], options?: { includeReviewRequired?: boolean }) => {
      expect(sourceIds).toEqual([sourceId]);
      expect(options).toEqual({ includeReviewRequired: true });
      return { items: [candidate()], missingSourceIds: [] };
    });

    const result = await runDatasetSourceRebindAction({
      draft,
      sourceId,
      enableReviewPreview: true,
      resolveCandidates,
      patchDraft,
      onPreviewInvalidated: invalidate,
    });
    expect(result).toMatchObject({ ok: true, draft: { revision: 5 }, plan: { requiresReviewPolicy: true } });
    expect(resolveCandidates).toHaveBeenCalledTimes(1);
    expect(patchDraft).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
