import { describe, expect, it } from 'vitest';
import { budgetWarehouseDraft } from './warehouse-draft-budget.js';
import type { WarehouseDiscoveryReport } from './warehouse-model-discovery.js';

/** Onboarding design, Reuse: the 150-table draft budget on the warehouse path. */
describe('the draft budget on the warehouse path', () => {
  const entity = (id: string, layer: 'final' | 'staging' | 'raw' = 'final', grain?: string) => ({ id, domain: 'd', relationId: `w.${id}`, relation: `DB.S.${id.toUpperCase()}`, kind: 'table' as const, businessName: id, keys: [], layer, ...(grain ? { grain } : {}) });
  const join = (from: string, to: string) => ({ id: `${from}_to_${to}`, domain: 'd', from, to, fromDomain: 'd', toDomain: 'd', fromRelation: from, toRelation: to, keys: [{ from: 'x', to: 'x' }], evidence: [], cardinality: 'many_to_one', fanout: 'safe' });
  const report = {
    catalogFingerprint: 'f', capturedAt: '', relations: 5, domains: [], existingRelationships: 0, validated: true,
    entities: [entity('stg_orders', 'staging'), entity('orders'), entity('customers', 'final', 'customer_id'), entity('lonely'), entity('raw_events', 'raw')],
    relationships: [join('orders', 'customers'), join('stg_orders', 'customers'), join('lonely', 'raw_events')],
    rules: [{ id: 'r1', domain: 'd', kind: 'custom', expression: 'x', entities: ['orders'], evidence: { query: '', measured: {}, checkedAt: '' } }, { id: 'r2', domain: 'd', kind: 'custom', expression: 'y', entities: ['raw_events'], evidence: { query: '', measured: {}, checkedAt: '' } }],
  } as unknown as WarehouseDiscoveryReport;

  it('drafts the most important tables within the budget and lists the rest, never silently', () => {
    const budgeted = budgetWarehouseDraft(report, 3);
    expect(budgeted.entities.map((item) => item.id)).toEqual(['orders', 'customers', 'lonely']);
    expect(budgeted.relationships.map((item) => item.id)).toEqual(['orders_to_customers']);
    expect(budgeted.rules?.map((item) => item.id)).toEqual(['r1']);
    expect(budgeted.scope).toMatchObject({ asked: 5, drafted: 3, budget: 3, leftOut: [{ relation: 'DB.S.STG_ORDERS', layer: 'staging' }, { relation: 'DB.S.RAW_EVENTS', layer: 'raw' }] });
  });

  it('within the budget, the draft is as it was', () => {
    expect(budgetWarehouseDraft(report, 150)).toBe(report);
  });

  it('for the background setup, leaves out the joins the checks never got to, and counts them', () => {
    const withUnchecked = { ...report, relationships: [...report.relationships, { ...join('orders', 'lonely'), validationError: 'not validated: discovery validates at most 200 relationships per run' }] } as unknown as WarehouseDiscoveryReport;
    const within = budgetWarehouseDraft(withUnchecked, 150, { checkedJoinsOnly: true });
    expect(within.relationships.map((item) => item.id)).toEqual(['orders_to_customers', 'stg_orders_to_customers', 'lonely_to_raw_events']);
    expect(within.uncheckedJoins).toBe(1);
    expect(budgetWarehouseDraft(withUnchecked, 3, { checkedJoinsOnly: true }).uncheckedJoins).toBe(1);
  });
});
