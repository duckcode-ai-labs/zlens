import { describe, expect, it } from 'vitest';
import {
  applyAppBuildDraftOperations,
  parseDashboardDocument,
  type AppBuildDraft,
  type AppBuildDraftOperation,
} from '@zlens/core';
import type { AppStudioBuildDraft, AppStudioDraftOperation, DashboardRunResponse } from '../../api/client';
import {
  blockingPublicationReviewTasks,
  isDatasetBackedAppSource,
  legacySemanticPendingPageIds,
  legacySemanticSourcesNeedingApproval,
  legacySemanticTilesNeedingApproval,
  localPublicationSteps,
  pagesNeedingSettledPreview,
  planLegacySemanticApproval,
  draftTrust,
  plainReviewTaskMessage,
  publicationBlockerCount,
  publicationBlockingSources,
  publicationIssueSummaries,
  publicationReadiness,
  publicationTilesNeedingReview,
  tilePatchWithoutRelatedFields,
  tileUsesLegacySemanticApproval,
  unresolvedPublicationRequirements,
  uncertifiedPublicationSources,
  notCertifiedPublicationTiles,
} from './app-studio-publish-readiness';
import { publishReadyLine, readersWillSeeText } from '@zlens/core/apps/app-trust';

function coreDashboardDocument(page: AppStudioBuildDraft['pages'][number]) {
  const parsed = parseDashboardDocument(JSON.stringify(page), '<readiness-test.dqld>');
  if (!parsed.document) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  return parsed.document;
}

function coreDraft(draft: AppStudioBuildDraft): AppBuildDraft {
  return { ...draft, pages: draft.pages.map(coreDashboardDocument) };
}

function studioDraft(draft: AppBuildDraft, audience: string): AppStudioBuildDraft {
  return {
    ...draft,
    frame: {
      ...draft.frame,
      audience: draft.frame.audience ?? audience,
      desiredOutput: draft.frame.desiredOutput ?? 'Operational App',
    },
  };
}

function coreApprovalOperations(operations: AppStudioDraftOperation[]): AppBuildDraftOperation[] {
  return operations.map((operation): AppBuildDraftOperation => {
    if (operation.type === 'upsert_source') return { type: 'upsert_source', source: operation.source };
    if (operation.type === 'update_tile') {
      return {
        type: 'update_tile',
        pageId: operation.pageId,
        tileId: operation.tileId,
        patch: { semantic: operation.patch.semantic, review: operation.patch.review },
      };
    }
    throw new Error(`Unexpected approval operation: ${operation.type}`);
  });
}

function applyApprovalPlanThroughCore(
  draft: AppStudioBuildDraft,
  operations: AppStudioDraftOperation[],
  now: string,
): AppStudioBuildDraft {
  return studioDraft(
    applyAppBuildDraftOperations(coreDraft(draft), draft.revision, coreApprovalOperations(operations), now),
    draft.frame.audience,
  );
}

function draftFixture(): AppStudioBuildDraft {
  return {
    version: 3,
    id: 'build-1',
    appId: 'revenue-app',
    name: 'Revenue App',
    revision: 3,
    proposalHash: 'sha256:draft',
    authoringMode: 'ai',
    template: 'operational_dashboard',
    sourcePolicy: 'governed_only',
    state: 'local_draft',
    frame: { goal: 'Monitor revenue', audience: 'Finance', metrics: ['revenue'], dimensions: ['month'], filters: [], desiredOutput: 'Operational App' },
    requirements: [{ id: 'trend', question: 'Revenue over time', role: 'trend', required: true, measures: ['revenue'], dimensions: ['month'], filters: [] }],
    coverage: [{ requirementId: 'trend', status: 'gap', sourceIds: [], componentIds: [], reasons: [] }],
    sources: [{ id: 'block:revenue', kind: 'certified_block', sourceRef: 'revenue', trustState: 'certified', reviewStatus: 'not_required' }],
    pages: [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'revenue', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'revenue' }, viz: { type: 'line' } }] },
    }],
    reviewTasks: [{ id: 'ai-review-1', message: 'Review every scoped analysis memo before stakeholder use.', status: 'open' }],
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
}

describe('App Studio publication readiness (API-013, UI-022)', () => {
  it('does not treat old unscoped AI reminders as publication blockers', () => {
    const draft = draftFixture();
    expect(blockingPublicationReviewTasks(draft)).toEqual([]);
    expect(localPublicationSteps(draft).map((step) => step.id)).toEqual(['questions', 'preview']);
  });

  it('keeps content-scoped review tasks blocking until resolved or removed', () => {
    const draft = draftFixture();
    draft.reviewTasks.push({ id: 'review-revenue', message: 'Validate revenue grain.', status: 'open', sourceId: 'block:revenue', tileId: 'revenue' });
    expect(blockingPublicationReviewTasks(draft).map((task) => task.id)).toEqual(['review-revenue']);
  });

  it('clears the question and preview steps only with explicit scope and a current settled receipt', () => {
    const draft = draftFixture();
    draft.requirements[0].required = false;
    draft.previewReceipts = [{ id: 'run-1', pageId: 'overview', revision: draft.revision, snapshotId: 'snapshot', filterFingerprint: 'filters', resultFingerprint: 'result', createdAt: draft.updatedAt }];
    expect(unresolvedPublicationRequirements(draft)).toEqual([]);
    expect(pagesNeedingSettledPreview(draft)).toEqual([]);
    expect(localPublicationSteps(draft)).toEqual([]);
  });

  it('ignores empty-measure AI placeholders on a manually authored App', () => {
    const draft = draftFixture();
    draft.authoringMode = 'manual';
    draft.frame.metrics = [];
    draft.requirements[0].measures = [];
    expect(unresolvedPublicationRequirements(draft)).toEqual([]);
  });

  it('does not duplicate a review-required DQL source as a changed-source action (API-013)', () => {
    expect(publicationIssueSummaries([
      'overview/ask-result references app-scoped exploratory DQL; promote it to governed semantic logic or a certified block first.',
    ])).toEqual([]);
  });

  it('sends a tile with no filter choice to the Filters tab, and an unchecked link to preview', () => {
    const summaries = publicationIssueSummaries([
      'overview/revenue-trend has no choice for filter Customer Name. Open the Filters tab and set this tile to Applies or Does not apply.',
      'overview/orders has no choice for filter Customer Name. Open the Filters tab and set this tile to Applies or Does not apply.',
      'overview/top-customers does not have a preflighted binding for filter Region.',
    ]);
    expect(summaries).toEqual([
      expect.objectContaining({ title: 'Choose where Customer Name applies', action: 'filters', detail: expect.stringContaining('2 tiles have no choice for Customer Name') }),
      expect.objectContaining({ title: 'Refresh the preview for Region', action: 'preview' }),
    ]);
  });

  it('routes certified fingerprint drift to refresh but draft resolution failures to replacement (UI-023)', () => {
    expect(publicationIssueSummaries(['Source sales.revenue changed after selection.'])[0]?.action).toBe('refresh_sources');
    expect(publicationIssueSummaries(['overview/orders no longer resolves to a certified block.'])[0]).toMatchObject({
      action: 'sources',
      title: 'Replace or remove this source',
    });
  });

  it('a saved query nobody certified is a tile Not certified yet, never a blocker (PRD-007, T3)', () => {
    const draft = draftFixture();
    draft.sources = [{
      id: 'source:draft-orders',
      kind: 'block',
      sourceRef: 'orders_by_region',
      lifecycle: 'draft',
      trustState: 'review_required',
      reviewStatus: 'required',
    }];
    draft.pages[0]!.layout.items[0]!.block = { blockId: 'orders_by_region' };
    expect(publicationBlockingSources(draft).map((source) => source.id)).toEqual([]);
    expect(localPublicationSteps(draft).map((step) => step.id)).not.toContain('sources');
    expect(uncertifiedPublicationSources(draft.sources).map((source) => source.id)).toEqual(['source:draft-orders']);
  });

  it('never blocks publishing on connected data no tile uses; Publish leaves it out (design D4)', () => {
    const draft = draftFixture();
    draft.sources.push({
      id: 'source:draft-orders', kind: 'block', sourceRef: 'orders_by_region', lifecycle: 'draft',
      trustState: 'review_required', reviewStatus: 'required',
    });
    draft.reviewTasks.push({ id: 'review-orders', message: 'Certify orders.', status: 'open', sourceId: 'source:draft-orders' });
    expect(publicationBlockingSources(draft)).toEqual([]);
    expect(blockingPublicationReviewTasks(draft)).toEqual([]);
    expect(localPublicationSteps(draft).map((step) => step.id)).not.toContain('sources');
  });

  it('treats two settled pages backed by a certified semantic Dataset as ready without legacy result approval', () => {
    const draft = draftFixture();
    draft.coverage[0] = { ...draft.coverage[0], status: 'covered', sourceIds: ['dataset:commerce-orders'], componentIds: ['revenue'] };
    draft.reviewTasks = [];
    draft.sources = [{
      id: 'dataset:commerce-orders',
      kind: 'governed_semantic',
      sourceRef: 'commerce.orders',
      lifecycle: 'certified',
      trustState: 'certified',
      reviewStatus: 'not_required',
      capabilities: { dataset: { kind: 'semantic' } as never } as never,
    }];
    draft.pages = [
      { ...draft.pages[0], version: 3 },
      {
        ...draft.pages[0],
        version: 3,
        id: 'detail',
        metadata: { ...draft.pages[0]!.metadata, title: 'Details' },
        layout: {
          ...draft.pages[0]!.layout,
          items: draft.pages[0]!.layout.items.map((tile) => ({ ...tile, i: 'detail-revenue' })),
        },
      },
    ];
    draft.previewReceipts = draft.pages.map((page) => ({
      id: `run-${page.id}`,
      pageId: page.id,
      revision: draft.revision,
      snapshotId: 'snapshot-current',
      filterFingerprint: `filters-${page.id}`,
      resultFingerprint: `results-${page.id}`,
      createdAt: draft.updatedAt,
    }));

    expect(legacySemanticSourcesNeedingApproval(draft)).toEqual([]);
    expect(publicationBlockingSources(draft)).toEqual([]);
    expect(pagesNeedingSettledPreview(draft)).toEqual([]);
    expect(publicationBlockerCount(draft)).toBe(0);
    expect(localPublicationSteps(draft)).toEqual([]);
  });

  it('keeps review Dataset semantics governed while approval actions target legacy semantic sources only', () => {
    const draft = draftFixture();
    const certifiedDataset = {
      id: 'dataset:certified',
      kind: 'governed_semantic' as const,
      sourceRef: 'commerce.certified_orders',
      lifecycle: 'certified' as const,
      trustState: 'certified' as const,
      reviewStatus: 'not_required' as const,
      capabilities: { dataset: { kind: 'semantic' } as never } as never,
    };
    const legacySemantic = {
      id: 'semantic:legacy',
      kind: 'governed_semantic' as const,
      sourceRef: 'commerce.legacy_orders',
      trustState: 'certified' as const,
      reviewStatus: 'required' as const,
    };
    const reviewDataset = {
      id: 'dataset:review',
      kind: 'governed_semantic' as const,
      sourceRef: 'commerce.review_orders',
      lifecycle: 'review' as const,
      trustState: 'review_required' as const,
      reviewStatus: 'required' as const,
      capabilities: { dataset: { kind: 'semantic' } as never } as never,
    };
    draft.sources = [certifiedDataset, legacySemantic, reviewDataset];
    const legacyTile = {
      ...draft.pages[0]!.layout.items[0]!,
      i: 'legacy-semantic',
      semantic: {
        id: 'legacy', provider: 'native' as const, metrics: ['revenue'],
        semanticModelRefs: ['commerce.orders'], definitionFingerprint: 'sha256:legacy-semantic',
      },
      sourceId: legacySemantic.id,
    };
    const datasetTile = {
      ...draft.pages[0]!.layout.items[0]!,
      i: 'dataset-semantic',
      semantic: {
        id: 'dataset', provider: 'native' as const, metrics: ['revenue'],
        semanticModelRefs: ['commerce.orders'], definitionFingerprint: 'sha256:dataset-semantic',
      },
      sourceId: certifiedDataset.id,
    };
    draft.pages[0] = {
      ...draft.pages[0]!,
      layout: { ...draft.pages[0]!.layout, items: [legacyTile, datasetTile, { ...draft.pages[0]!.layout.items[0]!, i: 'review-dataset', sourceId: reviewDataset.id }] },
    };

    expect(isDatasetBackedAppSource(certifiedDataset)).toBe(true);
    expect(legacySemanticSourcesNeedingApproval(draft).map((source) => source.id)).toEqual([legacySemantic.id]);
    // A Metrics Dataset nobody certified is not a blocker (T3): its tile reads Not certified yet.
    expect(publicationBlockingSources(draft).map((source) => source.id)).toEqual([legacySemantic.id]);
    expect(tileUsesLegacySemanticApproval(draft, legacyTile)).toBe(true);
    expect(tileUsesLegacySemanticApproval(draft, datasetTile)).toBe(false);
  });

  it('approves only successful legacy semantic tiles on the page that produced the preview', () => {
    const draft = draftFixture();
    const datasetSource = {
      id: 'dataset:commerce',
      kind: 'governed_semantic' as const,
      sourceRef: 'commerce.orders',
      lifecycle: 'certified' as const,
      trustState: 'certified' as const,
      reviewStatus: 'not_required' as const,
      capabilities: { dataset: { kind: 'semantic' } as never } as never,
    };
    const legacySource = {
      id: 'semantic:legacy',
      kind: 'governed_semantic' as const,
      sourceRef: 'commerce.legacy_orders',
      trustState: 'certified' as const,
      reviewStatus: 'required' as const,
    };
    const nativeDatasetTile = {
      ...draft.pages[0]!.layout.items[0]!,
      i: 'dataset-kpi',
      sourceId: datasetSource.id,
      semantic: {
        id: 'native-commerce-dataset', provider: 'native' as const, metrics: ['revenue'],
        semanticModelRefs: ['commerce.orders'], definitionFingerprint: 'sha256:dataset-semantic',
      },
    };
    const legacyTile = {
      ...draft.pages[0]!.layout.items[0]!,
      i: 'legacy-chart',
      sourceId: legacySource.id,
      semantic: {
        id: 'legacy-commerce', provider: 'native' as const, metrics: ['revenue'],
        semanticModelRefs: ['commerce.orders'], definitionFingerprint: 'sha256:legacy-semantic',
      },
    };
    draft.sources = [datasetSource, legacySource];
    draft.pages = [
      {
        ...draft.pages[0]!,
        version: 3,
        layout: { ...draft.pages[0]!.layout, items: [nativeDatasetTile] },
      },
      {
        ...draft.pages[0]!,
        version: 3,
        id: 'details',
        metadata: { ...draft.pages[0]!.metadata, title: 'Details' },
        layout: { ...draft.pages[0]!.layout, items: [legacyTile] },
      },
    ];

    const settledRun = (dashboardId: string, runId: string, tileId: string, tileType: 'dataset' | 'semantic'): DashboardRunResponse => ({
      appId: draft.appId,
      dashboardId,
      persona: {},
      runId,
      snapshotId: `snapshot:${runId}`,
      filterFingerprint: `filters:${runId}`,
      resultFingerprint: `results:${runId}`,
      personaFingerprint: `persona:${runId}`,
      facts: [],
      story: {
        headline: 'Settled preview',
        paragraphs: [],
        claims: [],
        evidenceRefs: [],
        trustState: 'certified',
        generatedBy: 'deterministic',
      },
      tiles: [{ tileId, tileType, status: 'ok' }],
    });

    const datasetPageApproval = planLegacySemanticApproval(
      draft,
      draft.pages[0]!,
      settledRun('overview', 'run-dataset-page', 'dataset-kpi', 'dataset'),
      '2026-09-11T12:00:00.000Z',
    );
    expect(datasetPageApproval).toEqual({ operations: [], pendingPageIds: ['details'] });

    const wrongPageApproval = planLegacySemanticApproval(
      draft,
      draft.pages[1]!,
      settledRun('overview', 'run-dataset-page', 'dataset-kpi', 'dataset'),
      '2026-09-11T12:00:00.000Z',
    );
    expect(wrongPageApproval).toEqual({ operations: [], pendingPageIds: ['details'] });

    const legacyPageApproval = planLegacySemanticApproval(
      draft,
      draft.pages[1]!,
      settledRun('details', 'run-legacy-page', 'legacy-chart', 'semantic'),
      '2026-09-11T12:00:00.000Z',
    );
    expect(legacyPageApproval.pendingPageIds).toEqual(['details']);
    expect(legacyPageApproval.operations).toEqual([
      expect.objectContaining({
        type: 'upsert_source',
        source: expect.objectContaining({
          id: legacySource.id,
          snapshotId: 'snapshot:run-legacy-page',
          receiptId: 'run-legacy-page',
          reviewStatus: 'approved',
        }),
      }),
      expect.objectContaining({
        type: 'update_tile',
        pageId: 'details',
        tileId: 'legacy-chart',
        patch: expect.objectContaining({
          semantic: expect.objectContaining({ snapshotId: 'snapshot:run-legacy-page' }),
          review: expect.objectContaining({ preflightReceiptId: 'run-legacy-page' }),
        }),
      }),
    ]);
  });

  it('keeps a shared legacy semantic source pending until every tile receives its own settled proof', () => {
    const draft = draftFixture();
    const sharedSource = {
      id: 'semantic:shared',
      kind: 'governed_semantic' as const,
      sourceRef: 'commerce.shared_orders',
      trustState: 'certified' as const,
      reviewStatus: 'required' as const,
    };
    const legacyTile = (id: string) => ({
      ...draft.pages[0]!.layout.items[0]!,
      i: id,
      sourceId: sharedSource.id,
      semantic: {
        id: 'shared-commerce', provider: 'native' as const, metrics: ['revenue'],
        semanticModelRefs: ['commerce.orders'], definitionFingerprint: 'sha256:shared-semantic',
      },
    });
    draft.sources = [sharedSource];
    draft.pages = [
      {
        ...draft.pages[0]!,
        version: 3,
        layout: { ...draft.pages[0]!.layout, items: [legacyTile('legacy-overview')] },
      },
      {
        ...draft.pages[0]!,
        version: 3,
        id: 'details',
        metadata: { ...draft.pages[0]!.metadata, title: 'Details' },
        layout: { ...draft.pages[0]!.layout, items: [legacyTile('legacy-details')] },
      },
    ];
    const settledRun = (dashboardId: string, runId: string, tileId: string): DashboardRunResponse => ({
      appId: draft.appId,
      dashboardId,
      persona: {},
      runId,
      snapshotId: `snapshot:${runId}`,
      filterFingerprint: `filters:${runId}`,
      resultFingerprint: `results:${runId}`,
      personaFingerprint: `persona:${runId}`,
      facts: [],
      story: {
        headline: 'Settled preview',
        paragraphs: [],
        claims: [],
        evidenceRefs: [],
        trustState: 'certified',
        generatedBy: 'deterministic',
      },
      tiles: [{ tileId, tileType: 'semantic', status: 'ok' }],
    });

    const overviewApproval = planLegacySemanticApproval(
      draft,
      draft.pages[0]!,
      settledRun('overview', 'run-overview', 'legacy-overview'),
      '2026-09-11T12:00:00.000Z',
    );
    expect(overviewApproval.operations).toHaveLength(2);
    const afterOverviewApproval = applyApprovalPlanThroughCore(
      draft,
      overviewApproval.operations,
      '2026-09-11T12:00:01.000Z',
    );
    expect(afterOverviewApproval.sources[0]).toMatchObject({
      id: sharedSource.id,
      reviewStatus: 'approved',
      snapshotId: 'snapshot:run-overview',
      receiptId: 'run-overview',
    });
    expect(legacySemanticTilesNeedingApproval(afterOverviewApproval)
      .map(({ page, tile }) => `${page.id}/${tile.i}`)).toEqual(['details/legacy-details']);
    expect(legacySemanticPendingPageIds(afterOverviewApproval)).toEqual(['details']);
    expect(legacySemanticSourcesNeedingApproval(afterOverviewApproval).map((source) => source.id)).toEqual([sharedSource.id]);
    expect(publicationBlockingSources(afterOverviewApproval).map((source) => source.id)).toEqual([sharedSource.id]);
    expect(localPublicationSteps(afterOverviewApproval)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sources', count: 1 }),
    ]));

    const detailsApproval = planLegacySemanticApproval(
      afterOverviewApproval,
      afterOverviewApproval.pages[1]!,
      settledRun('details', 'run-details', 'legacy-details'),
      '2026-09-11T12:01:00.000Z',
    );
    expect(detailsApproval.operations).toEqual([
      expect.objectContaining({ type: 'upsert_source', source: expect.objectContaining({ id: sharedSource.id, receiptId: 'run-details' }) }),
      expect.objectContaining({ type: 'update_tile', pageId: 'details', tileId: 'legacy-details', patch: expect.objectContaining({ review: expect.objectContaining({ preflightReceiptId: 'run-details' }) }) }),
    ]);
    const afterDetailsApproval = applyApprovalPlanThroughCore(
      afterOverviewApproval,
      detailsApproval.operations,
      '2026-09-11T12:01:01.000Z',
    );
    expect(legacySemanticTilesNeedingApproval(afterDetailsApproval)).toEqual([]);
    expect(legacySemanticSourcesNeedingApproval(afterDetailsApproval)).toEqual([]);
    expect(publicationBlockingSources(afterDetailsApproval)).toEqual([]);
    expect(localPublicationSteps(afterDetailsApproval).find((step) => step.id === 'sources')).toBeUndefined();
  });

  it('uses the actionable blocker total for both the toolbar and publish review (UI-023)', () => {
    const draft = draftFixture();
    draft.requirements.push({ id: 'orders', question: 'Orders by region', role: 'breakdown', required: true, measures: ['orders'], dimensions: ['region'], filters: [] });
    draft.coverage.push({ requirementId: 'orders', status: 'gap', sourceIds: [], componentIds: [], reasons: [] });
    draft.reviewTasks.push({ id: 'review-revenue', message: 'Validate revenue grain.', status: 'open', tileId: 'revenue' });
    draft.sources = [{
      id: 'source:draft-orders',
      kind: 'block',
      sourceRef: 'orders_by_region',
      lifecycle: 'draft',
      trustState: 'review_required',
      reviewStatus: 'required',
    }];
    draft.pages[0]!.layout.items[0]!.block = { blockId: 'orders_by_region' };

    const issues = [
      'Source sales.revenue changed after selection.',
      'overview/orders no longer resolves to a certified block.',
    ];
    // Two questions, one review task and two server messages; the page Publish
    // runs itself is listed but is not a fix (B6), and data nobody certified is
    // not a fix either (T3).
    expect(publicationBlockerCount(draft, issues)).toBe(5);
    const readiness = publicationReadiness(draft, issues);
    expect(readiness.previewPages).toHaveLength(1);
    expect(readiness.fixCount).toBe(readiness.requirements.length + readiness.clarifications.length + readiness.tasks.length
      + readiness.serverIssues.length
      + (readiness.semanticTiles.length ? 1 : 0) + (readiness.localOnlySources.length ? 1 : 0));
    // The project requires certified data: the tiles not certified yet are one more fix.
    expect(publicationBlockerCount(draft, issues, {}, { requireCertifiedToPublish: true })).toBe(6);
  });
});

/** The reviewer's App: Orders (not certified yet) behind three tiles, as "5 fixes" opened "9 fixes". */
function uncertifiedOrdersDraft(): AppStudioBuildDraft {
  const draft = draftFixture();
  const sourceId = 'app:block:general:orders';
  draft.requirements = [];
  draft.coverage = [];
  draft.sources = [{ id: sourceId, kind: 'block', sourceRef: 'orders', qualifiedIdentity: 'general::block::orders', lifecycle: 'review', trustState: 'review_required', reviewStatus: 'required', checked: true, capabilities: { dataset: { kind: 'block', label: 'Orders', trust: 'review_required', fields: [] } as never } as never }];
  draft.reviewTasks = [{ id: 'review-source-orders', message: 'Orders is review and must be certified, replaced, or removed before Project publication.', status: 'open', sourceId, pageId: 'overview' }];
  draft.pages = [{
    version: 3,
    id: 'overview',
    metadata: { title: 'Overview' },
    datasets: [{ id: 'orders_ds', sourceId, sourceRevision: 'sha256:orders', snapshotId: 's', contractFingerprint: 'c' }],
    layout: { kind: 'grid', cols: 12, rowHeight: 80, items: ['orders-kpi', 'orders-trend', 'top-customers'].map((i, index) => ({
      i, x: index * 4, y: 0, w: 4, h: 3, title: i, sourceId, sourceRevision: 'sha256:orders',
      query: { dimensions: [], measures: [{ measure: 'order_total' }], respectsGlobalFilters: true }, viz: { type: 'single_value' },
    })) },
  }] as never;
  draft.previewReceipts = [{ id: 'run-1', pageId: 'overview', revision: draft.revision, snapshotId: 's', filterFingerprint: 'f', resultFingerprint: 'r', createdAt: draft.updatedAt }];
  return draft;
}

describe('an honest fix count (B6)', () => {
  it('the button and the dialog count the same list, and one root cause is one row', () => {
    const draft = uncertifiedOrdersDraft();
    const before = publicationReadiness(draft);
    // Orders is not certified yet: its three tiles are listed with "Certify now", and nothing blocks (T3).
    expect(before.uncertifiedSources.map((source) => source.id)).toEqual(['app:block:general:orders']);
    expect(before.notCertified.map((tile) => [tile.tileId, tile.action.kind])).toEqual([['orders-kpi', 'source'], ['orders-trend', 'source'], ['top-customers', 'source']]);
    // Its old "needs certifying" reminder is not a task to resolve.
    expect(before.tasks).toEqual([]);
    expect(before.fixCount).toBe(0);
    expect(before.ready).toBe(true);
    // Required by the project: one fix for all three tiles.
    const required = publicationReadiness(draft, [], {}, { requireCertifiedToPublish: true });
    expect(required.requireCertified).toBe(true);
    expect(required.fixCount).toBe(1);
    expect(required.ready).toBe(false);
    // What the server says about the same source and its three tiles adds no rows.
    const serverIssues = [
      'Dataset tile orders-kpi is currently review and is not eligible for Project publication. Refresh the governed source and run the draft again after certification.',
      'overview/orders-kpi does not resolve to its current certified saved query.',
      'overview/orders-trend does not resolve to its current certified saved query.',
      'overview/top-customers does not resolve to its current certified saved query.',
      'overview/orders-kpi uses a review Dataset source and cannot be published to the Project.',
      'Source app:block:general:orders is review and cannot be published to the Project.',
    ];
    const after = publicationReadiness(draft, serverIssues);
    expect(after.serverIssues).toEqual([]);
    expect(after.fixCount).toBe(before.fixCount);
    expect(publicationBlockerCount(draft, serverIssues)).toBe(after.fixCount);
    // The server's one require-certified message turns the requirement on, as one fix.
    const fromServer = publicationReadiness(draft, ['APP_BUILD_REQUIRES_CERTIFIED: This project requires every tile to be certified before an App is published. Not certified yet: orders-kpi.']);
    expect(fromServer.requireCertified).toBe(true);
    expect(fromServer.serverIssues).toEqual([]);
    expect(fromServer.fixCount).toBe(1);
  });

  it('says what to do in plain words, with the server\'s own words under Technical details', () => {
    const [unknown] = publicationIssueSummaries(['overview/margin has a Dataset field selection that is not fully covered by its approved contract.']);
    expect(unknown).toMatchObject({ title: 'Run the page once to check it', action: 'preview', technical: expect.stringContaining('overview/margin') });
    expect(unknown!.detail).not.toContain('overview/margin');
    expect(JSON.stringify(publicationIssueSummaries(['Dataset tile x is currently review and is not eligible.', 'overview/y something odd']))).not.toContain('Complete governed validation');
    expect(plainReviewTaskMessage('Orders is review and must be certified, replaced, or removed before Project publication.'))
      .toBe('Orders is not certified yet: certify it, replace it, or remove the tiles that use it.');
    expect(plainReviewTaskMessage('Validate revenue grain.')).toBe('Validate revenue grain.');
  });

  it('a tile on a join nobody certified is listed with its join action, never a fix, and never "every check passed" (T3)', () => {
    for (const sourcePolicy of [undefined, 'governed_only', 'include_review_required'] as const) {
      const readiness = publicationReadiness({ ...joinedDraftFixture(), ...(sourcePolicy ? { sourcePolicy } : {}) });
      expect(readiness.reviewTiles).toHaveLength(1);
      expect(readiness.notCertified.map((tile) => [tile.tileId, tile.action.kind, tile.detail])).toEqual([['by_location', 'join', 'Uses a join nobody has certified.']]);
      expect(readiness.fixCount).toBe(0);
      expect(readiness.ready).toBe(true);
      expect(readiness.trust.label).toBe('1 of 2 tiles certified');
      expect(readiness.trust.notCertified).toBe(1);
      expect(publishReadyLine(readiness.trust)).toEqual({ detail: '1 of 2 tiles certified', allPassed: false });
      expect(readersWillSeeText(readiness.trust.notCertified)).toBe('Readers will see \u2018Not certified yet\u2019 on 1 tile.');
    }
    // An old server's tile check adds nothing.
    expect(publicationReadiness(joinedDraftFixture(), ['APP_BUILD_TILE_NEEDS_REVIEW: overview/by_location: Revenue by location uses the join to Location, which is not certified yet.']).fixCount).toBe(0);
  });

  it('the editor\'s tile trust is the publish check\'s answer', () => {
    const draft = joinedDraftFixture();
    const trust = draftTrust(draft);
    expect(trust.tiles.map((tile) => [tile.tileId, tile.trust.state])).toEqual([['by_location', 'review'], ['total', 'certified']]);
    expect(publicationTilesNeedingReview(draft).map((item) => item.tileId)).toEqual(trust.tiles.filter((tile) => tile.trust.state === 'review').map((tile) => tile.tileId));
  });
});

/** A certified Orders Dataset that reaches Location through a join drafted in setup (not certified). */
function joinedDraftFixture(joinTrust: 'certified' | 'review_required' = 'review_required'): AppStudioBuildDraft {
  const draft = draftFixture();
  const sourceId = 'app:block:commerce:orders';
  draft.requirements = [];
  draft.coverage = [];
  draft.reviewTasks = [];
  draft.sources = [{
    id: sourceId,
    kind: 'block',
    sourceRef: 'orders',
    lifecycle: 'certified',
    trustState: 'certified',
    reviewStatus: 'not_required',
    capabilities: {
      dataset: {
        kind: 'block',
        trust: 'certified',
        fields: [
          { kind: 'physical', name: 'order_id', qualifiedId: 'o:order_id', type: 'string', role: 'key', status: 'approved' },
          { kind: 'physical', name: 'location__location_name', qualifiedId: 'o:location__location_name', type: 'string', role: 'dimension', status: 'approved', related: { join: 'location', column: 'location_name' } },
        ],
        joins: [{
          id: 'location', label: 'Location', table: 'locations', relation: 'main.locations',
          keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'many_to_one', trust: joinTrust,
          origin: 'drafted', relationshipId: 'proposal_setup:rel_2', uniqueness: 'current', sentence: 'each order has one location',
        }],
      } as never,
    } as never,
  }];
  draft.pages = [{
    version: 3,
    id: 'overview',
    metadata: { title: 'Overview' },
    datasets: [{ id: 'orders_ds', sourceId, sourceRevision: 'sha256:orders', snapshotId: 's', contractFingerprint: 'c' }],
    layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
      {
        i: 'by_location', x: 0, y: 0, w: 6, h: 4, title: 'Revenue by location', sourceId, sourceRevision: 'sha256:orders',
        query: { dimensions: [{ field: 'location__location_name' }], measures: [{ measure: 'revenue' }], orderBy: [{ alias: 'revenue', direction: 'desc' }], respectsGlobalFilters: true },
        viz: { type: 'bar', encoding: { columns: [{ dimension: 'location__location_name' }], rows: [{ measure: 'revenue' }] } as never },
      },
      { i: 'total', x: 6, y: 0, w: 3, h: 2, title: 'Revenue', sourceId, sourceRevision: 'sha256:orders', query: { dimensions: [], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true }, viz: { type: 'single_value' } },
    ] },
  }] as never;
  draft.previewReceipts = [{ id: 'run-1', pageId: 'overview', revision: draft.revision, snapshotId: 's', filterFingerprint: 'f', resultFingerprint: 'r', createdAt: draft.updatedAt }];
  return draft;
}

describe('tiles on a join nobody certified in the publish check (design D2, T3)', () => {
  it('lists a tile that reads a field through a join nobody certified, without blocking', () => {
    const draft = joinedDraftFixture();
    expect(publicationBlockingSources(draft)).toEqual([]);
    const tiles = publicationTilesNeedingReview(draft);
    expect(tiles.map((item) => [item.pageId, item.tileId, item.relatedFields])).toEqual([['overview', 'by_location', ['location__location_name']]]);
    expect(localPublicationSteps(draft)).toEqual([]);
    expect(publicationBlockerCount(draft)).toBe(0);
    expect(publicationBlockerCount(draft, [], {}, { requireCertifiedToPublish: true })).toBe(1);
  });

  it('the tile is certified once the join is certified', () => {
    expect(publicationTilesNeedingReview(joinedDraftFixture('certified'))).toEqual([]);
    expect(notCertifiedPublicationTiles(joinedDraftFixture('certified'), draftTrust(joinedDraftFixture('certified')))).toEqual([]);
    // A settled run is the current evidence: the join was certified since the source was saved.
    const draft = joinedDraftFixture();
    const run = { tiles: [{ tileId: 'by_location', status: 'ok', dataset: { joins: [{ id: 'location', table: 'locations', trust: 'certified', sentence: '' }] } }] } as unknown as DashboardRunResponse;
    expect(publicationTilesNeedingReview(draft, { overview: run })).toEqual([]);
    const stillDrafted = { tiles: [{ tileId: 'by_location', status: 'ok', dataset: { joins: [{ id: 'location', table: 'locations', trust: 'review_required', sentence: '' }] } }] } as unknown as DashboardRunResponse;
    expect(publicationTilesNeedingReview(draft, { overview: stillDrafted })).toHaveLength(1);
  });

  it('removes the related field from the tile: query, sort and chart shelves', () => {
    const tile = joinedDraftFixture().pages[0]!.layout.items[0]!;
    const patch = tilePatchWithoutRelatedFields(tile, ['location__location_name'])!;
    expect(patch.query).toMatchObject({ dimensions: [], measures: [{ measure: 'revenue' }], orderBy: [{ alias: 'revenue', direction: 'desc' }] });
    expect(JSON.stringify(patch.viz?.encoding)).not.toContain('location__location_name');
    expect(patch.viz?.type).toBe('single_value');
    const after = joinedDraftFixture();
    after.pages[0]!.layout.items[0] = { ...tile, ...patch };
    expect(publicationTilesNeedingReview(after)).toEqual([]);
  });

  it('leaves the tile checks to the not-certified list: neither an old server message nor the require-certified one is a separate row', () => {
    expect(publicationIssueSummaries([
      'APP_BUILD_TILE_NEEDS_REVIEW: overview/by_location: Revenue by location uses the join to Location, which is not certified yet.',
      'APP_BUILD_REQUIRES_CERTIFIED: This project requires every tile to be certified before an App is published. Not certified yet: Revenue by location.',
    ])).toEqual([]);
  });
});
