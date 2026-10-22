import { describe, expect, it } from 'vitest';
import { appBuildPreviewIntentFingerprint, appNameFromGoal, applyAppBuildDraftOperations, createAppBuildDraft, packDashboardLayoutItems } from './app-build-draft.js';
import { parseDashboardDocument } from './dashboard-document.js';

describe('AppBuildDraft', () => {
  it('uses one revisioned contract for manual and AI authoring', () => {
    const draft = createAppBuildDraft({
      id: 'build-1', appId: 'revenue-app', authoringMode: 'manual', now: '2026-08-08T00:00:00.000Z',
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: [], filters: [] },
    });
    // A new App has no per-App data rule (T3), and an older client's change to one is ignored.
    expect(draft).not.toHaveProperty('sourcePolicy');
    const next = applyAppBuildDraftOperations(draft, 1, [
      { type: 'set_source_policy', sourcePolicy: 'include_review_required' },
      { type: 'set_name', name: 'Revenue' },
    ], '2026-08-08T00:01:00.000Z');
    expect(next.version).toBe(3);
    expect(next.state).toBe('local_draft');
    expect(next.revision).toBe(2);
    expect(next).not.toHaveProperty('sourcePolicy');
    expect(next.proposalHash).not.toBe(draft.proposalHash);
  });

  it('rejects stale mutations', () => {
    const draft = createAppBuildDraft({
      id: 'build-1', appId: 'revenue-app', authoringMode: 'ai',
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: [], filters: [] },
    });
    expect(() => applyAppBuildDraftOperations(draft, 0, [])).toThrow(/APP_BUILD_REVISION_CONFLICT/);
  });

  it('keeps an old draft readable with its stored data rule, and needs no rule for data nobody certified (T3)', () => {
    const old = createAppBuildDraft({
      id: 'build-old', appId: 'revenue-app', authoringMode: 'manual', sourcePolicy: 'governed_only',
      frame: { goal: 'Investigate revenue', metrics: ['revenue'], dimensions: [], filters: [] },
    });
    expect(old).not.toHaveProperty('sourcePolicy');
    const stored = { ...old, sourcePolicy: 'governed_only' as const };
    expect(applyAppBuildDraftOperations(stored, 1, [{ type: 'set_name', name: 'Old' }]).sourcePolicy).toBe('governed_only');
    expect(() => createAppBuildDraft({
      id: 'build-1', appId: 'revenue-app', authoringMode: 'manual',
      frame: { goal: 'Investigate revenue', metrics: ['revenue'], dimensions: [], filters: [] },
      sources: [{
        id: 'draft-1', kind: 'exploratory_sql', sourceRef: 'drafts/revenue.dql',
        trustState: 'review_required', reviewStatus: 'required',
      }],
    })).not.toThrow();
  });

  it('invalidates preview and preflight receipts after a content edit', () => {
    const draft = createAppBuildDraft({
      id: 'build-4', appId: 'revenue-app', authoringMode: 'manual',
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: [], filters: [] },
    });
    const withReceipt = {
      ...draft,
      previewReceipt: {
        id: 'run-1', pageId: 'overview', revision: 1, snapshotId: 'snapshot-1', filterFingerprint: 'filter-1',
        resultFingerprint: 'result-1', createdAt: '2026-08-08T00:00:00.000Z',
      },
      preflightReceipt: {
        id: 'preflight-1', revision: 1, proposalHash: draft.proposalHash,
        sourceFingerprint: 'sources-1', createdAt: '2026-08-08T00:00:00.000Z',
      },
    };
    const next = applyAppBuildDraftOperations(withReceipt, 1, [{ type: 'set_name', name: 'Revenue health' }]);
    expect(next.name).toBe('Revenue health');
    expect(next.previewReceipt).toBeUndefined();
    expect(next.preflightReceipt).toBeUndefined();
  });

  it('binds a preview to the executable page, source revisions, parameters, and interactions', () => {
    const source = {
      id: 'source-a', kind: 'certified_block' as const, sourceRef: 'blocks/commerce/orders.dql',
      sourceRevision: 'sha256:source-a', sourceFingerprint: 'sha256:source-a',
      trustState: 'certified' as const, reviewStatus: 'not_required' as const,
    };
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      filters: [{ id: 'region', type: 'select' as const, bindsTo: 'region' }],
      interactions: { crossFilter: { mappings: [{ fromTileId: 'revenue', fromField: 'region', toTileId: 'orders', toField: 'region' }] } },
      layout: {
        kind: 'grid' as const, cols: 12, rowHeight: 80,
        items: [
          { i: 'revenue', x: 0, y: 0, w: 6, h: 4, sourceId: 'source-a', sourceRevision: 'sha256:source-a', block: { blockId: 'revenue' }, viz: { type: 'kpi' as const }, parameterBindings: [{ parameter: 'region', source: 'filter', filter: 'region' }] },
          { i: 'orders', x: 6, y: 0, w: 6, h: 4, sourceId: 'source-a', sourceRevision: 'sha256:source-a', block: { blockId: 'orders' }, viz: { type: 'kpi' as const } },
        ],
      },
    };
    const draft = createAppBuildDraft({
      id: 'intent-draft', appId: 'intent-app', authoringMode: 'manual', pages: [page], sources: [source],
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: ['region'], filters: ['region'] },
    });
    const baseline = appBuildPreviewIntentFingerprint(draft, 'overview');
    const changedQuery = {
      ...draft,
      pages: [{ ...page, layout: { ...page.layout, items: page.layout.items.map((tile) => tile.i === 'revenue' ? { ...tile, query: { dimensions: [], measures: [{ measure: 'margin' }] } } : tile) } }],
    };
    const changedSource = { ...draft, sources: [{ ...source, sourceRevision: 'sha256:source-b' }] };
    const changedInteraction = { ...draft, pages: [{ ...page, interactions: { navigate: [{ fromTile: 'revenue', toPage: 'detail', carryFilters: ['region'] }] } }] };
    expect(appBuildPreviewIntentFingerprint(changedQuery, 'overview')).not.toBe(baseline);
    expect(appBuildPreviewIntentFingerprint(changedSource, 'overview')).not.toBe(baseline);
    expect(appBuildPreviewIntentFingerprint(changedInteraction, 'overview')).not.toBe(baseline);
  });

  it('records page-specific settled runs without changing the content revision', () => {
    const draft = createAppBuildDraft({
      id: 'build-5', appId: 'operations-app', authoringMode: 'manual',
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: [] },
    });
    const first = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'set_preview_receipt',
      receipt: { id: 'run-overview', pageId: 'overview', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f1', resultFingerprint: 'r1', createdAt: '2026-08-08T00:00:00.000Z' },
    }]);
    const second = applyAppBuildDraftOperations(first, first.revision, [{
      type: 'set_preview_receipt',
      receipt: { id: 'run-detail', pageId: 'detail', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f2', resultFingerprint: 'r2', createdAt: '2026-08-08T00:01:00.000Z' },
    }]);
    expect(second.revision).toBe(draft.revision);
    expect(second.proposalHash).toBe(draft.proposalHash);
    expect(second.previewReceipts?.map((receipt) => receipt.pageId)).toEqual(['overview', 'detail']);
  });

  it('invalidates only the receipt observed by a current incomplete page run', () => {
    const draft = createAppBuildDraft({
      id: 'build-incomplete-page', appId: 'operations-app', authoringMode: 'manual',
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: [] },
    });
    const withReceipts = applyAppBuildDraftOperations(draft, draft.revision, [
      {
        type: 'set_preview_receipt',
        receipt: { id: 'run-overview-old', pageId: 'overview', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f1', resultFingerprint: 'r1', createdAt: '2026-09-11T00:00:00.000Z' },
      },
      {
        type: 'set_preview_receipt',
        receipt: { id: 'run-detail-current', pageId: 'detail', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f2', resultFingerprint: 'r2', createdAt: '2026-09-11T00:01:00.000Z' },
      },
    ]);
    const cleared = applyAppBuildDraftOperations(withReceipts, withReceipts.revision, [{
      type: 'clear_preview_receipt', pageId: 'overview', expectedReceiptId: 'run-overview-old',
    }]);

    expect(cleared.revision).toBe(withReceipts.revision);
    expect(cleared.previewReceipts).toEqual([expect.objectContaining({ id: 'run-detail-current', pageId: 'detail' })]);
    expect(cleared.previewReceipt).toMatchObject({ id: 'run-detail-current', pageId: 'detail' });
    expect(() => applyAppBuildDraftOperations(withReceipts, withReceipts.revision, [{
      type: 'clear_preview_receipt', pageId: 'overview', expectedReceiptId: 'run-overview-newer',
    }])).toThrow(/APP_BUILD_PREVIEW_RECEIPT_CONFLICT/);
  });

  it('preserves a settled page result when only layout geometry changes (API-013, UI-022)', () => {
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid' as const,
        cols: 12,
        rowHeight: 80,
        items: [
          { i: 'revenue', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' as const } },
          { i: 'orders', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'monthly_orders' }, viz: { type: 'bar' as const } },
        ],
      },
    };
    const draft = createAppBuildDraft({
      id: 'build-layout-receipt', appId: 'operations-app', authoringMode: 'manual', pages: [page],
      frame: { goal: 'Monitor operations', metrics: ['revenue'], dimensions: ['month'], filters: [] },
    });
    const withReceipt = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'set_preview_receipt',
      receipt: { id: 'run-1', pageId: 'overview', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f1', resultFingerprint: 'r1', createdAt: '2026-08-08T00:00:00.000Z' },
    }]);
    const arranged = applyAppBuildDraftOperations(withReceipt, withReceipt.revision, [{
      type: 'set_layout',
      pageId: 'overview',
      layout: {
        ...page.layout,
        items: [
          { ...page.layout.items[1], x: 0, y: 0 },
          { ...page.layout.items[0], x: 6, y: 0 },
        ],
      },
    }]);

    expect(arranged.revision).toBe(withReceipt.revision + 1);
    expect(arranged.previewReceipts?.[0]).toMatchObject({ id: 'run-1', pageId: 'overview', revision: arranged.revision });
    expect(arranged.previewReceipt).toMatchObject({ id: 'run-1', revision: arranged.revision });
    expect(arranged.preflightReceipt).toBeUndefined();
  });

  it('invalidates settled results when a filter contract changes (API-013)', () => {
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: { kind: 'grid' as const, cols: 12, rowHeight: 80, items: [] },
    };
    const draft = createAppBuildDraft({
      id: 'build-filter-receipt', appId: 'operations-app', authoringMode: 'manual', pages: [page],
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: [] },
    });
    const withReceipt = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'set_preview_receipt',
      receipt: { id: 'run-1', pageId: 'overview', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f1', resultFingerprint: 'r1', createdAt: '2026-08-08T00:00:00.000Z' },
    }]);
    const filtered = applyAppBuildDraftOperations(withReceipt, withReceipt.revision, [{
      type: 'set_filter', pageId: 'overview', filter: { id: 'order_date', type: 'daterange', bindsTo: 'order_date' },
    }]);

    expect(filtered.previewReceipts).toBeUndefined();
    expect(filtered.previewReceipt).toBeUndefined();
  });

  it('keeps one server-owned App filter definition while preserving page-qualified Dataset bindings', () => {
    const appFilter = {
      id: 'region', type: 'select' as const, label: 'Region', bindsTo: 'region', field: { name: 'region' }, scope: { app: true },
    };
    const page = (id: string, filter = appFilter) => ({
      version: 3 as const,
      id,
      metadata: { title: id },
      filters: [filter],
      layout: { kind: 'grid' as const, cols: 12, rowHeight: 80, items: [] },
    });
    const draft = createAppBuildDraft({
      id: 'build-app-filter', appId: 'operations-app', authoringMode: 'manual',
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: ['region'] },
      // Distinct bindings may legitimately vary by page; the logical control
      // stays identical and its exact Dataset field reach remains page-owned.
      pages: [
        { ...page('overview'), filters: [{ ...appFilter, datasetBindings: { orders: { field: 'region', tileIds: ['revenue'] } } }] },
        { ...page('detail'), filters: [{ ...appFilter, datasetBindings: { orders: { field: 'region', tileIds: [] } } }] },
      ],
    });
    expect(draft.pages).toHaveLength(2);

    expect(() => createAppBuildDraft({
      id: 'build-conflicting-app-filter', appId: 'operations-app', authoringMode: 'manual',
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: ['region'] },
      pages: [page('overview'), page('detail', { ...appFilter, type: 'multiselect' as const })],
    })).toThrow(/conflicting definitions/);

    expect(() => createAppBuildDraft({
      id: 'build-shadowed-app-filter', appId: 'operations-app', authoringMode: 'manual',
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: ['region'] },
      pages: [page('overview'), page('detail', { id: 'region', type: 'select' as const, bindsTo: 'region', scope: { page: 'detail' } })],
    })).toThrow(/cannot be shadowed/);
  });

  it('inherits an App Dataset control for a new page and rejects an omitted v3 control', () => {
    const appFilter = {
      id: 'region', type: 'select' as const, label: 'Region', bindsTo: 'region', field: { name: 'region' }, scope: { app: true },
      datasetBindings: { orders: { field: 'region', tileIds: ['revenue'] } },
    };
    const overview = {
      version: 3 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      filters: [appFilter],
      layout: { kind: 'grid' as const, cols: 12, rowHeight: 80, items: [] },
    };
    const legacy = {
      version: 2 as const,
      id: 'legacy',
      metadata: { title: 'Legacy' },
      layout: { kind: 'grid' as const, cols: 12, rowHeight: 80, items: [] },
    };
    const draft = createAppBuildDraft({
      id: 'build-new-page-filter', appId: 'operations-app', authoringMode: 'manual', pages: [overview, legacy],
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: ['region'] },
    });
    const created = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'upsert_page',
      page: {
        version: 2,
        id: 'new-page',
        metadata: { title: 'New page' },
        // A real page-local control is retained; only the same-id app
        // control is supplied by the server-owned inheritance step.
        filters: [{ id: 'local-note', type: 'select', scope: { page: 'new-page' } }],
        layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
      },
    }]);
    const newPage = created.pages.find((page) => page.id === 'new-page');
    expect(newPage).toMatchObject({
      version: 3,
      filters: expect.arrayContaining([
        expect.objectContaining({ id: 'region', scope: { app: true }, datasetBindings: {} }),
        expect.objectContaining({ id: 'local-note', scope: { page: 'new-page' } }),
      ]),
    });
    // Existing legacy pages remain readable until an explicit Dataset edit.
    expect(created.pages.find((page) => page.id === 'legacy')?.filters).toBeUndefined();

    expect(() => applyAppBuildDraftOperations(created, created.revision, [{
      type: 'upsert_page',
      page: { ...newPage!, filters: newPage!.filters?.filter((filter) => filter.id !== 'region') },
    }])).toThrow(/App-scoped filter region is missing from v3 page new-page/);
  });

  it('retains an explicitly empty App Dataset binding when a new page is persisted', () => {
    const draft = createAppBuildDraft({
      id: 'build-empty-app-filter', appId: 'operations-app', authoringMode: 'manual',
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: ['region'] },
      pages: [{
        version: 3,
        id: 'overview',
        metadata: { title: 'Overview' },
        filters: [{
          id: 'region', type: 'select', field: { name: 'region' }, scope: { app: true }, datasetBindings: {},
        }],
        layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
      }],
    });
    const created = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'upsert_page',
      page: {
        version: 2,
        id: 'new-page',
        metadata: { title: 'New page' },
        layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
      },
    }]);
    const page = created.pages.find((candidate) => candidate.id === 'new-page');
    expect(page).toMatchObject({
      version: 3,
      filters: [expect.objectContaining({ id: 'region', scope: { app: true }, datasetBindings: {} })],
    });
    expect(parseDashboardDocument(JSON.stringify(page)).document?.filters?.[0]?.datasetBindings).toEqual({});
  });

  it('persists a declared interaction as a content change and invalidates its prior preview', () => {
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: { kind: 'grid' as const, cols: 12, rowHeight: 80, items: [] },
    };
    const draft = createAppBuildDraft({
      id: 'build-interaction-receipt', appId: 'operations-app', authoringMode: 'manual', pages: [page],
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: [] },
    });
    const withReceipt = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'set_preview_receipt',
      receipt: { id: 'run-1', pageId: 'overview', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f1', resultFingerprint: 'r1', createdAt: '2026-08-08T00:00:00.000Z' },
    }]);
    const next = applyAppBuildDraftOperations(withReceipt, withReceipt.revision, [{
      type: 'set_interactions', pageId: 'overview', interactions: {
        navigate: [{ fromTile: 'revenue-trend', toPage: 'detail', carryFilters: ['order_date'] }],
      },
    }]);

    expect(next.pages[0].interactions?.navigate).toEqual([
      { fromTile: 'revenue-trend', toPage: 'detail', carryFilters: ['order_date'] },
    ]);
    expect(next.previewReceipts).toBeUndefined();
    expect(next.previewReceipt).toBeUndefined();
  });

  it('keeps AI drafts in clarification state until required choices are answered', () => {
    const draft = createAppBuildDraft({
      id: 'build-5', appId: 'revenue-app', authoringMode: 'ai',
      frame: {
        goal: 'Build a revenue app', metrics: [], dimensions: [], filters: [],
        clarificationQuestions: [{
          id: 'metric', question: 'Which metric?', required: true,
          choices: [{ id: 'gross-revenue', label: 'Gross revenue' }],
        }],
      },
    });
    expect(draft.state).toBe('clarification_required');
    const next = applyAppBuildDraftOperations(draft, 1, [{
      type: 'set_frame',
      frame: {
        ...draft.frame,
        metrics: ['gross_revenue'],
        clarificationQuestions: [{
          ...draft.frame.clarificationQuestions![0],
          answerId: 'gross-revenue',
        }],
      },
    }]);
    expect(next.state).toBe('local_draft');
  });

  it('reconciles coverage when a source-bound tile is removed', () => {
    const source = {
      id: 'app:block:sales:revenue',
      kind: 'block' as const,
      sourceRef: 'blocks/sales/revenue.dql',
      sourceRevision: 'sha256:revenue',
      sourceFingerprint: 'sha256:revenue',
      lifecycle: 'certified' as const,
      trustState: 'certified' as const,
      reviewStatus: 'not_required' as const,
    };
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid' as const,
        cols: 12,
        rowHeight: 80,
        items: [{
          i: 'revenue-trend', x: 0, y: 0, w: 6, h: 4,
          sourceId: source.id, sourceRevision: source.sourceRevision,
          block: { ref: source.sourceRef }, viz: { type: 'line' as const },
        }],
      },
    };
    const draft = createAppBuildDraft({
      id: 'build-coverage', appId: 'sales-app', authoringMode: 'ai', sources: [source], pages: [page],
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: [], filters: [] },
      requirements: [{ id: 'revenue', question: 'Revenue trend', role: 'trend', required: true, measures: ['revenue'], dimensions: [], filters: [] }],
      coverage: [{ requirementId: 'revenue', status: 'covered', sourceIds: [source.id], componentIds: ['revenue-trend'], reasons: ['Covered.'] }],
    });

    const withoutTile = applyAppBuildDraftOperations(draft, draft.revision, [
      { type: 'remove_tile', pageId: 'overview', tileId: 'revenue-trend' },
    ]);
    expect(withoutTile.coverage).toEqual([
      expect.objectContaining({ requirementId: 'revenue', status: 'gap', sourceIds: [source.id], componentIds: [] }),
    ]);
    const withoutSource = applyAppBuildDraftOperations(withoutTile, withoutTile.revision, [
      { type: 'remove_source', sourceId: source.id },
    ]);
    expect(withoutSource.coverage).toEqual([
      expect.objectContaining({ requirementId: 'revenue', status: 'gap', sourceIds: [], componentIds: [] }),
    ]);
  });

  it('packs invalid and overlapping App Studio geometry into a stable reading order', () => {
    const packed = packDashboardLayoutItems([
      { i: 'kpi', x: 0, y: 0, w: 3, h: 2, viz: { type: 'single_value' } },
      { i: 'chart', x: 6, y: 0, w: 12, h: 4, viz: { type: 'bar' } },
      { i: 'detail', x: 0, y: 20, w: 6, h: 3, viz: { type: 'table' } },
    ], 12);

    expect(packed.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))).toEqual([
      { i: 'kpi', x: 0, y: 0, w: 3, h: 2 },
      { i: 'chart', x: 0, y: 2, w: 12, h: 4 },
      { i: 'detail', x: 0, y: 6, w: 6, h: 3 },
    ]);
  });

  it('normalizes wide, medium, and narrow layouts on the next explicit edit', () => {
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid' as const,
        cols: 12,
        rowHeight: 80,
        items: [
          { i: 'kpi', x: 0, y: 0, w: 3, h: 2, viz: { type: 'single_value' as const } },
          { i: 'chart', x: 6, y: 0, w: 12, h: 4, viz: { type: 'bar' as const } },
        ],
      },
    };
    const draft = createAppBuildDraft({
      id: 'build-layout', appId: 'layout-app', authoringMode: 'manual', pages: [page],
      frame: { goal: 'Arrange the app', metrics: [], dimensions: [], filters: [] },
    });
    const next = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'update_tile', pageId: 'overview', tileId: 'chart', patch: { title: 'Revenue trend' },
    }]);

    expect(next.pages[0].layout.items[1]).toMatchObject({ i: 'chart', x: 0, y: 2, w: 12 });
    expect(next.pages[0].layout.responsive?.medium.items[1]).toMatchObject({ i: 'chart', x: 0, y: 2, w: 6 });
    expect(next.pages[0].layout.responsive?.narrow.items[1]).toMatchObject({ i: 'chart', x: 0, y: 2, w: 1 });
  });

  it('rejects new scalar Dataset field combinations but lets a restored local draft recover to Table', () => {
    const page = {
      version: 3 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid' as const, cols: 12, rowHeight: 80,
        items: [{
          i: 'revenue', x: 0, y: 0, w: 3, h: 2,
          query: { dimensions: [], measures: [{ measure: 'revenue' }] },
          viz: { type: 'single_value' as const },
        }],
      },
    };
    const draft = createAppBuildDraft({
      id: 'build-scalar-contract', appId: 'scalar-contract', authoringMode: 'manual', pages: [page],
      frame: { goal: 'Show revenue', metrics: ['revenue'], dimensions: [], filters: [] },
    });

    expect(() => applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'update_tile', pageId: page.id, tileId: 'revenue',
      patch: { query: { dimensions: [], measures: [{ measure: 'revenue' }, { measure: 'order_count' }] } },
    }])).toThrow(/exactly one selected measure/);

    // Local drafts are intentionally read raw from SQLite so an older saved
    // selection remains openable. Its next explicit repair can retain both
    // measures by changing only the visualization to a non-lossy Table.
    const restoredMalformed = {
      ...draft,
      pages: [{
        ...page,
        layout: {
          ...page.layout,
          items: [{
            ...page.layout.items[0],
            query: { dimensions: [], measures: [{ measure: 'revenue' }, { measure: 'order_count' }] },
          }],
        },
      }],
    };
    const recovered = applyAppBuildDraftOperations(restoredMalformed, restoredMalformed.revision, [{
      type: 'update_tile', pageId: page.id, tileId: 'revenue', patch: { viz: { type: 'table' } },
    }]);
    expect(recovered.pages[0]?.layout.items[0]).toMatchObject({
      viz: { type: 'table' },
      query: { measures: [{ measure: 'revenue' }, { measure: 'order_count' }] },
    });

    expect(() => applyAppBuildDraftOperations(restoredMalformed, restoredMalformed.revision, [{
      type: 'update_tile', pageId: page.id, tileId: 'revenue', patch: { title: 'Revenue' },
    }])).toThrow(/exactly one selected measure/);
  });
});

describe('appNameFromGoal', () => {
  it('names an App from the first line of its description, at most 60 characters', () => {
    expect(appNameFromGoal('Sales manager review\nMonthly revenue, top 10 customers and total revenue.')).toBe('Sales manager review');
    expect(appNameFromGoal('\n\n  Weekly   health  \nmore')).toBe('Weekly health');
    const long = 'A weekly revenue dashboard: revenue by month, the top regions, and the latest orders. A page for a sales manager.';
    const name = appNameFromGoal(long);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name).toBe('A weekly revenue dashboard: revenue by month, the top');
    expect(appNameFromGoal('x'.repeat(80))).toHaveLength(60);
    expect(appNameFromGoal('')).toBe('');
    expect(appNameFromGoal(undefined)).toBe('');
  });

  it('is the draft name when no name was given; a given name wins', () => {
    const frame = { goal: 'Sales manager review\nwith a date filter', metrics: [], dimensions: [], filters: [] };
    expect(createAppBuildDraft({ id: 'd1', appId: 'sales', authoringMode: 'ai', frame }).name).toBe('Sales manager review');
    expect(createAppBuildDraft({ id: 'd2', appId: 'sales', name: 'Mine', authoringMode: 'ai', frame }).name).toBe('Mine');
  });
});
