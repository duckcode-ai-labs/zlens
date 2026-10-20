import type { AppBlockRecommendation, AppStudioAiProposal, AppStudioBuildDraft } from '../../../api/client';

/** Catalog rows and drafts shared by the App data tests. */

const base = {
  owner: 'analytics@example.com', tags: [], fingerprint: 'sha256:rev', lastModified: '', score: 1, reasons: [],
};

export const orderLinesDataset = {
  ...base,
  id: 'app:block:commerce/order-lines', sourceId: 'app:block:commerce/order-lines', kind: 'block',
  name: 'order_lines', domain: 'commerce', status: 'certified', lifecycle: 'certified', trust: 'certified',
  path: 'blocks/commerce/order-lines.dql', sourcePath: 'blocks/commerce/order-lines.dql', sourceRevision: 'sha256:rev',
  snapshotId: 'snap-1', qualifiedIdentity: 'commerce/order-lines',
  description: 'One row per order line.',
  eligibility: { discoverable: true, localPreview: true, projectPublish: true, reasonCodes: [] },
  capabilities: {
    measures: ['revenue'], dimensions: ['region'], outputs: ['region', 'revenue'], filters: [], parameters: [],
    dataset: {
      id: 'dataset.order-lines', kind: 'block', label: 'Order lines', operations: ['group', 'detail'],
      grain: { entityIds: ['order_line'], keyFields: ['order_line_id'] },
      fields: [
        { name: 'revenue', kind: 'measure', status: 'approved', aggregation: 'sum', dependsOn: ['net_amount'] },
        { name: 'order_line_id', qualifiedId: 'order_line_id', kind: 'physical', status: 'approved', role: 'key', type: 'string' },
        { name: 'region', qualifiedId: 'region', kind: 'physical', status: 'approved', role: 'dimension', type: 'string' },
        { name: 'ordered_at', qualifiedId: 'ordered_at', kind: 'physical', status: 'approved', role: 'time', type: 'date' },
      ],
    },
  },
} as unknown as AppBlockRecommendation;

export const marginMetrics = {
  ...base,
  id: 'app:semantic:finance:margin', sourceId: 'app:semantic:finance:margin', kind: 'semantic',
  name: 'margin', domain: 'finance', status: 'certified', lifecycle: 'certified', trust: 'certified',
  path: 'semantic/margin.yml', description: 'Gross margin metrics.',
  capabilities: {
    measures: ['gross_margin'], dimensions: [], outputs: [], filters: [], parameters: [],
    dataset: { id: 'dataset.margin', kind: 'semantic', label: 'Margin', operations: ['group'], fields: [] },
  },
} as unknown as AppBlockRecommendation;

export const topCustomersQuery = {
  ...base,
  id: 'app:block:orders/top_customers', sourceId: 'app:block:orders/top_customers', kind: 'block',
  name: 'top_customers', domain: 'orders', status: 'certified', lifecycle: 'certified', trust: 'certified',
  path: 'blocks/top_customers.dql', description: 'Top 10 customers by lifetime spend.',
  capabilities: { measures: [], dimensions: ['customer'], outputs: ['customer_name', 'lifetime_spend'], filters: [], parameters: [] },
} as unknown as AppBlockRecommendation;

export const draftRevenueQuery = {
  ...base,
  id: 'app:block:growth/draft-revenue', sourceId: 'app:block:growth/draft-revenue', kind: 'block',
  name: 'draft_revenue', domain: 'growth', status: 'draft', lifecycle: 'draft', trust: 'review_required',
  path: 'blocks/growth/draft-revenue.dql', description: 'Unreviewed revenue logic.',
  eligibility: { discoverable: true, localPreview: false, projectPublish: false, reasonCodes: ['REVIEW_POLICY'] },
  capabilities: { measures: [], dimensions: [], outputs: ['revenue'], filters: [], parameters: [] },
} as unknown as AppBlockRecommendation;

type Draft = AppStudioBuildDraft;

export function draftWith(input: {
  sources?: Draft['sources'];
  items?: Draft['pages'][number]['layout']['items'];
  sourcePolicy?: Draft['sourcePolicy'];
  reviewTasks?: Draft['reviewTasks'];
} = {}): Draft {
  return {
    version: 3, id: 'build_1', appId: 'revenue-app', name: 'Revenue App', revision: 3, proposalHash: 'hash',
    authoringMode: 'manual', template: 'blank', sourcePolicy: input.sourcePolicy ?? 'governed_only', state: 'local_draft',
    frame: { goal: 'Revenue', metrics: [], dimensions: [], filters: [] },
    requirements: [], coverage: [], sources: input.sources ?? [],
    pages: [{
      version: 2, id: 'overview',
      metadata: { title: 'Overview', domain: 'commerce' },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: input.items ?? [] },
    }],
    reviewTasks: input.reviewTasks ?? [],
    createdAt: '', updatedAt: '',
  } as unknown as Draft;
}

/**
 * An AI proposal as the server returns it: two picked sources (a Dataset and
 * Metrics), one tile each with the planner's reason on `sourceEvidence`, a
 * planner note, one uncovered requirement and, optionally, a question.
 */
export function aiProposal(input: { clarify?: boolean } = {}): AppStudioAiProposal {
  const orders = appDataSourceFromCandidateForFixture(orderLinesDataset);
  const margin = appDataSourceFromCandidateForFixture(marginMetrics);
  return {
    id: 'proposal-1', draftId: 'build_1', baseRevision: 3, baseProposalHash: 'hash',
    plannerProvenance: { version: 1, mode: 'deterministic', providerInvocation: 'not_attempted' },
    mode: 'replace', targetPageId: 'overview',
    proposedTileIds: ['revenue-trend', 'margin-kpi'],
    defaultSelectedSourceIds: [orders.id, margin.id],
    warnings: ['Revenue by channel was not added because no Dataset has a channel field.'],
    clarifications: input.clarify ? [{
      id: 'period', question: 'Which period should the App open on?', required: true,
      choices: [{ id: 'week', label: 'Last week' }, { id: 'month', label: 'Last month', description: 'Calendar month' }],
    }] : [],
    summary: { requirements: 2, covered: 1, gaps: 1, certifiedSources: 2, semanticSources: 1 },
    operations: [
      { type: 'set_frame', frame: { goal: 'Weekly revenue health for finance', metrics: [], dimensions: [], filters: [] } },
      {
        type: 'set_requirements',
        requirements: [
          { id: 'trend', question: 'How is revenue trending?', role: 'trend', required: true, measures: [], dimensions: [], filters: [] },
          { id: 'channel', question: 'Which channel drives revenue?', role: 'driver', required: true, measures: [], dimensions: [], filters: [] },
        ],
        coverage: [
          { requirementId: 'trend', status: 'covered', sourceIds: [orders.id], componentIds: ['revenue-trend'], reasons: [] },
          { requirementId: 'channel', status: 'gap', sourceIds: [], componentIds: [], reasons: ['No channel field'] },
        ],
      },
      { type: 'upsert_source', source: orders },
      { type: 'upsert_source', source: margin },
      {
        type: 'upsert_page',
        page: {
          version: 2, id: 'overview', metadata: { title: 'Overview', visibility: 'private', lifecycle: 'draft' },
          layout: {
            kind: 'grid', cols: 12, rowHeight: 80, items: [
              {
                i: 'revenue-trend', x: 0, y: 0, w: 8, h: 4, title: 'Revenue trend', viz: { type: 'line' }, sourceId: orders.id,
                query: { dimensions: [], measures: [{ measure: 'revenue' }] },
                sourceEvidence: [{ source: orders.id, reason: 'Order lines carries revenue by order date.', kind: 'block', trustState: 'certified' }],
              },
              {
                i: 'margin-kpi', x: 8, y: 0, w: 4, h: 4, title: 'Gross margin', viz: { type: 'single_value' }, sourceId: margin.id,
                query: { dimensions: [], measures: [{ measure: 'gross_margin' }] },
                sourceEvidence: [{ source: margin.id, reason: 'Margin metrics answer profitability.', kind: 'semantic', trustState: 'certified' }],
              },
            ],
          },
        },
      },
    ],
  } as unknown as AppStudioAiProposal;
}

function appDataSourceFromCandidateForFixture(candidate: AppBlockRecommendation): Draft['sources'][number] {
  return {
    id: candidate.sourceId ?? candidate.id,
    kind: candidate.kind === 'semantic' ? 'governed_semantic' : 'block',
    sourceRef: candidate.path,
    qualifiedIdentity: candidate.name,
    ...(candidate.capabilities ? { capabilities: candidate.capabilities } : {}),
    trustState: 'certified',
    reviewStatus: 'not_required',
  } as Draft['sources'][number];
}
