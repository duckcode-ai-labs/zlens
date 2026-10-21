import { describe, expect, it, vi } from 'vitest';
import { deterministicDatasetQuery, planAppBuildBrief } from './app-builder-orchestrator.js';
import type { AppSourceCatalogRecord } from './app-source-catalog.js';
import { savedQueryResultDescriptor, type AppBuildRequirement, type DatasetDescriptor } from '@zlens/core';

const candidates: AppSourceCatalogRecord[] = [
  source('app:block:sales:revenue', 'Revenue trend', 'certified'),
  source('app:block:sales:orders', 'Orders by region', 'draft'),
];

describe('App Builder orchestrator', () => {
  it('AGT-026 uses one bounded provider call and rejects invented source ids', async () => {
    const complete = vi.fn(async () => ({
      content: JSON.stringify({
        frame: { goal: 'Executive sales', metrics: ['revenue'], dimensions: ['region'], filters: ['date'] },
        requirements: [{ id: 'r1', question: 'Revenue trend', role: 'trend', required: true, measures: ['revenue'], dimensions: ['date'], filters: [] }],
        components: [
          { id: 'c1', title: 'Revenue trend', sourceId: 'app:block:sales:revenue', requirementIds: ['r1'], role: 'trend', view: 'line', rationale: 'Exact capability match' },
          { id: 'invented', title: 'Invented', sourceId: 'app:block:missing', requirementIds: ['r1'], role: 'detail', view: 'table', rationale: 'Not supplied' },
        ],
      }),
      providerId: 'claude-code',
    }));

    const brief = await planAppBuildBrief({
      prompt: 'Build an executive sales App',
      candidates,
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
      complete,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(brief.planningMode).toBe('ai');
    expect(brief.plannerProvenance).toEqual({
      version: 1,
      mode: 'ai',
      providerInvocation: 'succeeded',
      providerId: 'claude-code',
    });
    expect(brief.components.map((component) => component.sourceId)).toEqual(['app:block:sales:revenue']);
    expect(complete.mock.calls[0]?.[0].user).not.toContain('SELECT');
  });

  it('surfaces malformed configured planner output while offline planning stays deterministic', async () => {
    await expect(planAppBuildBrief({
      prompt: 'Build revenue and regional orders',
      candidates,
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
      complete: async () => 'not json',
    })).rejects.toThrow('APP_BUILD_PLANNER_OUTPUT_INVALID');

    const generic = await planAppBuildBrief({
      prompt: 'Build an analytics app from my certified DQL blocks and available warehouse tables.',
      candidates,
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
    });
    expect(generic.requirements).toHaveLength(1);
    expect(generic.selectedSourceIds).toEqual(candidates.map((candidate) => candidate.sourceId));
  });

  it('surfaces configured planner failures and derives offline requirements only when no planner is configured', async () => {
    const allCandidates = [
      ...candidates,
      source('app:block:customers:growth', 'New customer growth', 'draft'),
      source('app:block:runtime:acceptance', 'Runtime parameter acceptance', 'certified'),
    ];
    await expect(planAppBuildBrief({
      prompt: 'Build an executive sales App showing revenue trend, orders by region, and new-customer growth for the last 90 days.',
      candidates: allCandidates,
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
      complete: async () => {
        throw new Error('provider unavailable');
      },
    })).rejects.toThrow('APP_BUILD_PLANNER_PROVIDER_FAILED');

    const brief = await planAppBuildBrief({
      prompt: 'Build an executive sales App showing revenue trend, orders by region, and new-customer growth for the last 90 days.',
      candidates: allCandidates,
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
    });

    expect(brief.planningMode).toBe('deterministic_fallback');

    // The CLI always passes a hook; it declines (undefined) when no provider
    // is configured. That must plan offline, not report malformed output.
    const declined = await planAppBuildBrief({
      prompt: 'Build an executive sales App showing revenue trend, orders by region, and new-customer growth for the last 90 days.',
      candidates: allCandidates,
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
      complete: async () => undefined,
    });
    expect(declined.plannerProvenance).toEqual({ version: 1, mode: 'deterministic', providerInvocation: 'not_attempted' });
    expect(declined.components.map((component) => component.sourceId)).toEqual(brief.components.map((component) => component.sourceId));
    expect(brief.plannerProvenance).toEqual({
      version: 1,
      mode: 'deterministic',
      providerInvocation: 'not_attempted',
    });
    expect(brief.requirements.map((requirement) => requirement.question)).toEqual([
      'Revenue trend',
      'Orders by region',
      'New-customer growth for the last 90 days',
    ]);
    expect(brief.selectedSourceIds).not.toContain('app:block:runtime:acceptance');
    expect(brief.components.find((component) => component.sourceId === candidates[0].sourceId)?.requirementIds).toEqual(['requirement-1']);
    expect(brief.components.find((component) => component.sourceId === candidates[1].sourceId)?.requirementIds).toEqual(['requirement-2']);
    expect(brief.components.find((component) => component.sourceId === 'app:block:customers:growth')?.requirementIds).toEqual([]);
    expect(brief.warnings).toEqual(['New customer growth can\'t answer “New-customer growth for the last 90 days” with its approved fields yet.']);
    expect(brief.warnings.join(' ')).not.toMatch(/requirement-\d/);
  });

  it('keeps the keyword planner\'s request parts as notes, never publish blockers (design D4)', async () => {
    const brief = await planAppBuildBrief({
      prompt: 'Revenue trend, orders by region. Keep it short and clear.',
      candidates,
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
      complete: async () => undefined,
    });
    expect(brief.plannerProvenance.mode).toBe('deterministic');
    expect(brief.requirements.length).toBeGreaterThan(1);
    expect(brief.requirements.every((requirement) => requirement.required === false)).toBe(true);
  });

  it('retains explicitly required certified and draft sources omitted by the provider', async () => {
    const requiredCandidates = [
      { ...candidates[0], capabilities: { ...candidates[0].capabilities, measures: ['margin'], outputs: ['margin'] } },
      { ...candidates[1], name: 'Revenue order detail', title: 'Revenue order detail' },
    ];
    const complete = vi.fn(async () => JSON.stringify({
      frame: { goal: 'Executive sales' },
      requirements: [{ id: 'r1', question: 'Profit margin', role: 'kpi', required: true, measures: ['margin'], dimensions: [], filters: [] }],
      components: [{ id: 'c1', title: 'Revenue trend', sourceId: candidates[0].sourceId, requirementIds: ['r1'], role: 'trend', view: 'line', rationale: 'Provider selected only certified revenue' }],
    }));

    const brief = await planAppBuildBrief({
      prompt: 'Build an executive sales App',
      candidates: requiredCandidates,
      requiredSourceIds: requiredCandidates.map((candidate) => candidate.sourceId),
      sourcePolicy: 'include_review_required',
      complete,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(brief.components.map((component) => component.sourceId)).toEqual(requiredCandidates.map((candidate) => candidate.sourceId));
    expect(brief.selectedSourceIds).toEqual(requiredCandidates.map((candidate) => candidate.sourceId));
    const appendedDraft = brief.components.find((component) => component.sourceId === requiredCandidates[1].sourceId);
    expect(appendedDraft).toMatchObject({ view: 'line', requirementIds: [] });
    expect(brief.warnings).toEqual([expect.stringContaining('its fields don\'t match anything you asked for yet')]);
  });

  it('rejects a required source that was not supplied as a candidate card', async () => {
    await expect(planAppBuildBrief({
      prompt: 'Build an executive sales App',
      candidates,
      requiredSourceIds: ['app:block:missing'],
      sourcePolicy: 'governed_only',
    })).rejects.toThrow('APP_BUILD_REQUIRED_SOURCE_MISSING');
  });

  it('does not confuse partially overlapping structured capability names', async () => {
    const capabilityCandidates = [
      { ...candidates[0], capabilities: { ...candidates[0].capabilities, measures: ['gross_margin'], outputs: ['gross_margin'] } },
      { ...candidates[1], name: 'Gross revenue detail', title: 'Gross revenue detail', capabilities: { ...candidates[1].capabilities, measures: ['gross_revenue'], outputs: ['gross_revenue'] } },
    ];
    const brief = await planAppBuildBrief({
      prompt: 'Compare gross margin and supporting revenue detail',
      candidates: capabilityCandidates,
      requiredSourceIds: [capabilityCandidates[1].sourceId],
      sourcePolicy: 'include_review_required',
      complete: async () => JSON.stringify({
        frame: { goal: 'Compare gross margin' },
        requirements: [{ id: 'gross-margin', question: 'Gross margin', role: 'kpi', required: true, measures: ['gross_margin'], dimensions: [], filters: [] }],
        components: [{ id: 'margin', title: 'Gross margin', sourceId: capabilityCandidates[0].sourceId, requirementIds: ['gross-margin'], role: 'kpi', view: 'kpi', rationale: 'Exact gross margin capability' }],
      }),
    });

    expect(brief.components.find((component) => component.sourceId === capabilityCandidates[1].sourceId)?.requirementIds).toEqual([]);
    expect(brief.warnings).toEqual([expect.stringContaining('its fields don\'t match anything you asked for yet')]);
  });

  it('rejects provider capability fields that contradict the visible requirement question', async () => {
    const revenueCandidate = {
      ...candidates[0],
      capabilities: { ...candidates[0].capabilities, measures: ['revenue'], outputs: ['revenue'] },
    };
    const brief = await planAppBuildBrief({
      prompt: 'Profit margin',
      candidates: [revenueCandidate],
      requiredSourceIds: [],
      sourcePolicy: 'governed_only',
      complete: async () => JSON.stringify({
        frame: { goal: 'Profit margin' },
        requirements: [{ id: 'profit-margin', question: 'Profit margin', role: 'kpi', required: true, measures: ['revenue'], dimensions: [], filters: [] }],
        components: [{ id: 'revenue', title: 'Revenue trend', sourceId: revenueCandidate.sourceId, requirementIds: ['profit-margin'], role: 'kpi', view: 'kpi', rationale: 'Provider claimed revenue covers profit margin' }],
      }),
    });

    expect(brief.components).toEqual([expect.objectContaining({ sourceId: revenueCandidate.sourceId, requirementIds: [] })]);
    expect(brief.warnings).toEqual(['Revenue trend can\'t answer what you asked with its approved fields yet.']);
  });

  it('keeps an explicitly required deterministic source without claiming unsupported coverage', async () => {
    const revenueOrders = { ...candidates[1], name: 'Revenue orders', title: 'Revenue orders' };
    const brief = await planAppBuildBrief({
      prompt: 'Profit margin',
      candidates: [revenueOrders],
      requiredSourceIds: [revenueOrders.sourceId],
      sourcePolicy: 'include_review_required',
    });

    expect(brief.planningMode).toBe('deterministic_fallback');
    expect(brief.selectedSourceIds).toEqual([revenueOrders.sourceId]);
    expect(brief.components).toEqual([expect.objectContaining({ sourceId: revenueOrders.sourceId, requirementIds: [] })]);
    expect(brief.warnings).toEqual(['Revenue orders can\'t answer what you asked with its approved fields yet.']);
  });

  it('names sources and questions in plain words, never ids, in planner notes', async () => {
    const topCustomers = { ...source('app:block:sales:top', 'top_customers', 'certified'), capabilities: { ...candidates[0].capabilities, measures: ['lifetime_value'], outputs: ['lifetime_value'] } };
    const brief = await planAppBuildBrief({
      prompt: 'Top customers and revenue by region',
      candidates: [topCustomers],
      requiredSourceIds: [],
      sourcePolicy: 'governed_only',
      complete: async () => JSON.stringify({
        frame: { goal: 'Top customers and revenue by region' },
        requirements: [
          { id: 'requirement-1', question: 'Top customers', role: 'breakdown', required: true, measures: [], dimensions: [], filters: [] },
          { id: 'requirement-2', question: 'Revenue by region', role: 'breakdown', required: true, measures: ['revenue'], dimensions: ['region'], filters: [] },
        ],
        components: [{ id: 'c1', title: 'top_customers', sourceId: topCustomers.sourceId, requirementIds: ['requirement-1', 'requirement-2'], role: 'breakdown', view: 'bar', rationale: 'x' }],
      }),
    });
    expect(brief.warnings).toEqual(['Top Customers covers only part of what you asked. It doesn\'t answer “Revenue by region”.']);
  });

  it('explains a built-in pick by the words that matched and its trust', async () => {
    const topCustomers = {
      ...source('app:block:sales:top', 'top_customers', 'certified'),
      description: 'Customers ranked by lifetime value.',
      capabilities: { ...candidates[0].capabilities, measures: ['lifetime_value'], dimensions: ['customer_name'], outputs: ['lifetime_value'], filters: [] },
    };
    const brief = await planAppBuildBrief({
      prompt: 'Show my best customers by value',
      candidates: [topCustomers, { ...candidates[1], description: undefined }],
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
    });
    const byId = new Map(brief.components.map((component) => [component.sourceId, component.rationale]));
    expect(byId.get(topCustomers.sourceId)).toBe('Its name, description and fields match “customers”, “value” · Certified saved query');
    expect(byId.get(candidates[1].sourceId)).toBe('One of the closest matches in the data you can use · Saved query · Needs review');
  });

  it('AGT-026 plans several source-bound Dataset tiles, falls back from invented query authority, and keeps coverage query-specific', async () => {
    const descriptor = datasetDescriptor('app:block:commerce:orders');
    const candidate: AppSourceCatalogRecord = {
      ...source('app:block:commerce:orders', 'Order Lines Dataset', 'certified'),
      sourceRevision: 'sha256:server-authoritative-source-revision',
      capabilities: {
        measures: ['revenue', 'margin'], dimensions: ['customer_id', 'order_date'], outputs: ['revenue', 'margin'], filters: ['region'],
        allowedVisualizations: ['kpi', 'line', 'bar', 'table'], parameters: [], dataset: descriptor,
      },
    };
    const complete = vi.fn(async () => JSON.stringify({
      frame: { goal: 'Commerce overview' },
      requirements: [
        { id: 'revenue-kpi', question: 'Revenue', role: 'kpi', required: true, measures: ['revenue'], dimensions: [], filters: [] },
        { id: 'monthly-revenue', question: 'Monthly revenue', role: 'trend', required: true, measures: ['revenue'], dimensions: ['order_date'], filters: [] },
        { id: 'customer-revenue', question: 'Revenue by customer', role: 'breakdown', required: true, measures: ['revenue'], dimensions: ['customer_id'], filters: [] },
        { id: 'profit-margin', question: 'Profit margin', role: 'kpi', required: true, measures: ['margin'], dimensions: [], filters: [] },
      ],
      components: [
        { id: 'revenue-kpi', title: 'Revenue', sourceId: candidate.sourceId, requirementIds: ['revenue-kpi'], role: 'kpi', view: 'kpi', rationale: 'KPI', query: { dimensions: [], measures: [{ measure: 'revenue' }] } },
        { id: 'monthly-revenue', title: 'Monthly revenue', sourceId: candidate.sourceId, requirementIds: ['monthly-revenue'], role: 'trend', view: 'line', rationale: 'Trend', query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] } },
        { id: 'customer-revenue', title: 'Revenue by customer', sourceId: candidate.sourceId, requirementIds: ['customer-revenue'], role: 'breakdown', view: 'bar', rationale: 'Breakdown', query: { dimensions: [{ field: 'customer_id' }], measures: [{ measure: 'revenue' }] } },
        // The provider cannot add an authority field. The normalized fallback
        // must select the matching approved margin measure instead.
        { id: 'forged-margin', title: 'Profit margin', sourceId: candidate.sourceId, requirementIds: ['profit-margin'], role: 'kpi', view: 'kpi', rationale: 'Forged', query: { dimensions: [], measures: [{ measure: 'revenue' }], sourceRevision: 'forged' } },
        // A syntactically valid revenue query still cannot claim that it
        // covers the separate margin requirement.
        { id: 'revenue-not-margin', title: 'Revenue is not margin', sourceId: candidate.sourceId, requirementIds: ['profit-margin'], role: 'kpi', view: 'kpi', rationale: 'Wrong coverage', query: { dimensions: [], measures: [{ measure: 'revenue' }] } },
      ],
    }));

    const brief = await planAppBuildBrief({
      prompt: 'Build a commerce overview', candidates: [candidate], requiredSourceIds: [], sourcePolicy: 'governed_only', complete,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(brief.components.map((component) => component.id)).toEqual(['revenue-kpi', 'monthly-revenue', 'customer-revenue', 'forged-margin', 'revenue-not-margin']);
    expect(brief.components.map((component) => component.sourceId)).toEqual([candidate.sourceId, candidate.sourceId, candidate.sourceId, candidate.sourceId, candidate.sourceId]);
    expect(brief.components.find((component) => component.id === 'monthly-revenue')?.query).toEqual({
      dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }],
    });
    expect(brief.components.find((component) => component.id === 'forged-margin')?.query).toEqual({
      dimensions: [], measures: [{ measure: 'margin' }],
    });
    expect(brief.components.find((component) => component.id === 'forged-margin')?.requirementIds).toEqual(['profit-margin']);
    expect(brief.components.find((component) => component.id === 'revenue-not-margin')?.requirementIds).toEqual([]);
    expect(complete.mock.calls[0]?.[0].user).not.toContain(candidate.sourceRevision);
    expect(complete.mock.calls[0]?.[0].user).not.toContain('contractFingerprint');
  });

  it('AGT-026 normalizes a multi-page story with exact Dataset filters, navigation, cross-filter, and detail drill contracts', async () => {
    const descriptor = datasetDescriptor('app:block:commerce:orders');
    const candidate: AppSourceCatalogRecord = {
      ...source('app:block:commerce:orders', 'Order Lines Dataset', 'certified'),
      capabilities: {
        measures: ['revenue', 'margin'], dimensions: ['customer_id', 'order_date'], outputs: ['revenue', 'margin'], filters: ['customer_id', 'order_date'],
        allowedVisualizations: ['kpi', 'line', 'bar', 'table'], parameters: [], dataset: descriptor,
      },
    };
    const brief = await planAppBuildBrief({
      prompt: 'Build a commerce leadership App with an overview and customer detail.',
      candidates: [candidate],
      requiredSourceIds: [],
      sourcePolicy: 'governed_only',
      complete: async () => JSON.stringify({
        frame: { goal: 'Commerce leadership' },
        requirements: [
          { id: 'revenue', question: 'Revenue', role: 'kpi', required: true, measures: ['revenue'], dimensions: [], filters: [] },
          { id: 'monthly', question: 'Monthly revenue', role: 'trend', required: true, measures: ['revenue'], dimensions: ['order_date'], filters: [] },
          { id: 'customer', question: 'Revenue by customer', role: 'detail', required: true, measures: ['revenue'], dimensions: ['customer_id'], filters: [] },
          { id: 'margin', question: 'Margin', role: 'kpi', required: true, measures: ['margin'], dimensions: [], filters: [] },
        ],
        components: [
          { id: 'revenue-kpi', title: 'Revenue', sourceId: candidate.sourceId, requirementIds: ['revenue'], role: 'kpi', view: 'kpi', rationale: 'KPI', query: { dimensions: [], measures: [{ measure: 'revenue' }] } },
          { id: 'monthly-revenue', title: 'Monthly revenue', sourceId: candidate.sourceId, requirementIds: ['monthly'], role: 'trend', view: 'line', rationale: 'Trend', query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'customer_id' }], measures: [{ measure: 'revenue' }] } },
          { id: 'customer-revenue', title: 'Revenue by customer', sourceId: candidate.sourceId, requirementIds: ['customer'], role: 'detail', view: 'bar', rationale: 'Detail', query: { dimensions: [{ field: 'customer_id' }], measures: [{ measure: 'revenue' }] } },
          { id: 'margin-kpi', title: 'Margin', sourceId: candidate.sourceId, requirementIds: ['margin'], role: 'kpi', view: 'kpi', rationale: 'KPI', query: { dimensions: [], measures: [{ measure: 'margin' }] } },
        ],
        pages: [
          { id: 'overview', title: 'Overview', componentIds: ['revenue-kpi', 'monthly-revenue', 'customer-revenue'], sections: [{ id: 'metrics', title: 'Key metrics', kind: 'kpi_band', componentIds: ['revenue-kpi'] }, { id: 'trend', title: 'Trend', kind: 'insight', componentIds: ['monthly-revenue', 'customer-revenue'] }] },
          { id: 'details', title: 'Details', componentIds: ['margin-kpi'], sections: [{ id: 'detail', title: 'Details', kind: 'appendix', componentIds: ['margin-kpi'] }] },
        ],
        filters: [{ id: 'customer', label: 'Customer', field: 'customer_id', scope: 'app', componentIds: ['revenue-kpi', 'monthly-revenue', 'customer-revenue', 'margin-kpi'] }],
        navigation: [{ fromComponentId: 'monthly-revenue', toPageId: 'details' }],
        crossFilters: [{ fromComponentId: 'monthly-revenue', fromField: 'customer_id', toComponentId: 'customer-revenue', toField: 'customer_id' }],
        detailDrills: [{ pageId: 'details', componentId: 'margin-kpi', fields: ['customer_id', 'invented_field'] }],
      }),
    });

    expect(brief.pages.map((page) => ({ id: page.id, componentIds: page.componentIds }))).toEqual([
      { id: 'overview', componentIds: ['revenue-kpi', 'monthly-revenue', 'customer-revenue'] },
      { id: 'details', componentIds: ['margin-kpi'] },
    ]);
    expect(brief.filters).toEqual([expect.objectContaining({ id: 'customer', field: 'customer_id', scope: 'app' })]);
    expect(brief.navigation).toEqual([{ fromComponentId: 'monthly-revenue', toPageId: 'details' }]);
    expect(brief.crossFilters).toEqual([{ fromComponentId: 'monthly-revenue', fromField: 'customer_id', toComponentId: 'customer-revenue', toField: 'customer_id' }]);
    expect(brief.detailDrills).toEqual([{ pageId: 'details', componentId: 'margin-kpi', fields: ['customer_id'] }]);
  });
});

describe('keyword planner on a just-checked table (B13)', () => {
  // The shape "Check the numbers" writes: every number column is a field and its own total.
  const sourceId = 'app:block:commerce:order-lines-from-table';
  const checked: DatasetDescriptor = {
    ...datasetDescriptor(sourceId),
    label: 'Order lines from table',
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof.order-lines-from-table' },
    fields: [
      { kind: 'physical', name: 'cost_amount', qualifiedId: `${sourceId}::field::cost_amount`, type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'customer_id', qualifiedId: `${sourceId}::field::customer_id`, type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'net_amount', qualifiedId: `${sourceId}::field::net_amount`, type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'order_date', qualifiedId: `${sourceId}::field::order_date`, type: 'timestamp', role: 'time', status: 'approved', time: { grains: ['day', 'week', 'month', 'quarter', 'year'], primary: true } },
      { kind: 'physical', name: 'order_line_id', qualifiedId: `${sourceId}::field::order_line_id`, type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'region', qualifiedId: `${sourceId}::field::region`, type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'measure', name: 'cost_amount', qualifiedId: `${sourceId}::measure::cost_amount`, aggregation: 'sum', from: 'cost_amount', dependsOn: ['cost_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      { kind: 'measure', name: 'net_amount', qualifiedId: `${sourceId}::measure::net_amount`, aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      { kind: 'measure', name: 'order_line_count', qualifiedId: `${sourceId}::measure::order_line_count`, aggregation: 'count_distinct', from: 'order_line_id', dependsOn: ['order_line_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
    ],
    operations: ['filter', 'group', 'rank', 'having', 'trend', 'compare', 'detail'],
  };
  const requirement = (question: string, role: AppBuildRequirement['role']): AppBuildRequirement => ({ id: question, question, role, required: true, measures: [], dimensions: [], filters: [] });

  it('picks the measure and the group the question names, and never groups a total by itself', () => {
    expect(deterministicDatasetQuery(checked, requirement('Top 10 regions by net amount', 'breakdown'), 'breakdown')).toEqual({ dimensions: [{ field: 'region' }], measures: [{ measure: 'net_amount' }] });
    expect(deterministicDatasetQuery(checked, requirement('Monthly net amount', 'trend'), 'trend')).toEqual({ dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'net_amount' }] });
    expect(deterministicDatasetQuery(checked, requirement('Total net amount as a KPI', 'kpi'), 'kpi')).toEqual({ dimensions: [], measures: [{ measure: 'net_amount' }] });
    // With nothing named, the first measure groups by a text category, not by its own column.
    const plain = deterministicDatasetQuery(checked, undefined, 'evidence');
    expect(plain).toEqual({ dimensions: [{ field: 'customer_id' }], measures: [{ measure: 'cost_amount' }] });
  });

  it('builds a tile for every ask from the checked table, without "can\'t answer" notes', async () => {
    const candidate: AppSourceCatalogRecord = {
      ...source(sourceId, 'Order lines from table', 'certified'),
      qualifiedIdentity: 'commerce::block::Order lines from table',
      capabilities: {
        measures: ['cost_amount', 'net_amount', 'order_line_count'], dimensions: ['customer_id', 'order_date', 'region'], outputs: ['cost_amount', 'net_amount', 'order_line_count'], filters: ['region'],
        allowedVisualizations: ['kpi', 'line', 'bar', 'table'], parameters: [], dataset: checked,
      },
    };
    for (const prompt of ['Top 10 regions by net amount', 'Monthly net amount, top 10 regions by net amount, and total net amount as a KPI']) {
      const brief = await planAppBuildBrief({ prompt, candidates: [candidate], requiredSourceIds: [candidate.sourceId], sourcePolicy: 'governed_only' });
      expect(brief.planningMode).toBe('deterministic_fallback');
      // It is kept (not dropped with "can't answer this"); the ask is still reported as not covered.
    expect(brief.warnings.filter((warning) => /can't answer this/.test(warning)), brief.warnings.join(' | ')).toEqual([]);
      const component = brief.components.find((entry) => entry.sourceId === candidate.sourceId);
      expect(component?.query?.measures).toEqual([{ measure: 'net_amount' }]);
      expect(component?.requirementIds.length).toBeGreaterThan(0);
    }
    const kpi = await planAppBuildBrief({ prompt: 'Total net amount as a KPI', candidates: [candidate], requiredSourceIds: [], sourcePolicy: 'governed_only' });
    expect(kpi.requirements[0]?.role).toBe('kpi');
    expect(kpi.components[0]?.query).toEqual({ dimensions: [], measures: [{ measure: 'net_amount' }] });
    expect(kpi.components[0]?.requirementIds).toEqual([kpi.requirements[0]!.id]);
  });
});

describe('keyword planner on a saved query with result fields (design D1)', () => {
  const sourceId = 'app:block:commerce:monthly-revenue';
  const result = savedQueryResultDescriptor({
    sourceId, sourceRevision: 'sha256:monthly', savedQuery: 'monthly_revenue', qualifiedId: 'commerce::block::monthly_revenue',
    lifecycle: 'certified', certified: true, typesFrom: 'probe',
    columns: [{ name: 'month', type: 'TIMESTAMP' }, { name: 'gross_revenue', type: 'DOUBLE' }, { name: 'avg_order_value', type: 'DOUBLE' }],
    groupBy: ['month'],
  })!;
  const candidate: AppSourceCatalogRecord = {
    ...source(sourceId, 'monthly_revenue', 'certified'),
    capabilities: { measures: ['gross_revenue'], dimensions: ['month'], outputs: ['month', 'gross_revenue', 'avg_order_value'], filters: [], allowedVisualizations: [], parameters: [], dataset: result },
  };

  it('plans a field tile from its result columns: the trend as it is, the total rolled up', async () => {
    const brief = await planAppBuildBrief({ prompt: 'Monthly gross revenue trend', candidates: [candidate], requiredSourceIds: [sourceId], sourcePolicy: 'governed_only' });
    expect(brief.components[0]?.query).toEqual({ dimensions: [{ field: 'month', timeGrain: 'month' }], measures: [{ measure: 'gross_revenue' }] });
    const kpi = await planAppBuildBrief({ prompt: 'Total gross revenue as a KPI', candidates: [candidate], requiredSourceIds: [sourceId], sourcePolicy: 'governed_only' });
    expect(kpi.components[0]?.query).toEqual({ dimensions: [], measures: [{ measure: 'gross_revenue' }] });
  });

  it('keeps showing the saved query as it is when its fields cannot answer, instead of dropping it', async () => {
    // An average named on its own is never summed into a KPI, and nothing else matches.
    const averagesOnly = { ...candidate, capabilities: { ...candidate.capabilities, dataset: { ...result, fields: result.fields.filter((field) => field.kind === 'physical' || field.name === 'avg_order_value') } } };
    const brief = await planAppBuildBrief({ prompt: 'Average order value as a KPI', candidates: [averagesOnly], requiredSourceIds: [sourceId], sourcePolicy: 'governed_only' });
    expect(brief.components).toEqual([expect.objectContaining({ sourceId })]);
    expect(brief.components[0]?.query).toBeUndefined();
    // It is kept, not dropped with "can't answer this"; the ask itself is still reported as not covered.
    expect(brief.warnings.filter((warning) => /can't answer this/.test(warning)), brief.warnings.join(' | ')).toEqual([]);
  });
});

function datasetDescriptor(sourceId: string): DatasetDescriptor {
  return {
    version: 1,
    id: `dataset:${sourceId}`,
    kind: 'block',
    sourceRevision: 'sha256:server-authoritative-source-revision',
    snapshotId: 'server-snapshot',
    contractRef: { kind: 'block_source', id: sourceId, fingerprint: 'contract-server' },
    binding: { sourceQualifiedId: sourceId, sourceRevision: 'sha256:server-authoritative-source-revision', contractFingerprint: 'contract-server', state: 'target_required' },
    label: 'Order Lines',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'] },
    fields: [
      { kind: 'physical', name: 'customer_id', qualifiedId: `${sourceId}:customer_id`, type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'order_date', qualifiedId: `${sourceId}:order_date`, type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
      { kind: 'measure', name: 'revenue', qualifiedId: `${sourceId}:revenue`, aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      { kind: 'measure', name: 'margin', qualifiedId: `${sourceId}:margin`, aggregation: 'sum', from: 'margin_amount', dependsOn: ['margin_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
    ],
    operations: ['filter', 'group', 'trend'],
    execution: { route: 'governed_sql' },
  };
}

function source(sourceId: string, title: string, lifecycle: 'certified' | 'draft'): AppSourceCatalogRecord {
  return {
    sourceId,
    qualifiedIdentity: `sales::block::${title}`,
    sourceRevision: `sha256:${sourceId}`,
    snapshotId: 'snapshot-1',
    kind: 'block',
    lifecycle,
    trust: lifecycle === 'certified' ? 'certified' : 'review_required',
    executable: true,
    name: title,
    title,
    domain: 'sales',
    sourcePath: `blocks/${sourceId.split(':').at(-1)}.dql`,
    executionRef: `blocks/${sourceId.split(':').at(-1)}.dql`,
    tags: [],
    capabilities: { measures: ['revenue'], dimensions: ['region'], outputs: ['revenue'], filters: ['date'], allowedVisualizations: ['line'], parameters: [] },
    eligibility: { discoverable: true, localPreview: true, projectPublish: lifecycle === 'certified', reasonCodes: [] },
    reasons: ['matched'],
  };
}
