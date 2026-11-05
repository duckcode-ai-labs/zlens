import { describe, expect, it } from 'vitest';
import type { DQLManifest } from '@zlens/core';
import { modelAnswerGroups, rankByWords, routeQuestionToAreas, routingWords } from './model-routing.js';

// Sales and Marketing areas, a Shared area, Finance tables in no area, and a
// `core` default area: each a group Ask can be routed to (design S6).
const area = (domain: string, id: string, name: string, extra: Record<string, unknown> = {}) => ({
  [`${domain}::model_area::${id}`]: { id: `${domain}::model_area::${id}`, localId: id, qualifiedId: `${domain}::model_area::${id}`, domain, name, intentExamples: [], entityIds: [], relationshipIds: [], referencedEntityIds: [], sourcePath: '', ...extra },
});
const entity = (domain: string, id: string, table: string, areaId?: string, extra: Record<string, unknown> = {}) => ({
  [`${domain}::entity::${id}`]: { id: `${domain}::entity::${id}`, localId: id, domain, dbtUniqueId: `model.${table}`, status: 'draft', ...(areaId ? { areaId: `${domain}::model_area::${areaId}` } : {}), ...extra },
});
const manifest = {
  modeling: {
    packages: { sales_and_marketing: { name: 'Sales and marketing' } },
    areas: {
      ...area('sales_and_marketing', 'sales', 'Sales', { description: 'Pipeline, opportunities and quotas', intentExamples: ['Which reps beat quota?'] }),
      ...area('sales_and_marketing', 'marketing', 'Marketing'),
      ...area('shared', 'shared', 'Shared', { shared: true }),
      ...area('finance', 'core', 'Acme analytics'),
    },
    entities: {
      ...entity('sales_and_marketing', 'opportunity', 'fct_opportunity', 'sales'),
      ...entity('sales_and_marketing', 'pipeline', 'mart_pipeline', 'sales'),
      ...entity('sales_and_marketing', 'campaign', 'mart_campaign', 'marketing'),
      ...entity('shared', 'account', 'dim_account', 'shared'),
      ...entity('shared', 'date', 'dim_date', 'shared'),
      ...entity('finance', 'invoice', 'fct_invoice'),
      ...entity('finance', 'payment', 'fct_payment', 'core'),
      ...entity('finance', 'old_invoice', 'legacy_invoice', undefined, { useInstead: { entity: 'finance::entity::invoice' } }),
      ...entity('finance', 'refund', 'fct_refund', undefined, { status: 'deprecated' }),
    },
    relationships: {},
  },
} as unknown as DQLManifest;
const relationOf = (entity: { dbtUniqueId: string }) => `ins.${entity.dbtUniqueId.replace('model.', '')}`;
const groups = modelAnswerGroups(manifest, relationOf);
const joins: Array<[string, string]> = [['ins.fct_opportunity', 'ins.dim_account'], ['ins.fct_invoice', 'ins.dim_account'], ['ins.mart_campaign', 'ins.dim_account']];

describe('Ask picks the question’s areas (model-at-scale design S6)', () => {
  it('groups the model’s answer tables by area, and by Domain for tables in no area', () => {
    expect(groups.find((group) => group.key === 'domain:finance')?.lookAlikes).toEqual(['ins.legacy_invoice']);
    expect(groups.map((group) => [group.key, group.name, group.shared, group.relations])).toEqual([
      ['area:sales_and_marketing::model_area::sales', 'Sales', false, ['ins.fct_opportunity', 'ins.mart_pipeline']],
      ['area:sales_and_marketing::model_area::marketing', 'Marketing', false, ['ins.mart_campaign']],
      ['area:shared::model_area::shared', 'Shared', true, ['ins.dim_account', 'ins.dim_date']],
      // `core` is the default area, not a subject area; look-alikes and deprecated tables are not answered from.
      ['domain:finance', 'finance', false, ['ins.fct_invoice', 'ins.fct_payment']],
    ]);
    expect(routingWords('Invoices by customer segment and quarterly companies')).toEqual(['invoice', 'customer', 'segment', 'quarterly', 'company']);
  });

  it('routes by the area’s words, and brings the Shared tables its tables join', () => {
    const route = routeQuestionToAreas({ groups, question: 'Which sales reps beat their quota this year?', anchors: [], joins, budget: 30 });
    expect(route.groups.map((group) => group.name)).toEqual(['Sales']);
    expect(route.relations).toEqual(['ins.fct_opportunity', 'ins.mart_pipeline', 'ins.dim_account']);
    expect(route.shared).toEqual(['ins.dim_account']);
  });

  it('routes by the columns of a group\'s tables', () => {
    const withColumns = modelAnswerGroups(manifest, relationOf, (relation) => (relation === 'ins.fct_campaign' || relation === 'ins.mart_campaign' ? ['campaign_id', 'channel_manager'] : []));
    const route = routeQuestionToAreas({ groups: withColumns, question: "Who is the channel manager for spring?", anchors: [], joins, budget: 30 });
    expect(route.groups.map((group) => group.name)).toEqual(['Marketing']);
  });

  it('trusts the tables search found over words', () => {
    const route = routeQuestionToAreas({ groups, question: 'How much was billed per account?', anchors: ['ins.fct_invoice'], joins, budget: 30 });
    expect(route.groups.map((group) => group.name)).toEqual(['finance']);
    expect(route.relations).toEqual(['ins.fct_invoice', 'ins.fct_payment', 'ins.dim_account']);
  });

  it('counts a look-alike search found for the group it belongs to', () => {
    const route = routeQuestionToAreas({ groups, question: 'old billing', anchors: ['ins.legacy_invoice', 'ins.mart_campaign'], joins, budget: 30 });
    // Both groups score 3; the smaller one wins the tie, and the finance group comes with it.
    expect(route.groups.map((group) => group.name).sort()).toEqual(['Marketing', 'finance']);
    expect(route.relations).not.toContain('ins.legacy_invoice');
  });

  it('keeps within the budget: search’s tables first, then the ones they join', () => {
    const route = routeQuestionToAreas({ groups, question: 'pipeline opportunity', anchors: ['ins.mart_pipeline'], joins, budget: 1 });
    expect(route.relations).toEqual(['ins.mart_pipeline']);
  });

  it('routes nowhere when nothing matches, or there is one area to choose, so search chooses as before', () => {
    expect(routeQuestionToAreas({ groups, question: 'Weather in Lisbon', anchors: [], joins, budget: 30 })).toEqual({ groups: [], relations: [], shared: [], pool: [] });
    const finance = groups.filter((group) => group.key === 'domain:finance' || group.shared);
    expect(routeQuestionToAreas({ groups: finance, question: 'invoice payments', anchors: ['ins.fct_invoice'], joins, budget: 30 }).relations).toEqual([]);
  });
});

describe('inside an area too large to show whole (ask-area-ranking design, R2)', () => {
  // A 40-table Billing area, A to Z, and a small Sales area: the table that
  // answers the question is the 40th in file order and no search found it.
  const billing = Array.from({ length: 39 }, (_, index) => `fct_billing_${String(index).padStart(2, '0')}`);
  const large = {
    modeling: {
      packages: {},
      areas: { ...area('finance', 'billing', 'Billing'), ...area('sales_and_marketing', 'sales', 'Sales') },
      entities: {
        ...Object.assign({}, ...billing.map((table) => entity('finance', table, table, 'billing'))),
        ...entity('finance', 'zz_invoice_late_fees', 'zz_invoice_late_fees', 'billing'),
        ...entity('sales_and_marketing', 'opportunity', 'fct_opportunity', 'sales'),
      },
      relationships: {},
    },
  } as unknown as DQLManifest;
  const columns = (relation: string) => (relation.endsWith('zz_invoice_late_fees') ? ['invoice_id', 'late_fee_amount', 'billing_month'] : ['invoice_id', 'billing_month', 'amount']);
  const describe_ = (relation: string) => (relation.endsWith('zz_invoice_late_fees') ? 'Late fees charged on overdue invoices' : 'Billing lines');
  const largeGroups = modelAnswerGroups(large, relationOf, columns, describe_);

  it('cuts by the question\'s words, not file order', () => {
    const route = routeQuestionToAreas({ groups: largeGroups, question: 'How much did we charge in late fees on billing invoices last month?', anchors: [], joins: [], budget: 10 });
    expect(route.groups.map((group) => group.name)).toEqual(['Billing']);
    expect(route.pool).toHaveLength(40);
    expect(route.relations[0]).toBe('ins.zz_invoice_late_fees');
    expect(route.relations).toHaveLength(10);
  });

  it('puts the AI\'s picks first, then search\'s, then the words\' order', () => {
    const route = routeQuestionToAreas({ groups: largeGroups, question: 'billing late fees', anchors: ['ins.fct_billing_07'], joins: [], budget: 5, picks: ['ins.fct_billing_20', 'ins.not_in_the_area'] });
    expect(route.relations.slice(0, 3)).toEqual(['ins.fct_billing_20', 'ins.fct_billing_07', 'ins.zz_invoice_late_fees']);
  });

  it('weighs a word by how few tables have it, and keeps the list\'s order on a tie', () => {
    const texts: Record<string, string> = { a: 'invoice amount', b: 'invoice amount', c: 'invoice dunning amount', d: 'refund' };
    expect(rankByWords('dunning invoices', ['a', 'b', 'c', 'd'], (relation) => texts[relation]!)).toEqual(['c', 'a', 'b', 'd']);
    expect(rankByWords('weather', ['a', 'b'], (relation) => texts[relation]!)).toEqual(['a', 'b']);
  });
});
