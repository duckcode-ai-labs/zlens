import { describe, expect, it } from 'vitest';
import type { AppBlockRecommendation, AppStudioAiProposal } from '../../api/client';
import {
  appStudioProposalRequestSourceIds,
  appStudioProposalSourceAddMode,
  appStudioProposalRequiredSourceIds,
  appStudioPlannerProvenanceLabel,
  appStudioAiDataModel,
  appStudioAiPickedHeading,
  appStudioBuildPagesLabel,
  appStudioPickedDraftSources,
  availableAppStudioProposalSources,
  operationsForSelectedAppStudioSources,
  summarizeAppStudioAiPlan,
} from './app-studio-ai-plan';
import { aiProposal, orderLinesDataset } from './builder/app-data.fixtures';

describe('App Studio AI plan review (AGT-025, UI-022)', () => {
  it('shows the exact sources and components that typed proposal operations will apply', () => {
    const proposal = {
      id: 'proposal-1',
      draftId: 'draft-1',
      baseRevision: 0,
      baseProposalHash: 'sha256:base',
      clarifications: [],
      summary: { requirements: 2, covered: 2, gaps: 0, certifiedSources: 1, semanticSources: 1 },
      operations: [
        {
          type: 'set_frame',
          frame: {
            goal: 'Decide whether revenue growth is healthy', audience: 'Finance', metrics: ['revenue'], dimensions: ['month'], filters: [], desiredOutput: 'App',
          },
        },
        {
          type: 'upsert_source',
          source: {
            id: 'block:monthly-revenue',
            kind: 'certified_block',
            sourceRef: 'monthly_revenue',
            trustState: 'certified',
            reviewStatus: 'not_required',
          },
        },
        {
          type: 'upsert_source',
          source: {
            id: 'semantic:orders',
            kind: 'governed_semantic',
            sourceRef: 'orders',
            trustState: 'review_required',
            reviewStatus: 'required',
          },
        },
        {
          type: 'upsert_page',
          page: {
            version: 2,
            id: 'overview',
            metadata: { title: 'Revenue overview', visibility: 'private', lifecycle: 'draft' },
            layout: {
              kind: 'grid', cols: 12, rowHeight: 80,
              items: [
                { i: 'revenue-trend', x: 0, y: 0, w: 8, h: 4, title: 'Monthly revenue', viz: { type: 'line' }, block: { blockId: 'monthly-revenue' } },
                { i: 'order-detail', x: 8, y: 0, w: 4, h: 4, title: 'Order detail', viz: { type: 'table' }, semantic: { id: 'orders', metricId: 'order_count' } },
              ],
            },
          },
        },
      ],
    } as AppStudioAiProposal;

    expect(summarizeAppStudioAiPlan(proposal)).toEqual({
      frame: {
        goal: 'Decide whether revenue growth is healthy', audience: 'Finance', metrics: ['revenue'], dimensions: ['month'], filters: [], desiredOutput: 'App',
      },
      pages: [{ id: 'overview', title: 'Revenue overview' }],
      sources: [
        { id: 'block:monthly-revenue', label: 'Monthly Revenue', sourceRef: 'monthly_revenue', kind: 'certified_block', trustState: 'certified', reviewStatus: 'not_required', componentIds: ['revenue-trend'] },
        { id: 'semantic:orders', label: 'Orders', sourceRef: 'orders', kind: 'governed_semantic', trustState: 'review_required', reviewStatus: 'required', componentIds: ['order-detail'] },
      ],
      components: [
        { id: 'revenue-trend', title: 'Monthly revenue', visualization: 'Line', source: 'monthly-revenue', sourceId: 'block:monthly-revenue' },
        { id: 'order-detail', title: 'Order detail', visualization: 'Table', source: 'orders', sourceId: 'semantic:orders' },
      ],
    });
  });

  it('applies only the sources and components a user selected during review', () => {
    const proposal = {
      id: 'proposal-2', draftId: 'draft-1', baseRevision: 0, baseProposalHash: 'sha256:base', clarifications: [],
      summary: { requirements: 2, covered: 2, gaps: 0, certifiedSources: 1, semanticSources: 1 },
      operations: [
        { type: 'set_requirements', requirements: [], coverage: [
          { requirementId: 'trend', status: 'covered', sourceIds: ['block:monthly-revenue'], componentIds: ['revenue-trend'], reasons: [] },
          { requirementId: 'detail', status: 'covered', sourceIds: ['semantic:orders'], componentIds: ['order-detail'], reasons: [] },
        ] },
        { type: 'upsert_source', source: { id: 'block:monthly-revenue', kind: 'certified_block', sourceRef: 'monthly-revenue', trustState: 'certified', reviewStatus: 'not_required' } },
        { type: 'upsert_source', source: { id: 'semantic:orders', kind: 'governed_semantic', sourceRef: 'orders', trustState: 'review_required', reviewStatus: 'required' } },
        { type: 'upsert_page', page: {
          version: 2, id: 'overview', metadata: { title: 'Revenue overview', visibility: 'private', lifecycle: 'draft' },
          layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
            { i: 'intro', x: 0, y: 0, w: 12, h: 1, viz: { type: 'text' }, text: { markdown: 'Revenue health' } },
            { i: 'revenue-trend', x: 0, y: 1, w: 8, h: 4, viz: { type: 'line' }, block: { blockId: 'monthly-revenue' } },
            { i: 'order-detail', x: 8, y: 1, w: 4, h: 4, viz: { type: 'table' }, semantic: { id: 'orders', metricId: 'order_count' } },
          ], responsive: { narrow: { kind: 'grid', cols: 1, rowHeight: 80, items: [
            { i: 'intro', x: 0, y: 0, w: 1, h: 1, viz: { type: 'text' }, text: { markdown: 'Revenue health' } },
            { i: 'revenue-trend', x: 0, y: 1, w: 1, h: 4, viz: { type: 'line' }, block: { blockId: 'monthly-revenue' } },
            { i: 'order-detail', x: 0, y: 5, w: 1, h: 4, viz: { type: 'table' }, semantic: { id: 'orders', metricId: 'order_count' } },
          ] } } },
        } },
      ],
    } as AppStudioAiProposal;

    const operations = operationsForSelectedAppStudioSources(proposal, new Set(['block:monthly-revenue']));
    expect(operations.filter((operation) => operation.type === 'upsert_source')).toHaveLength(1);
    const page = operations.find((operation) => operation.type === 'upsert_page');
    expect(page?.type === 'upsert_page' ? page.page.layout.items.map((item) => item.i) : []).toEqual(['intro', 'revenue-trend']);
    expect(page?.type === 'upsert_page' ? page.page.layout.responsive?.narrow?.items.map((item) => item.i) : []).toEqual(['intro', 'revenue-trend']);
    const requirements = operations.find((operation) => operation.type === 'set_requirements');
    expect(requirements?.type === 'set_requirements' ? requirements.coverage?.[1] : undefined).toMatchObject({
      status: 'gap', sourceIds: [], componentIds: [], reasons: ['The proposed source was excluded during App review.'],
    });
  });

  it('never drops a tile that was already on the page when adding (RFC 0008 evaluation, D1)', () => {
    // An add-mode proposal carries the page's existing tiles. The existing
    // semantic tile's source is not among the proposal's selected sources, but
    // only tiles the proposal adds may be left out.
    const proposal = {
      id: 'proposal-add', draftId: 'draft-1', baseRevision: 3, baseProposalHash: 'sha256:base', clarifications: [],
      mode: 'add', proposedTileIds: ['aov', 'aov-trend'],
      summary: { requirements: 1, covered: 1, gaps: 0, certifiedSources: 1, semanticSources: 0 },
      operations: [
        { type: 'upsert_source', source: { id: 'dataset:orders', kind: 'certified_block', sourceRef: 'orders', trustState: 'certified', reviewStatus: 'not_required' } },
        { type: 'upsert_source', source: { id: 'dataset:other', kind: 'certified_block', sourceRef: 'other', trustState: 'certified', reviewStatus: 'not_required' } },
        { type: 'upsert_page', page: {
          version: 3, id: 'overview', metadata: { title: 'Overview' },
          filters: [{ id: 'region', type: 'select', label: 'Region' }, { id: 'segment', type: 'select', label: 'Segment' }],
          layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
            { i: 'semantic-totals', x: 0, y: 0, w: 6, h: 4, viz: { type: 'table' }, semantic: { id: 'commerce', metricId: 'revenue' }, filterBindings: [{ filter: 'region' }] },
            { i: 'aov', x: 0, y: 4, w: 6, h: 2, viz: { type: 'kpi' }, sourceId: 'dataset:orders', query: { measures: [{ measure: 'aov' }] } },
            { i: 'aov-trend', x: 6, y: 4, w: 6, h: 4, viz: { type: 'line' }, sourceId: 'dataset:other', query: { measures: [{ measure: 'aov' }] }, filterBindings: [{ filter: 'segment' }] },
          ] },
        } },
      ],
    } as unknown as AppStudioAiProposal;
    const operations = operationsForSelectedAppStudioSources(proposal, new Set(['dataset:orders']));
    const page = operations.find((operation) => operation.type === 'upsert_page');
    const items = page?.type === 'upsert_page' ? page.page.layout.items.map((item) => item.i) : [];
    expect(items).toEqual(['semantic-totals', 'aov']);
    // The existing tile's filter stays; the filter only the left-out new tile used goes.
    expect(page?.type === 'upsert_page' ? page.page.filters?.map((filter) => filter.id) : []).toEqual(['region']);
  });

  it('keeps additional governed source discovery in the review and excludes duplicate proposals', () => {
    const summary = {
      pages: [], components: [], frame: undefined,
      sources: [{
        id: 'block:monthly-revenue', label: 'Monthly Revenue', sourceRef: 'monthly_revenue',
        kind: 'certified_block' as const, trustState: 'certified' as const, reviewStatus: 'not_required' as const, componentIds: [],
      }],
    };
    const catalog = [
      { id: 'monthly_revenue', name: 'Monthly Revenue', domain: 'commerce', tags: ['revenue'], path: 'blocks/monthly_revenue.dql', description: 'Revenue over time' },
      { id: 'customer_profile', name: 'Customer Profile', domain: 'commerce', tags: ['customer'], path: 'blocks/customer_profile.dql', description: 'Customer detail' },
    ].map((source) => ({ ...source, status: 'certified', owner: null, fingerprint: 'sha256:test', lastModified: '', score: 1, reasons: [] })) as AppBlockRecommendation[];

    expect(availableAppStudioProposalSources(summary, catalog, '')).toHaveLength(1);
    expect(availableAppStudioProposalSources(summary, catalog, 'customer').map((source) => source.id)).toEqual(['customer_profile']);
    expect(availableAppStudioProposalSources(summary, catalog, 'revenue')).toEqual([]);
  });

  it('keeps a selected review block bound to its canonical source id', () => {
    const proposal = {
      id: 'proposal-review', draftId: 'draft-1', baseRevision: 0, baseProposalHash: 'sha256:base', clarifications: [],
      summary: { requirements: 1, covered: 1, gaps: 0, certifiedSources: 0, semanticSources: 0 },
      operations: [
        { type: 'upsert_source', source: {
          id: 'review-block:orders-by-region', kind: 'review_block', sourceRef: 'orders-by-region',
          trustState: 'review_required', reviewStatus: 'required',
        } },
        { type: 'upsert_page', page: {
          version: 2, id: 'overview', metadata: { title: 'Orders', visibility: 'private', lifecycle: 'draft' },
          layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
            { i: 'orders', x: 0, y: 0, w: 6, h: 4, viz: { type: 'bar' }, block: { blockId: 'orders-by-region' } },
          ] },
        } },
      ],
    } as AppStudioAiProposal;

    expect(summarizeAppStudioAiPlan(proposal).components[0]?.sourceId).toBe('review-block:orders-by-region');
    const operations = operationsForSelectedAppStudioSources(proposal, new Set(['review-block:orders-by-region']));
    const page = operations.find((operation) => operation.type === 'upsert_page');
    expect(page?.type === 'upsert_page' ? page.page.layout.items.map((item) => item.i) : []).toEqual(['orders']);
  });

  it('reselects removed proposal sources locally, including generated review DQL', () => {
    expect(appStudioProposalRequiredSourceIds(new Set(['source:b', 'source:a']), 'source:c'))
      .toEqual(['source:b', 'source:a', 'source:c']);
    expect(appStudioProposalRequiredSourceIds(new Set(['source:b', 'source:a'])))
      .toEqual(['source:b', 'source:a']);
    expect(appStudioProposalSourceAddMode({ alreadyProposed: true, reviewRequired: false, sourcePolicy: 'governed_only' }))
      .toBe('select_existing');
    expect(appStudioProposalSourceAddMode({ alreadyProposed: true, reviewRequired: true, sourcePolicy: 'include_review_required' }))
      .toBe('select_existing');
    expect(appStudioProposalSourceAddMode({ alreadyProposed: true, reviewRequired: true, sourcePolicy: 'governed_only' }))
      .toBe('enable_review_and_replan');
    expect(appStudioProposalSourceAddMode({ alreadyProposed: false, reviewRequired: false, sourcePolicy: 'governed_only' }))
      .toBe('replan');
  });

  it('preserves an explicit empty source selection instead of reviving a stale fallback', () => {
    expect(appStudioProposalRequestSourceIds([], 'source:stale')).toEqual([]);
    expect(appStudioProposalRequestSourceIds(undefined, 'source:current')).toEqual(['source:current']);
    expect(appStudioProposalRequestSourceIds(undefined)).toBeUndefined();
  });

  it('renders only server-issued direct planner provenance, including an honest deterministic fallback', () => {
    expect(appStudioPlannerProvenanceLabel({
      plannerProvenance: {
        version: 1,
        mode: 'ai',
        providerInvocation: 'succeeded',
        providerId: 'claude-code',
      },
    })).toBe('AI planner response · claude-code');
    expect(appStudioPlannerProvenanceLabel({
      plannerProvenance: {
        version: 1,
        mode: 'deterministic',
        providerInvocation: 'not_attempted',
      },
    })).toBe('Suggested from keywords · no AI connected');
    // A failed planner creates no proposal and therefore cannot be presented
    // as a configured-provider success or as a fallback.
    expect(appStudioPlannerProvenanceLabel({})).toBeUndefined();
  });
});

describe('AI Data step model (design D3, AI path)', () => {
  it('splits picks from removed suggestions, keeps the planner reason, and reads gaps and questions from the proposal', () => {
    const proposal = aiProposal({ clarify: true });
    const summary = summarizeAppStudioAiPlan(proposal);
    const ordersId = orderLinesDataset.sourceId!;
    const model = appStudioAiDataModel(proposal, summary, new Set([ordersId]), [orderLinesDataset]);
    expect(model.picked.map((pick) => [pick.label, pick.meta, pick.rationale, pick.tileTitles])).toEqual([
      ['Order Lines', 'Dataset · Certified · Commerce', 'Order lines carries revenue by order date.', ['Revenue trend']],
    ]);
    expect(model.suggestions.map((pick) => [pick.label, pick.meta])).toEqual([['Margin', 'Metrics · Certified']]);
    expect(model.warnings).toEqual(['Revenue by channel was not added because no Dataset has a channel field.']);
    expect(model.uncovered).toEqual([{ id: 'channel', question: 'Which channel drives revenue?' }]);
    expect(model.clarifications.map((item) => item.id)).toEqual(['period']);
    expect(appStudioPickedDraftSources(proposal, new Set([ordersId])).map((source) => source.id)).toEqual([ordersId]);
    expect(appStudioAiPickedHeading(1)).toBe('AI picked 1 source');
    expect(appStudioBuildPagesLabel(3)).toBe('Build pages with 3 sources');
  });
});

describe('AI source names', () => {
  it('reads a qualified block identity as its name', () => {
    const proposal = {
      id: 'p', draftId: 'd', baseRevision: 0, baseProposalHash: 'h', clarifications: [],
      summary: { requirements: 0, covered: 0, gaps: 0, certifiedSources: 1, semanticSources: 0 },
      operations: [{ type: 'upsert_source', source: { id: 's1', kind: 'block', sourceRef: 'blocks/top_customers.dql', qualifiedIdentity: 'orders::block::top_customers::17ade6f52b3f8d9cb9c9', trustState: 'certified', reviewStatus: 'not_required' } }],
    } as unknown as AppStudioAiProposal;
    expect(summarizeAppStudioAiPlan(proposal).sources[0]!.label).toBe('Top Customers');
  });
});
