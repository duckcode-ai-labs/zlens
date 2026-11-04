import { describe, expect, it } from 'vitest';
import type { DomainDiscoveryReport } from '@zlens/core';
import type { DbtNode } from './dbt-model-discovery.js';
import type { DbtRelationFacts } from './model-layers.js';
import { DEFAULT_DRAFT_BUDGET, draftScopeChoices, draftScopeGraph, resolveDraftScope, searchDraftTables } from './draft-scope.js';

// A small shop: raw orders, a staging model, two marts, a finance report and
// a sales report. The finance report is the subject area `finance`.
const table = (id: string, schema: string, name: string): DbtNode => ({ uniqueId: id, relation: `analytics.${schema}.${name}`, database: 'analytics', schema });
const nodes: DbtNode[] = [
  table('source.shop.raw.orders', 'raw', 'orders'),
  table('model.shop.stg_orders', 'staging', 'stg_orders'),
  table('model.shop.zuora_account_source', 'zuora', 'zuora_account_source'),
  table('model.shop.dim_customers', 'marts', 'dim_customers'),
  table('model.shop.fct_orders', 'marts', 'fct_orders'),
  table('model.shop.rpt_revenue', 'finance', 'rpt_revenue'),
  table('model.shop.rpt_pipeline', 'sales', 'rpt_pipeline'),
];
// Keyed by relation, as readDbtRelationFacts keys them.
const relationOf = (id: string) => { const node = nodes.find((item) => item.uniqueId === id)!; return `${node.schema}.${node.relation.split('.').pop()}`; };
const fact = (id: string, path: string | undefined, dependsOn: string[], extra: Partial<DbtRelationFacts> = {}): [string, DbtRelationFacts] => [relationOf(id), {
  uniqueId: id,
  resourceType: id.startsWith('source.') ? 'source' : 'model',
  ...(path ? { path } : {}),
  dependsOn,
  uniqueTests: [],
  tests: 0,
  exposures: 0,
  ...extra,
}];
const facts = new Map<string, DbtRelationFacts>([
  fact('source.shop.raw.orders', undefined, []),
  fact('model.shop.stg_orders', 'models/staging/stg_orders.sql', ['source.shop.raw.orders']),
  fact('model.shop.zuora_account_source', 'models/sources/zuora/zuora_account_source.sql', []),
  fact('model.shop.dim_customers', 'models/marts/dim_customers.sql', []),
  fact('model.shop.fct_orders', 'models/marts/fct_orders.sql', ['model.shop.stg_orders', 'model.shop.dim_customers']),
  fact('model.shop.rpt_revenue', 'models/marts/finance/rpt_revenue.sql', ['model.shop.fct_orders'], { exposures: 1 }),
  fact('model.shop.rpt_pipeline', 'models/marts/sales/rpt_pipeline.sql', ['model.shop.fct_orders']),
]);
const dbtManifest = {
  nodes: {
    'model.shop.fct_orders': { original_file_path: 'models/marts/fct_orders.sql', tags: ['finance', 'daily'], package_name: 'shop', resource_type: 'model' },
    'model.shop.rpt_revenue': { original_file_path: 'models/marts/finance/rpt_revenue.sql', tags: [], package_name: 'shop', resource_type: 'model' },
    'model.shop.rpt_pipeline': { original_file_path: 'models/marts/sales/rpt_pipeline.sql', tags: [], package_name: 'shop', resource_type: 'model' },
  },
  sources: { 'source.shop.raw.orders': { source_name: 'raw', resource_type: 'source' } },
};
const domains = {
  memberships: [
    { dbtUniqueId: 'model.shop.rpt_revenue', proposedDomain: 'commerce', proposedArea: 'finance' },
    { dbtUniqueId: 'model.shop.rpt_pipeline', proposedDomain: 'commerce', proposedArea: 'sales' },
    { dbtUniqueId: 'model.shop.fct_orders', proposedDomain: 'commerce' },
    { dbtUniqueId: 'model.shop.dim_customers', proposedDomain: 'commerce' },
  ],
} as unknown as DomainDiscoveryReport;
const resolve = (options: Parameters<typeof resolveDraftScope>[1]) => resolveDraftScope({ nodes, dbtManifest, facts, domains }, options);

describe('resolveDraftScope (model-at-scale design S3, S4)', () => {
  it('drafts the whole project within the budget, business tables first, and lists the rest', () => {
    const all = resolve({});
    expect(all).toMatchObject({ description: 'the whole project', asked: 7, budget: DEFAULT_DRAFT_BUDGET, leftOut: [] });

    const capped = resolve({ budget: 3 });
    // Business tables first; among them the one an exposure uses, then the one most models read.
    expect(capped.ids).toEqual(['model.shop.rpt_revenue', 'model.shop.fct_orders', 'model.shop.dim_customers']);
    expect(capped.leftOut.map((item) => [item.uniqueId, item.layer])).toEqual([
      ['model.shop.rpt_pipeline', 'final'],
      ['model.shop.stg_orders', 'staging'],
      // A model named for its source, in a sources folder, is staging.
      ['model.shop.zuora_account_source', 'staging'],
      ['source.shop.raw.orders', 'raw'],
    ]);
    expect(capped.areas).toEqual([{ id: 'domain:commerce', tables: 2 }, { id: 'area:finance', tables: 1 }, { id: 'area:sales', tables: 1 }]);
  });

  it('picks by graph, path and tag, as dbt does', () => {
    expect(resolve({ select: ['+fct_orders'] }).ids.sort()).toEqual(['model.shop.dim_customers', 'model.shop.fct_orders', 'model.shop.stg_orders', 'source.shop.raw.orders']);
    expect(resolve({ select: ['1+fct_orders'] }).ids.sort()).toEqual(['model.shop.dim_customers', 'model.shop.fct_orders', 'model.shop.stg_orders']);
    expect(resolve({ select: ['fct_orders+'] }).ids.sort()).toEqual(['model.shop.fct_orders', 'model.shop.rpt_pipeline', 'model.shop.rpt_revenue']);
    expect(resolve({ select: ['path:models/marts/finance'] }).ids).toEqual(['model.shop.rpt_revenue']);
    expect(resolve({ select: ['tag:finance'] }).ids).toEqual(['model.shop.fct_orders']);
    expect(resolve({ select: ['rpt_*'] }).ids.sort()).toEqual(['model.shop.rpt_pipeline', 'model.shop.rpt_revenue']);
    expect(resolve({ select: ['rpt_revenue rpt_pipeline'] }).asked).toBe(2);
  });

  it('brings the business tables an area reads, and adds neighbours with hops', () => {
    // The finance area reads fct_orders and, through it, dim_customers; never the staging or raw tables.
    expect(resolve({ select: ['area:finance'] }).ids.sort()).toEqual(['model.shop.dim_customers', 'model.shop.fct_orders', 'model.shop.rpt_revenue']);
    expect(resolve({ select: ['area:commerce.sales'] }).ids).toContain('model.shop.rpt_pipeline');
    expect(resolve({ select: ['domain:commerce'] }).asked).toBe(4);
    expect(resolve({ select: ['dim_customers'], hops: 1 }).ids.sort()).toEqual(['model.shop.dim_customers', 'model.shop.fct_orders']);
    expect(resolve({ select: ['nothing_here'] }).ids).toEqual([]);
  });
});

describe('what the draft picker offers (model-at-scale design S3)', () => {
  const graph = draftScopeGraph({ nodes, dbtManifest, facts, domains });

  it('counts the project by layer, and lists each Domain with its areas and what they read', () => {
    const choices = draftScopeChoices(graph);
    expect(choices).toMatchObject({ tables: 7, budget: DEFAULT_DRAFT_BUDGET, layers: { business: 4, staging: 2, raw: 1 } });
    expect(choices.areas).toEqual([
      { select: 'domain:commerce', domain: 'commerce', tables: 4, reads: 0 },
      { select: 'area:commerce.finance', domain: 'commerce', area: 'finance', tables: 1, reads: 2 },
      { select: 'area:commerce.sales', domain: 'commerce', area: 'sales', tables: 1, reads: 2 },
    ]);
    // Each choice drafts what it says: an area's tables and the business tables they read.
    expect(resolveDraftScope(graph, { select: [choices.areas[1]!.select] }).asked).toBe(1 + 2);
  });

  it('searches tables to start from: business tables first, then the most read', () => {
    const found = searchDraftTables(graph, { q: '', businessOnly: true });
    expect(found.items.map((item) => item.name)).toEqual(['fct_orders', 'dim_customers', 'rpt_pipeline', 'rpt_revenue']);
    expect(found.items[0]).toMatchObject({ business: true, domain: 'commerce', readers: 2 });
    expect(searchDraftTables(graph, { q: 'orders', businessOnly: false }).items.map((item) => item.name)).toEqual(['fct_orders', 'stg_orders', 'orders']);
  });
});
