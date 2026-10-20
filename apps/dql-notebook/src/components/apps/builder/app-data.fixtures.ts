import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../../api/client';

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
