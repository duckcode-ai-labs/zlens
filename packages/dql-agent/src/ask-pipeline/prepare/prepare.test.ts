import { describe, expect, it } from 'vitest';
import { extractBlockContract } from '../block-contract.js';
import { parseIntent, type AnalyticalIntentV1 } from '../intent.js';
import { physicalRelationBinding } from '../physical-binding.js';
import { validateIntentRefs } from '../resolve-intent.js';
import { buildVocabularyIndex, type VocabularySource } from '../vocabulary.js';
import { bindSemanticRequest, composeRelational, entails, prepare } from './index.js';
import { scopeFormulaAggregates } from './relational.js';
import { resolveTie } from '../execute.js';
import { prepareCertified } from './certified.js';
import { inlineSqlParams } from './dql-artifacts.js';
import type { PrepareDeps } from './types.js';

const source: VocabularySource = {
  metrics: [
    { name: 'revenue', model: 'order_item', aggregation: 'sum', expr: 'SUM(product_price)', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } },
    { name: 'drink_revenue', model: 'order_item', aggregation: 'sum', expr: 'SUM(case when is_drink_item then product_price else 0 end)', description: 'Revenue from drink items', physical: { relation: 'dev.order_items', expr: 'case when "dev"."order_items"."is_drink_item" then "dev"."order_items"."product_price" else 0 end', aggregate: 'sum' } },
    { name: 'order_total', model: 'orders', aggregation: 'sum', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_total"', aggregate: 'sum' } },
    { name: 'order_cost', model: 'orders', aggregation: 'sum', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_cost"', aggregate: 'sum' } },
    { name: 'order_gross_profit', model: 'order_item', type: 'derived', expr: 'revenue - cost', derived: { expr: 'revenue - cost', inputs: [{ alias: 'revenue', ref: 'metric:order_item.revenue' }, { alias: 'cost', ref: 'metric:orders.order_cost' }] } },
    { name: 'revenue_growth_mom', model: 'order_item', type: 'derived', expr: '(current_revenue - revenue_prev_month)*100/revenue_prev_month', engineOnly: 'a prior-period offset on revenue' },
  ],
  dimensions: [
    { name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } },
    { name: 'is_drink_item', model: 'order_item', dataType: 'boolean', physical: { relation: 'dev.order_items', column: 'is_drink_item' } },
    { name: 'ordered_at', model: 'order_item', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.order_items', column: 'ordered_at' } },
    { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.orders', column: 'ordered_at' } },
  ],
  entities: [
    { name: 'customer', model: 'customers', type: 'primary', physical: { relation: 'dev.customers', column: 'customer_id' } },
  ],
  blocks: [{
    name: 'top_beverage_customers', domain: 'commerce', certified: true, sql: 'SELECT customer_name, SUM(product_price) AS beverage_revenue FROM dev.order_items WHERE is_drink_item = true GROUP BY customer_name ORDER BY beverage_revenue DESC LIMIT 10',
    contract: extractBlockContract({ name: 'top_beverage_customers', sql: 'SELECT customer_name, SUM(product_price) AS beverage_revenue FROM dev.order_items WHERE is_drink_item = true GROUP BY customer_name ORDER BY beverage_revenue DESC LIMIT 10' }),
  }, {
    name: 'beverage_by_customer_id', domain: 'commerce', certified: true, sql: 'SELECT customer_id, SUM(product_price) AS beverage_revenue FROM dev.order_items WHERE is_drink_item = true GROUP BY customer_id ORDER BY beverage_revenue DESC LIMIT 10',
    contract: extractBlockContract({ name: 'beverage_by_customer_id', sql: 'SELECT customer_id, SUM(product_price) AS beverage_revenue FROM dev.order_items WHERE is_drink_item = true GROUP BY customer_id ORDER BY beverage_revenue DESC LIMIT 10' }),
  }],
};
const vocabulary = buildVocabularyIndex(source);

const joinPath: PrepareDeps['joinPath'] = (from, to) => {
  const edges: Record<string, Array<{ relation: string; on: string }>> = {
    'dev.order_items>dev.orders': [{ relation: 'dev.orders', on: '"dev"."order_items".order_id = "dev"."orders".order_id' }],
    'dev.order_items>dev.customers': [{ relation: 'dev.orders', on: '"dev"."order_items".order_id = "dev"."orders".order_id' }, { relation: 'dev.customers', on: '"dev"."orders".customer_id = "dev"."customers".customer_id' }],
    'dev.orders>dev.customers': [{ relation: 'dev.customers', on: '"dev"."orders".customer_id = "dev"."customers".customer_id' }],
  };
  return edges[`${from}>${to}`];
};
const deps: PrepareDeps = { joinPath, blockSql: (ref) => vocabulary.get(ref)?.sql };

const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
  const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'scalar', ...raw });
  if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.intent;
};

describe('certified entailment', () => {
  it('a block named by ref that groups by a label is not entailed: identity is never certified away', () => {
    const verdict = entails(vocabulary.get('block:commerce.top_beverage_customers')!, intent({ measures: [{ ref: 'block:commerce.top_beverage_customers' }], expectedShape: 'ranking' }), vocabulary);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.join(' ')).toMatch(/label.*no identity key.*composed by entity key/);
    const prepared = prepareCertified(intent({ measures: [{ ref: 'block:commerce.top_beverage_customers' }], expectedShape: 'ranking' }), vocabulary, deps);
    expect(prepared.candidates).toEqual([]);
    expect(prepared.refusals[0]).toMatchObject({ tier: 'certified', code: 'block_not_applicable', repairable: true });
    // The block is kept as a fallback: the answer of last resort, never a dead end.
    expect(prepared.fallbacks).toHaveLength(1);
    expect(prepared.fallbacks[0]!.proof.join(' ')).toMatch(/served as published because no keyed governed answer could be composed/);
  });
  it('preparation never chooses the label-only block itself: it is handed to the pipeline as the answer of last resort', async () => {
    const result = await prepare({ intent: intent({ measures: [{ ref: 'block:commerce.top_beverage_customers' }], expectedShape: 'ranking' }), vocabulary, deps });
    expect(result.chosen).toBeUndefined();
    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0]!.proof.join(' ')).toMatch(/no identity key.*served as published/);
    expect(result.refusals.some((refusal) => refusal.tier === 'certified' && /no identity key/.test(refusal.message) && refusal.repairable)).toBe(true);
  });
  it('a time window the block cannot bound is not entailed; one over an output column is applied with its bounds', () => {
    const window = { start: '2025-01-01', end: '2026-01-01', expression: 'in 2025' };
    const unbounded = entails(vocabulary.get('block:commerce.beverage_by_customer_id')!, intent({ measures: [{ ref: 'block:commerce.beverage_by_customer_id' }], expectedShape: 'ranking', time: { ref: 'dimension:order_item.ordered_at', window } }), vocabulary);
    expect(unbounded.ok).toBe(false);
    expect(unbounded.missing.join(' ')).toMatch(/no output for the time window 2025-01-01..2026-01-01/);
    const bounded = buildVocabularyIndex({ ...source, blocks: [{ name: 'daily_revenue', domain: 'commerce', certified: true, contract: extractBlockContract({ name: 'daily_revenue', domain: 'commerce', sql: 'SELECT ordered_at, SUM(order_total) AS gross_revenue FROM dev.orders GROUP BY ordered_at', declaredOutputs: ['ordered_at', 'gross_revenue'] }), sql: 'SELECT ordered_at, SUM(order_total) AS gross_revenue FROM dev.orders GROUP BY ordered_at' }] });
    const prepared = prepareCertified(intent({ measures: [{ ref: 'block:commerce.daily_revenue' }], expectedShape: 'trend', time: { ref: 'dimension:orders.ordered_at', window } }), bounded, { ...deps, blockSql: (ref) => bounded.get(ref)?.sql });
    expect(prepared.candidates).toHaveLength(1);
    expect(prepared.candidates[0]!.sql).toMatch(/block."ordered_at" >= \? AND block."ordered_at" < \?/);
    expect(prepared.candidates[0]!.params).toEqual(['2025-01-01', '2026-01-01']);
  });
  it('a label-grouped block matched only through its measures must prove identity', () => {
    const verdict = entails(vocabulary.get('block:commerce.top_beverage_customers')!, intent({ measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }] }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'measure:0', direction: 'desc' }, limit: 10, expectedShape: 'ranking' }), vocabulary);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.join(' ')).toMatch(/composed by entity key/);
  });
  it('a keyed block named exactly is entailed', () => {
    const verdict = entails(vocabulary.get('block:commerce.beverage_by_customer_id')!, intent({ measures: [{ ref: 'block:commerce.beverage_by_customer_id' }], expectedShape: 'ranking' }), vocabulary);
    expect(verdict.ok).toBe(true);
  });
  it('an intent with no measures never entails, and an extra filter the block cannot take refuses', () => {
    const block = vocabulary.get('block:commerce.beverage_by_customer_id')!;
    expect(entails(block, intent({ measures: [], display: ['dimension:customers.customer_name'], unresolved: [{ clause: 'x', options: [], material: false }] }), vocabulary).ok).toBe(false);
    expect(entails(block, intent({ measures: [{ ref: 'block:commerce.beverage_by_customer_id' }], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan Byrd'], source: 'question' }] }), vocabulary).missing.join(' ')).toMatch(/does not accept a filter/);
  });
});

describe('semantic binding', () => {
  it('maps metrics, key and label to model-scoped names and a literal to an equality filter', () => {
    const bound = bindSemanticRequest(intent({
      measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan byrd'], source: 'question' }], ordering: { ref: 'metric:order_item.drink_revenue', direction: 'desc' }, limit: 10, expectedShape: 'ranking',
    }), vocabulary);
    expect(bound.request).toEqual({
      metrics: ['drink_revenue'], dimensions: ['customers.customer', 'customers.customer_name'],
      filters: [{ dimension: 'customers.customer_name', operator: 'equals', values: ['Ryan byrd'] }], orderBy: [{ name: 'drink_revenue', direction: 'desc' }], limit: 10,
    });
  });
  it('a per-measure scope the metric does not embody is not semantic', () => {
    const bound = bindSemanticRequest(intent({ measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }] }] }), vocabulary);
    expect(bound.refusal?.code).toBe('measure_scope_not_expressible');
  });
  it('a yes/no flag is filtered with the literal its column accepts', () => {
    const flags = buildVocabularyIndex({ ...source, dimensions: [
      ...source.dimensions!,
      { name: 'has_refund', model: 'orders' },
      { name: 'is_gift', model: 'orders', dataType: 'integer' },
      { name: 'is_rush', model: 'orders', dataType: 'varchar' },
    ] });
    const filterFor = (ref: string, op: 'is_true' | 'is_false' | 'eq', values: Array<string | boolean> = []) => bindSemanticRequest(intent({ measures: [{ ref: 'metric:orders.order_total' }], filters: [{ ref, op, values, source: 'question' }] }), flags).request?.filters?.[0]?.values;
    // A flag of unknown type (a semantic-model constant 1) and an integer flag: '1'/'0', never 'true'.
    expect(filterFor('dimension:orders.has_refund', 'is_true')).toEqual(['1']);
    expect(filterFor('dimension:orders.is_gift', 'is_false')).toEqual(['0']);
    expect(filterFor('dimension:orders.is_gift', 'eq', [true])).toEqual(['1']);
    // A boolean column and a text column keep the words.
    expect(filterFor('dimension:order_item.is_drink_item', 'is_true')).toEqual(['true']);
    expect(filterFor('dimension:orders.is_rush', 'eq', ['true'])).toEqual(['true']);
  });
  it('a second date breakdown is grouped too, never dropped; one at another grain refuses the tier', () => {
    const byDay = bindSemanticRequest(intent({
      measures: [{ ref: 'metric:order_item.revenue' }], expectedShape: 'table',
      groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'day' }, { ref: 'dimension:orders.ordered_at', role: 'time', grain: 'day' }],
    }), vocabulary);
    expect(byDay.refusal).toBeUndefined();
    expect(byDay.request?.timeDimension).toEqual({ name: 'order_item.ordered_at', granularity: 'day' });
    expect(byDay.request?.dimensions).toEqual(['orders.ordered_at']);
    const mixed = bindSemanticRequest(intent({
      measures: [{ ref: 'metric:order_item.revenue' }], expectedShape: 'table',
      groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'day' }, { ref: 'dimension:orders.ordered_at', role: 'time', grain: 'month' }],
    }), vocabulary);
    expect(mixed.request).toBeUndefined();
    expect(mixed.refusal).toMatchObject({ tier: 'semantic', code: 'not_semantic' });
    expect(mixed.refusal?.message).toMatch(/one time axis.*orders\.ordered_at by month/);
  });
});

describe('relational composition', () => {
  it('composes a keyed ranking with the label displayed, joined along governed paths, with a boolean scope', () => {
    const composed = composeRelational(intent({
      measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'eq', values: ['true'], source: 'question' }] }],
      groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      ordering: { ref: 'measure:0', direction: 'desc' }, limit: 10, expectedShape: 'ranking',
    }), vocabulary, deps);
    expect(composed.candidate?.sql).toContain('JOIN "dev"."customers"');
    expect(composed.candidate?.sql).toContain('"is_drink_item" = TRUE');
    expect(composed.candidate?.sql).toMatch(/GROUP BY "dev"\."customers"\."customer_id", "dev"\."customers"\."customer_name"/);
    expect(composed.candidate?.sql).toMatch(/ORDER BY "revenue" DESC\nLIMIT 10$/);
  });
  it('measures on different fact grains become aggregate islands joined on the keys', () => {
    const composed = composeRelational(intent({
      measures: [{ ref: 'metric:orders.order_total' }, { ref: 'metric:order_item.drink_revenue' }],
      filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan byrd'], source: 'question' }], expectedShape: 'comparison',
    }), vocabulary, deps);
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/^WITH island_1 AS/);
    expect(sql).toContain('island_2');
    expect(sql).toContain('CROSS JOIN');
    expect(sql).not.toMatch(/FROM "dev"\."orders"\nJOIN "dev"\."order_items"/);
    expect(composed.candidate!.params).toEqual(['ryan byrd', 'ryan byrd']);
    expect(composed.candidate!.proof[0]).toMatch(/aggregate islands/);
  });
  it('a time window without an axis is refused, never dropped', () => {
    const composed = composeRelational(intent({ measures: [{ ref: 'metric:orders.order_total' }], expectedShape: 'scalar', time: { window: { start: '2031-01-01', end: '2032-01-01' } } }), vocabulary, deps);
    expect(composed.candidate).toBeUndefined();
    expect(composed.refusal?.code).toBe('not_relational');
    expect(composed.refusal?.message).toMatch(/names no time dimension/);
    const bound = composeRelational(intent({ measures: [{ ref: 'metric:order_item.revenue' }], expectedShape: 'scalar', time: { ref: 'dimension:order_item.ordered_at', window: { start: '2031-01-01', end: '2032-01-01' } } }), vocabulary, deps);
    expect(bound.candidate?.params).toEqual(['2031-01-01', '2032-01-01']);
  });
  it('a governed composition carries its DQL: the statement with its bound values written in', () => {
    const bound = composeRelational(intent({ measures: [{ ref: 'metric:order_item.revenue' }], expectedShape: 'scalar', time: { ref: 'dimension:order_item.ordered_at', window: { start: '2031-01-01', end: '2032-01-01' } } }), vocabulary, deps);
    const artifact = bound.candidate?.artifact as { kind: string; trustState: string; source: string; compiledSql: string } | undefined;
    expect(artifact).toMatchObject({ kind: 'sql_block', trustState: 'governed', persistence: 'transient', compiledSql: bound.candidate!.sql });
    expect(artifact!.source).toContain("'2031-01-01'");
    expect(artifact!.source).toContain("'2032-01-01'");
    expect(artifact!.source).not.toContain('?');
    // A ? inside a literal or identifier is text; a count that disagrees writes no block.
    expect(inlineSqlParams(`SELECT 'why?' AS "q?" FROM t WHERE a = ? AND b = ?`, ["O'Neal", 3])).toBe(`SELECT 'why?' AS "q?" FROM t WHERE a = 'O''Neal' AND b = 3`);
    expect(inlineSqlParams('SELECT 1 WHERE a = ?', [])).toBeUndefined();
    expect(inlineSqlParams('SELECT 1', ['extra'])).toBeUndefined();
  });
  it('refuses when no governed join path reaches a relation', () => {
    const composed = composeRelational(intent({ measures: [{ ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'dimension:order_item.is_drink_item', role: 'categorical' }], expectedShape: 'grouped' }), vocabulary, { ...deps, joinPath: () => undefined });
    expect(composed.refusal?.code).toBe('join_path_required');
  });
});

describe('prepare order', () => {
  it('a refused block falls to semantic, and nothing governed after that: raw tables are for AI-written SQL', async () => {
    const result = await prepare({
      intent: intent({ measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }] }], expectedShape: 'scalar' }),
      vocabulary, deps: { ...deps, compileSemantic: async () => { throw new Error('should not compile a scoped measure'); } },
    });
    expect(result.attempts.map((attempt) => `${attempt.tier}:${attempt.outcome}`)).toEqual(['certified:refused', 'semantic:refused', 'exploratory:refused']);
    expect(result.chosen).toBeUndefined();
    const gap = await prepare({ intent: intent({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_name', role: 'categorical' }], expectedShape: 'grouped' }), vocabulary, deps: { compileSemantic: async () => { throw new Error('Dimension customer_name is not reachable from order_item'); } } });
    expect(gap.chosen).toBeUndefined();
    expect(gap.refusals.map((refusal) => refusal.code)).toEqual(['block_not_applicable', 'semantic_compile_failed', 'exploration_not_opted_in']);
    expect(gap.refusals[1]!.message).toBe('Dimension customer_name is not reachable from order_item');
  });
});

describe('a change between two periods\' rates (item 5 of the NBA validation)', () => {
  it('composes a scoped ratio per period, a threshold on each period\'s count, and ranks by their difference', () => {
    const year = (from: string, to: string) => [{ ref: 'dimension:order_item.ordered_at', op: 'gte', values: [from], source: 'question' }, { ref: 'dimension:order_item.ordered_at', op: 'lt', values: [to], source: 'question' }] as const;
    const composed = composeRelational(intent({
      measures: [
        { ref: 'metric:order_item.revenue', aggregation: 'count', scope: [...year('2024-01-01', '2025-01-01')], alias: 'orders_2024' },
        { ref: 'metric:order_item.revenue', aggregation: 'count', scope: [...year('2025-01-01', '2026-01-01')], alias: 'orders_2025' },
        { derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:order_item.revenue', numeratorAggregation: 'sum', denominatorAggregation: 'count' }, scope: [...year('2024-01-01', '2025-01-01')], alias: 'rate_2024' },
        { derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:order_item.revenue', numeratorAggregation: 'sum', denominatorAggregation: 'count' }, scope: [...year('2025-01-01', '2026-01-01')], alias: 'rate_2025' },
        { change: { base: 'rate_2024', comparison: 'rate_2025', as: 'absolute' }, alias: 'rate_change' },
      ],
      groupBy: [{ ref: 'entity:customers.customer', role: 'key' }],
      filters: [{ ref: 'measure:0', op: 'gte', values: [20], source: 'question', on: 'aggregate' }, { ref: 'measure:1', op: 'gte', values: [20], source: 'question', on: 'aggregate' }],
      ordering: { ref: 'measure:4', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
    }), vocabulary, deps);
    expect(composed.refusal).toBeUndefined();
    const sql = composed.candidate!.sql;
    expect(composed.candidate!.columns).toEqual(expect.arrayContaining(['orders_2024', 'orders_2025', 'rate_2024', 'rate_2025', 'rate_change']));
    // The change subtracts the two computed ratios, not two columns that do not exist.
    expect(sql).toMatch(/NULLIF\(.*\) - \(.*NULLIF|\(\(.*NULLIF.*\) - \(.*NULLIF/);
    expect(sql).toContain('AS "rate_change"');
    expect(sql).toMatch(/"orders_2024" >= \?/);
    expect(sql).toMatch(/"orders_2025" >= \?/);
    expect(sql).toMatch(/ORDER BY "rate_change" DESC/);
  });
});

describe('relational ratio and population', () => {
  const ratio = (extra: Record<string, unknown> = {}) => intent({
    measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.order_total' }, alias: 'revenue_share' }],
    expectedShape: 'scalar', ...extra,
  });
  it('a ratio of two measures on different grains divides the islands, never the rows', () => {
    const composed = composeRelational(ratio(), vocabulary, deps);
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/^WITH island_1 AS/);
    expect(sql).toContain('SUM("dev"."order_items"."product_price") AS "__num_1"');
    expect(sql).toContain('SUM("dev"."orders"."order_total") AS "__den_1"');
    expect(sql).toMatch(/CAST\(island_1\."__num_1" AS DOUBLE\) \/ NULLIF\(CAST\(island_2\."__den_1" AS DOUBLE\), 0\) AS "revenue_share"/);
    expect(composed.candidate!.columns).toEqual(['revenue_share']);
    expect(composed.candidate!.proof.join(' ')).toMatch(/revenue_share = .* \/ .*, divided after each part is aggregated/);
  });
  it('a window binds to each island\'s own same-named time column, never through a multiplying join', () => {
    const composed = composeRelational(ratio({ time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-01-01', end: '2026-01-01' } } }), vocabulary, { ...deps, joinPath: () => { throw new Error('no join should be needed'); } });
    const sql = composed.candidate!.sql;
    expect(sql).toContain('WHERE "dev"."order_items"."ordered_at" >= ? AND "dev"."order_items"."ordered_at" < ?');
    expect(sql).toContain('WHERE "dev"."orders"."ordered_at" >= ? AND "dev"."orders"."ordered_at" < ?');
    expect(composed.candidate!.params).toEqual(['2025-01-01', '2026-01-01', '2025-01-01', '2026-01-01']);
  });
  it('a single-island ratio is wrapped so the projection can order by it', () => {
    const composed = composeRelational(intent({
      measures: [{ ref: 'metric:order_item.revenue' }, { derived: { kind: 'ratio', numerator: 'metric:order_item.drink_revenue', denominator: 'metric:order_item.revenue' }, alias: 'drink_share' }],
      groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'measure:1', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
    }), vocabulary, deps);
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/^WITH island_1 AS/);
    expect(sql).toMatch(/island_1\."customer_id" AS "customer_id", island_1\."customer_name" AS "customer_name", island_1\."revenue" AS "revenue", CAST\(island_1\."__num_2" AS DOUBLE\) \/ NULLIF\(CAST\(island_1\."__den_2" AS DOUBLE\), 0\) AS "drink_share"/);
    expect(sql).toMatch(/ORDER BY "drink_share" DESC\nLIMIT 5$/);
  });
  it('population "all" enumerates every member from the entity relation and zero-fills additive measures only', () => {
    const source: VocabularySource = {
      metrics: [
        { name: 'order_total', model: 'orders', aggregation: 'sum', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_total"', aggregate: 'sum' } },
        { name: 'avg_order', model: 'orders', aggregation: 'avg', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_total"', aggregate: 'avg' } },
      ],
      entities: [{ name: 'location', model: 'locations', type: 'primary', physical: { relation: 'dev.locations', column: 'location_id' } }],
      dimensions: [
        { name: 'location_name', model: 'locations', dataType: 'string', physical: { relation: 'dev.locations', column: 'location_name' } },
        { name: 'customer_type', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_type' } },
      ],
    };
    const local = buildVocabularyIndex(source);
    const paths: PrepareDeps['joinPath'] = (from, to) => from === 'dev.orders' && to === 'dev.locations' ? [{ relation: 'dev.locations', on: '"dev"."orders".location_id = "dev"."locations".location_id' }] : undefined;
    const composed = composeRelational(intent({
      measures: [{ ref: 'metric:orders.order_total' }, { ref: 'metric:orders.avg_order' }], groupBy: [{ ref: 'entity:locations.location', role: 'key' }], display: ['dimension:locations.location_name'],
      filters: [{ ref: 'dimension:locations.location_name', op: 'neq', values: ['Closed'], source: 'question' }], population: 'all', expectedShape: 'grouped', ordering: { ref: 'measure:0', direction: 'desc' },
    }), local, { joinPath: paths });
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/^WITH population AS \(\nSELECT DISTINCT "dev"\."locations"\."location_id" AS "location_id", "dev"\."locations"\."location_name" AS "location_name"\nFROM "dev"\."locations"\nWHERE "dev"\."locations"\."location_name" <> \?\n\)/);
    expect(sql).toContain('LEFT JOIN island_1 ON population."location_id" = island_1."location_id" AND population."location_name" = island_1."location_name"');
    expect(sql).toContain('COALESCE(island_1."order_total", 0) AS "order_total", island_1."avg_order" AS "avg_order"');
    expect(sql).toMatch(/ORDER BY "order_total" DESC$/);
    expect(composed.candidate!.params).toEqual(['Closed', 'Closed']);
    expect(composed.candidate!.proof[0]).toMatch(/every member of dev\.locations is a row .* order_total read 0 where nothing matched; avg_order stay null/);
    const timed = composeRelational(intent({ measures: [{ ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'entity:locations.location', role: 'key' }, { ref: 'dimension:customers.customer_type', role: 'categorical' }], population: 'all', expectedShape: 'grouped' }), local, { joinPath: paths });
    expect(timed.refusal?.message).toMatch(/live elsewhere/);
  });
  it('a certified block never serves a ratio or a population', () => {
    const block = vocabulary.get('block:commerce.beverage_by_customer_id')!;
    expect(entails(block, intent({ measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.order_total' } }] }), vocabulary).missing[0]).toMatch(/derived ratio/);
    expect(entails(block, intent({ measures: [{ ref: 'block:commerce.beverage_by_customer_id' }], population: 'all' }), vocabulary).missing[0]).toMatch(/every member/);
  });
});

describe('derived metrics across relations', () => {
  it('a derived formula over two relations is evaluated after each input is aggregated on its own island', () => {
    const composed = composeRelational(intent({ measures: [{ ref: 'metric:order_item.order_gross_profit' }], expectedShape: 'scalar', time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-01-01', end: '2026-01-01' } } }), vocabulary, deps);
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/^WITH island_1 AS/);
    expect(sql).toContain('SUM("dev"."order_items"."product_price") AS "__in_1_revenue"');
    expect(sql).toContain('SUM("dev"."orders"."order_cost") AS "__in_1_cost"');
    expect(sql).toContain('(CAST(island_1."__in_1_revenue" AS DOUBLE) - CAST(island_2."__in_1_cost" AS DOUBLE)) AS "order_gross_profit"');
    expect(sql).toContain('WHERE "dev"."orders"."ordered_at" >= ? AND "dev"."orders"."ordered_at" < ?');
    expect(composed.candidate!.proof.join(' ')).toMatch(/order_gross_profit = revenue - cost, with revenue = .* on dev\.order_items, cost = .* on dev\.orders/);
  });
  it('a ratio whose numerator is a derived formula composes through the same islands, divisors guarded', () => {
    const composed = composeRelational(intent({ measures: [{ ref: 'metric:order_item.order_gross_profit' }, { derived: { kind: 'ratio', numerator: 'metric:order_item.order_gross_profit', denominator: 'metric:order_item.revenue' }, alias: 'gross_margin' }], expectedShape: 'comparison' }), vocabulary, deps);
    const sql = composed.candidate!.sql;
    expect(sql).toContain('(CAST(island_1."__num_2_revenue" AS DOUBLE) - CAST(island_2."__num_2_cost" AS DOUBLE)) / NULLIF(CAST(island_1."__den_2" AS DOUBLE), 0) AS "gross_margin"');
    expect(composed.candidate!.columns).toEqual(['order_gross_profit', 'gross_margin']);
  });
  it('a metric the semantic engine alone can compute is refused with its reason, never approximated', () => {
    const composed = composeRelational(intent({ measures: [{ ref: 'metric:order_item.revenue_growth_mom' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }], expectedShape: 'trend' }), vocabulary, deps);
    expect(composed.candidate).toBeUndefined();
    expect(composed.refusal?.message).toMatch(/needs the semantic engine: a prior-period offset on revenue; the relational tier will not approximate it/);
  });
});

describe('a certified block runs through the prepared-block contract', () => {
  const keyed = intent({ measures: [{ ref: 'block:commerce.beverage_by_customer_id' }], expectedShape: 'ranking' });
  it('the compiled SQL and bound parameters are the candidate; applied predicates continue the numbering', () => {
    const prepared = prepareCertified(keyed, vocabulary, { ...deps, prepareBlock: () => ({ sql: 'SELECT customer_id, SUM(product_price) AS beverage_revenue FROM dev.order_items WHERE year BETWEEN $1 AND $2 GROUP BY customer_id LIMIT $3', params: [2016, 2017, 10], parameters: [{ name: 'season_start', position: 1, value: 2016, source: 'default' }, { name: 'season_end', position: 2, value: 2017, source: 'default' }, { name: 'top_n', position: 3, value: 10, source: 'question' }] }) });
    expect(prepared.candidates).toHaveLength(1);
    expect(prepared.candidates[0]!.sql).toMatch(/BETWEEN \$1 AND \$2/);
    expect(prepared.candidates[0]!.params).toEqual([2016, 2017, 10]);
    expect(prepared.candidates[0]!.proof.join(' ')).toMatch(/parameters bound: season_start = 2016 \(default\)/);
  });
  it('the answer carries the certified block as the DQL it ran, with the compiled SQL beside it', () => {
    const source = 'block "beverage_by_customer_id" {\n  type = "custom"\n  status = "certified"\n  query = """SELECT customer_id FROM dev.order_items"""\n}';
    const prepared = prepareCertified(keyed, vocabulary, { ...deps, prepareBlock: () => ({ sql: 'SELECT customer_id FROM dev.order_items', params: [], parameters: [], source, sourcePath: 'blocks/beverage_by_customer_id.dql' }) });
    expect(prepared.candidates[0]!.artifact).toEqual({ kind: 'certified_block', name: 'beverage_by_customer_id', source, sourcePath: 'blocks/beverage_by_customer_id.dql', persistence: 'saved', trustState: 'certified', compiledSql: 'SELECT customer_id FROM dev.order_items' });
  });
  it('unbound parameters refuse before SQL; a raw block with template parameters is never executed', () => {
    const unbound = prepareCertified(keyed, vocabulary, { ...deps, prepareBlock: () => ({ error: 'it still needs values for region', unresolved: ['region'] }) });
    expect(unbound.candidates).toEqual([]);
    expect(unbound.refusals[0]!.message).toMatch(/parameters could not be bound: it still needs values for region/);
    const raw = prepareCertified(keyed, vocabulary, { ...deps, blockSql: () => 'SELECT customer_id FROM dev.order_items LIMIT ${top_n}' });
    expect(raw.candidates).toEqual([]);
    expect(raw.refusals[0]!.message).toMatch(/template parameters that this host does not bind/);
  });
});

describe('a ratio over physical columns with a threshold on the aggregate', () => {
  const nba = buildVocabularyIndex({
    dimensions: [
      { name: 'player_id', model: 'player_game_stats', dataType: 'string', physical: { relation: 'dev.player_game_stats', column: 'player_id' } },
      { name: 'player_name', model: 'player_game_stats', dataType: 'string', physical: { relation: 'dev.player_game_stats', column: 'player_name' } },
      { name: 'game_date', model: 'player_game_stats', dataType: 'date', isTime: true, physical: { relation: 'dev.player_game_stats', column: 'game_date' } },
    ],
    relations: [{ schema: 'dev', name: 'player_game_stats', columns: [{ name: 'player_id', dataType: 'VARCHAR' }, { name: 'player_name', dataType: 'VARCHAR' }, { name: 'game_id', dataType: 'VARCHAR' }, { name: 'pts', dataType: 'DOUBLE' }, { name: 'played', dataType: 'INTEGER' }, { name: 'game_date', dataType: 'DATE' }] }],
  });
  const ppg = intent({
    measures: [
      { alias: 'games_played', ref: 'column:dev.player_game_stats.played', aggregation: 'sum' },
      { alias: 'points_per_game', derived: { kind: 'ratio', numerator: 'column:dev.player_game_stats.pts', numeratorAggregation: 'sum', denominator: 'column:dev.player_game_stats.played', denominatorAggregation: 'sum' } },
    ],
    groupBy: [{ ref: 'dimension:player_game_stats.player_id', role: 'key' }], display: ['dimension:player_game_stats.player_name'],
    filters: [{ ref: 'measure:0', op: 'gte', values: [20], source: 'question' }],
    ordering: { ref: 'measure:1', direction: 'desc' }, limit: 10, expectedShape: 'ranking',
  });
  it('composes both parts as island aggregates, divides with NULLIF, and applies the threshold after aggregation', () => {
    const composed = composeRelational(ppg, nba, { ...deps, joinPath: () => [] });
    expect(composed.refusal).toBeUndefined();
    const sql = composed.candidate!.sql;
    expect(sql).toMatch(/SUM\("dev"."player_game_stats"."pts"\) AS "__num_2"/);
    expect(sql).toMatch(/SUM\("dev"."player_game_stats"."played"\) AS "__den_2"/);
    expect(sql).toMatch(/NULLIF\(CAST\(island_1."__den_2" AS DOUBLE\), 0\) AS "points_per_game"/);
    expect(sql).toMatch(/SELECT \* FROM \(\n[\s\S]*\) AS aggregated\nWHERE "games_played" >= \?\nORDER BY "points_per_game" DESC/);
    expect(composed.candidate!.params?.at(-1)).toBe(20);
    expect(composed.candidate!.proof.join(' ')).toMatch(/applied after aggregation: games_played gte 20/);
  });
  it('a scoped measure beside a window and a member filter binds its parameters in text order: scope, filters, window', () => {
    const composed = composeRelational(intent({
      measures: [
        { alias: 'total_points', ref: 'column:dev.player_game_stats.pts', aggregation: 'sum' },
        { alias: 'games_played', ref: 'column:dev.player_game_stats.game_id', aggregation: 'count_distinct', scope: [{ ref: 'column:dev.player_game_stats.played', op: 'eq', values: [1], source: 'question' }] },
      ],
      groupBy: [{ ref: 'dimension:player_game_stats.player_id', role: 'key' }], display: ['dimension:player_game_stats.player_name'],
      filters: [{ ref: 'dimension:player_game_stats.player_name', op: 'in', values: ['LeBron James', 'Stephen Curry'], source: 'question' }],
      time: { ref: 'dimension:player_game_stats.game_date', window: { start: '2017-01-01', end: '2018-01-01' } }, expectedShape: 'comparison',
    }), nba, { ...deps, joinPath: () => [] });
    expect(composed.refusal).toBeUndefined();
    const sql = composed.candidate!.sql;
    expect(sql.indexOf('"played" = ?')).toBeLessThan(sql.indexOf('"player_name" IN'));
    expect(sql.indexOf('"player_name" IN')).toBeLessThan(sql.indexOf('"game_date" >= ?'));
    expect(composed.candidate!.params).toEqual([1, 'LeBron James', 'Stephen Curry', '2017-01-01', '2018-01-01']);
  });
  it('the validator reads column parts through their aggregation and a threshold by alias as the measure', () => {
    const raw = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ alias: 'games_played', ref: 'column:dev.player_game_stats.played', aggregation: 'sum' }, { alias: 'points_per_game', derived: { kind: 'ratio', numerator: 'column:dev.player_game_stats.pts', numeratorAggregation: 'sum', denominator: 'column:dev.player_game_stats.played', denominatorAggregation: 'sum' } }], groupBy: [{ ref: 'dimension:player_game_stats.player_id', role: 'key' }], display: [], filters: [{ ref: 'games_played', op: 'gte', values: [20], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'ranking' }).intent!;
    const validation = validateIntentRefs(raw, nba);
    expect(validation.problems).toEqual([]);
    expect(validation.intent.filters[0]).toMatchObject({ ref: 'measure:0', on: 'aggregate' });
    const bare = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ alias: 'ppg', derived: { kind: 'ratio', numerator: 'column:dev.player_game_stats.pts', denominator: 'column:dev.player_game_stats.played' } }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(validateIntentRefs(bare, nba).problems.map((problem) => problem.message)).toEqual([expect.stringMatching(/needs numeratorAggregation/), expect.stringMatching(/needs numeratorAggregation/)]);
  });
});

describe('predicates compile against the column\'s type', () => {
  const typed = buildVocabularyIndex({
    dimensions: [
      { name: 'season', model: 'journey', dataType: 'INTEGER', physical: { relation: 'dev.journey', column: 'season' } },
      { name: 'player_name', model: 'journey', dataType: 'VARCHAR', physical: { relation: 'dev.journey', column: 'player_name' } },
      { name: 'points', model: 'journey', dataType: 'DOUBLE', physical: { relation: 'dev.journey', column: 'points' } },
    ],
    relations: [{ schema: 'dev', name: 'journey', columns: [{ name: 'season', dataType: 'INTEGER' }, { name: 'player_name', dataType: 'VARCHAR' }, { name: 'points', dataType: 'DOUBLE' }] }],
  });
  const compose = (filters: unknown[]) => composeRelational(intent({
    measures: [{ ref: 'column:dev.journey.points', aggregation: 'sum', alias: 'total_points' }],
    groupBy: [{ ref: 'dimension:journey.player_name', role: 'categorical' }], filters: filters as never, expectedShape: 'ranking',
  }), typed, { ...deps, joinPath: () => [] });
  it('a year written as a string against an integer column is a typed equality, never LOWER(INTEGER)', () => {
    const composed = compose([{ ref: 'dimension:journey.season', op: 'eq', values: ['2017'], source: 'question' }]);
    expect(composed.refusal).toBeUndefined();
    expect(composed.candidate!.sql).toContain('"dev"."journey"."season" = ?');
    expect(composed.candidate!.sql).not.toMatch(/LOWER\("dev"\."journey"\."season"\)/);
    expect(composed.candidate!.params).toEqual([2017]);
  });
  it('text equality stays case-insensitive, and every operator respects the type', () => {
    const text = compose([{ ref: 'dimension:journey.player_name', op: 'eq', values: ['ryan byrd'], source: 'question' }]);
    expect(text.candidate!.sql).toContain('LOWER("dev"."journey"."player_name") = ?');
    const inList = compose([{ ref: 'dimension:journey.season', op: 'in', values: ['2016', '2017'], source: 'question' }]);
    expect(inList.candidate!.params).toEqual([2016, 2017]);
    const bound = compose([{ ref: 'dimension:journey.season', op: 'gte', values: ['2016'], source: 'question' }]);
    expect(bound.candidate!.params).toEqual([2016]);
    const like = compose([{ ref: 'dimension:journey.season', op: 'contains', values: ['201'], source: 'question' }]);
    expect(like.candidate!.sql).toContain('LOWER(CAST("dev"."journey"."season" AS VARCHAR)) LIKE ?');
  });
});

describe('a share of the whole period divides by an ungrouped denominator', () => {
  const nba = buildVocabularyIndex({
    metrics: [{ name: 'total_points', aggregation: 'sum', physical: { relation: 'dev.season_facts', expr: '"dev"."season_facts"."total_points"', aggregate: 'sum' } }],
    dimensions: [
      { name: 'player_id', model: 'season_facts', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'player_id' } },
      { name: 'season', model: 'season_facts', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'season' } },
    ],
    relations: [{ schema: 'dev', name: 'season_facts', columns: [{ name: 'player_id', dataType: 'INTEGER' }, { name: 'season', dataType: 'INTEGER' }, { name: 'total_points', dataType: 'INTEGER' }] }],
  });
  it('the denominator island has no GROUP BY, shares the filters, and is summed before the limit', () => {
    const composed = composeRelational(intent({
      measures: [
        { ref: 'metric:total_points', alias: 'total_points' },
        { alias: 'share_of_points', derived: { kind: 'ratio', numerator: 'metric:total_points', denominator: 'metric:total_points', denominatorScope: 'overall' } },
      ],
      groupBy: [{ ref: 'dimension:season_facts.player_id', role: 'key' }],
      filters: [{ ref: 'dimension:season_facts.season', op: 'eq', values: ['2017'], source: 'question' }],
      ordering: { ref: 'measure:0', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
    }), nba, { ...deps, joinPath: () => [] });
    expect(composed.refusal).toBeUndefined();
    const sql = composed.candidate!.sql;
    // Two islands on one relation: the grouped one and the overall one.
    expect(sql).toMatch(/island_1 AS \(\nSELECT "dev"\."season_facts"\."player_id" AS "player_id"[\s\S]*GROUP BY "dev"\."season_facts"\."player_id"\n\)/);
    expect(sql).toMatch(/island_2 AS \(\nSELECT SUM\("dev"\."season_facts"\."total_points"\) AS "__den_2"\nFROM "dev"\."season_facts"\nWHERE "dev"\."season_facts"\."season" = \?\n\)/);
    expect(sql).toMatch(/FROM island_1\nCROSS JOIN island_2/);
    expect(sql).toMatch(/CAST\(island_1\."__num_2" AS DOUBLE\) \/ NULLIF\(CAST\(island_2\."__den_2" AS DOUBLE\), 0\) AS "share_of_points"/);
    expect(sql).toMatch(/ORDER BY "total_points" DESC\nLIMIT 5$/);
    // The season filter binds once per island, as a number.
    expect(composed.candidate!.params).toEqual([2017, 2017]);
    expect(composed.candidate!.proof.join(' ')).toMatch(/over every row of the period/);
  });
  it('a native `number` type is numeric, not text', () => {
    const composed = composeRelational(intent({
      measures: [{ ref: 'metric:total_points' }], filters: [{ ref: 'dimension:season_facts.season', op: 'eq', values: ['2017'], source: 'question' }], expectedShape: 'scalar',
    }), nba, { ...deps, joinPath: () => [] });
    expect(composed.candidate!.sql).not.toMatch(/LOWER/);
    expect(composed.candidate!.params).toEqual([2017]);
  });
});

describe('the identity lives where the facts live', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'points_scored', label: 'Points scored', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: '"dev"."game_facts"."points"', aggregate: 'sum' } }],
    dimensions: [
      { name: 'player', model: 'season_facts', label: 'Player', dataType: 'string', physical: { relation: 'dev.season_facts', column: 'player_name' } },
      { name: 'nickname', model: 'teams', label: 'Team nickname', dataType: 'string', physical: { relation: 'dev.teams', column: 'team_nickname' } },
    ],
    relations: [
      { schema: 'dev', name: 'game_facts', columns: [{ name: 'player_name', dataType: 'VARCHAR' }, { name: 'points', dataType: 'INTEGER' }] },
      { schema: 'dev', name: 'season_facts', columns: [{ name: 'player_name', dataType: 'VARCHAR' }] },
      { schema: 'dev', name: 'teams', columns: [{ name: 'team_nickname', dataType: 'VARCHAR' }] },
    ],
  });
  const reading = (ref: string): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'points by player', measures: [{ ref: 'metric:points_scored' }],
    groupBy: [{ ref, role: 'key' }], display: [], filters: [], expectedShape: 'grouped', unresolved: [], provenance: {},
  });
  const noJoins: PrepareDeps = { blockSql: () => undefined };

  it('reads a field of another relation from the same column on the relation it measures, and says so', () => {
    const prepared = composeRelational(reading('dimension:season_facts.player'), vocabulary, noJoins);
    expect(prepared.refusal).toBeUndefined();
    expect(prepared.candidate!.sql).toContain('"dev"."game_facts"."player_name"');
    expect(prepared.candidate!.sql).not.toContain('season_facts');
    expect(prepared.candidate!.proof.join(' ')).toContain('read from dev.game_facts.player_name');
  });

  it('refuses when the column simply does not exist there, instead of substituting a similar name', () => {
    const prepared = composeRelational(reading('dimension:teams.nickname'), vocabulary, noJoins);
    expect(prepared.candidate).toBeUndefined();
    expect(prepared.refusal?.code).toBe('join_path_required');
  });
});

describe('what changed between two periods', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'points_scored', label: 'Points scored', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: '"dev"."game_facts"."points"', aggregate: 'sum' } }],
    dimensions: [{ name: 'game_date', model: 'game_facts', dataType: 'date', isTime: true, physical: { relation: 'dev.game_facts', column: 'game_date' } }],
    relations: [{ schema: 'dev', name: 'game_facts', columns: [{ name: 'points' }, { name: 'game_date', dataType: 'DATE' }] }],
  });
  const scoped = (alias: string, start: string, end: string): AnalyticalIntentV1['measures'][number] => ({
    ref: 'metric:points_scored', alias,
    scope: [
      { ref: 'dimension:game_facts.game_date', op: 'gte', values: [start], source: 'question' },
      { ref: 'dimension:game_facts.game_date', op: 'lt', values: [end], source: 'question' },
    ],
  });
  const reading = (measures: AnalyticalIntentV1['measures']): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'points 2016 versus 2017', measures, groupBy: [], display: [], filters: [],
    expectedShape: 'comparison', unresolved: [], provenance: {},
  });

  it('computes the difference between the two measures it names, as a fraction of the earlier one', () => {
    const prepared = composeRelational(reading([
      scoped('points_2016', '2016-01-01', '2017-01-01'),
      scoped('points_2017', '2017-01-01', '2018-01-01'),
      { ref: 'change:points_2017-points_2016', alias: 'points_change_pct', change: { base: 'points_2016', comparison: 'points_2017', as: 'percent' } },
    ]), vocabulary, { blockSql: () => undefined });
    expect(prepared.refusal).toBeUndefined();
    expect(prepared.candidate!.sql).toContain('NULLIF(CAST(island_1."points_2016" AS DOUBLE), 0)');
    expect(prepared.candidate!.sql).toContain('AS "points_change_pct"');
    expect(prepared.candidate!.proof.join(' ')).toContain('points_change_pct = points_2017 - points_2016');
  });

  it('refuses a change whose parts this reading does not project', () => {
    const prepared = composeRelational(reading([
      scoped('points_2016', '2016-01-01', '2017-01-01'),
      { ref: 'change:points_2017-points_2016', alias: 'points_change', change: { base: 'points_2016', comparison: 'points_2017', as: 'absolute' } },
    ]), vocabulary, { blockSql: () => undefined });
    expect(prepared.candidate).toBeUndefined();
    expect(prepared.refusal?.message).toContain('no measure aliased points_2017');
  });

  it('refuses to take the first N rows of an unordered reading', () => {
    const unordered: AnalyticalIntentV1 = { ...reading([scoped('points_2017', '2017-01-01', '2018-01-01')]), expectedShape: 'ranking', limit: 5 };
    expect(composeRelational(unordered, vocabulary, { blockSql: () => undefined }).refusal?.message).toContain('arbitrary');
    // A lookup asks for a few rows, not for the best ones.
    expect(composeRelational({ ...unordered, expectedShape: 'lookup' }, vocabulary, { blockSql: () => undefined }).refusal).toBeUndefined();
  });
});

describe('a stored rate carries its own period', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [
      // A native formula metric: one expression, two aggregates inside it.
      { name: 'points_per_game', label: 'Points per game', physical: { relation: 'dev.season_facts', expr: 'SUM("dev"."season_facts"."total_points") / NULLIF(SUM("dev"."season_facts"."games_played"), 0)', aggregate: 'derived' } },
      { name: 'games_played', label: 'Games played', aggregation: 'sum', physical: { relation: 'dev.season_facts', expr: '"dev"."season_facts"."games_played"', aggregate: 'sum' } },
    ],
    dimensions: [
      { name: 'season', model: 'season_facts', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'season' } },
      { name: 'player_id', model: 'season_facts', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'player_id' } },
    ],
    relations: [{ schema: 'dev', name: 'season_facts', columns: [{ name: 'total_points' }, { name: 'games_played' }, { name: 'season', dataType: 'INTEGER' }, { name: 'player_id', dataType: 'INTEGER' }] }],
  });
  const inSeason = (year: number) => [{ ref: 'dimension:season_facts.season', op: 'eq' as const, values: [year], source: 'question' as const }];
  const reading = (measures: AnalyticalIntentV1['measures']): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'points per game 2016 versus 2017', measures,
    groupBy: [{ ref: 'dimension:season_facts.player_id', role: 'key' }], display: [], filters: [],
    ordering: { ref: 'ppg_change', direction: 'desc' }, limit: 5, expectedShape: 'ranking', unresolved: [], provenance: {},
  });

  it('restricts each aggregate of the formula, never the quotient', () => {
    expect(scopeFormulaAggregates('SUM(a) / NULLIF(SUM(b), 0)', () => ['x = 1']))
      .toBe('SUM(CASE WHEN x = 1 THEN a ELSE 0 END) / NULLIF(SUM(CASE WHEN x = 1 THEN b ELSE 0 END), 0)');
    // Only a sum reads 0 for an excluded row.
    expect(scopeFormulaAggregates('COUNT(DISTINCT g) * AVG(p)', () => ['x = 1']))
      .toBe('COUNT(DISTINCT CASE WHEN x = 1 THEN g END) * AVG(CASE WHEN x = 1 THEN p END)');
    // A formula holding something this cannot prove is refused, not approximated.
    expect(scopeFormulaAggregates('SUM(rank() OVER ())', () => ['x = 1'])).toBeUndefined();
    expect(scopeFormulaAggregates('42', () => ['x = 1'])).toBeUndefined();
    // Each aggregate renders the restriction again, so each placeholder is bound.
    let rendered = 0;
    scopeFormulaAggregates('SUM(a) / NULLIF(SUM(b), 0)', () => { rendered += 1; return ['x = ?']; });
    expect(rendered).toBe(2);
  });

  it('composes a two-period comparison of a stored rate, and the change between them', () => {
    const prepared = composeRelational(reading([
      { ref: 'metric:points_per_game', alias: 'ppg_2016', scope: inSeason(2016) },
      { ref: 'metric:points_per_game', alias: 'ppg_2017', scope: inSeason(2017) },
      { ref: 'change:ppg_2017-ppg_2016', alias: 'ppg_change', change: { base: 'ppg_2016', comparison: 'ppg_2017', as: 'absolute' } },
    ]), vocabulary, { blockSql: () => undefined });
    expect(prepared.refusal).toBeUndefined();
    const sql = prepared.candidate!.sql;
    expect(sql).toContain('AS "ppg_2016"');
    expect(sql).toContain('AS "ppg_2017"');
    // Each period restricts the aggregates inside the rate, so the two rates
    // are two different populations rather than one repeated.
    expect((sql.match(/CASE WHEN "dev"\."season_facts"\."season" = \?/g) ?? []).length).toBe(4);
    expect(sql).toContain('AS "ppg_change"');
  });

  it('a threshold on each period is a threshold on each period', () => {
    const prepared = composeRelational({
      ...reading([
        { ref: 'metric:points_per_game', alias: 'ppg_2016', scope: inSeason(2016) },
        { ref: 'metric:points_per_game', alias: 'ppg_2017', scope: inSeason(2017) },
        { ref: 'metric:games_played', alias: 'games_2016', scope: inSeason(2016) },
        { ref: 'metric:games_played', alias: 'games_2017', scope: inSeason(2017) },
        { ref: 'change:ppg_2017-ppg_2016', alias: 'ppg_change', change: { base: 'ppg_2016', comparison: 'ppg_2017', as: 'absolute' } },
      ]),
      filters: [
        { ref: 'measure:2', op: 'gte', values: [20], source: 'question', on: 'aggregate' },
        { ref: 'measure:3', op: 'gte', values: [20], source: 'question', on: 'aggregate' },
      ],
    }, vocabulary, { blockSql: () => undefined });
    expect(prepared.refusal).toBeUndefined();
    expect(prepared.candidate!.sql).toContain('"games_2016" >= ?');
    expect(prepared.candidate!.sql).toContain('"games_2017" >= ?');
  });
});

describe('a superlative that ties has several answers', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'assists', label: 'Assists', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: '"dev"."game_facts"."assists"', aggregate: 'sum' } }],
    dimensions: [{ name: 'player', model: 'game_facts', dataType: 'string', physical: { relation: 'dev.game_facts', column: 'player_name' } }],
    relations: [{ schema: 'dev', name: 'game_facts', columns: [{ name: 'assists' }, { name: 'player_name' }] }],
  });
  const best: AnalyticalIntentV1 = {
    version: 1, kind: 'analytics', reading: 'the best', measures: [{ ref: 'metric:assists', alias: 'assists' }],
    groupBy: [{ ref: 'dimension:game_facts.player', role: 'categorical' }], display: [], filters: [],
    ordering: { ref: 'metric:assists', direction: 'desc' }, limit: 1, expectedShape: 'ranking', unresolved: [], provenance: {},
  };

  it('fetches one row more than it shows, and says which column decides', () => {
    const prepared = composeRelational(best, vocabulary, { blockSql: () => undefined });
    expect(prepared.candidate!.sql).toContain('LIMIT 2');
    expect(prepared.candidate!.tieProbe).toEqual({ column: 'assists', limit: 1 });
    // A ranking the question sized itself fetches exactly what it shows.
    expect(composeRelational({ ...best, limit: 5 }, vocabulary, { blockSql: () => undefined }).candidate!.sql).toContain('LIMIT 5');
  });

  it('keeps every row that ties, and drops the extra row when nothing ties', () => {
    const rows = (top: number, second: number) => ({ columns: ['player', 'assists'], rowCount: 2, executionTimeMs: 1, rows: [{ player: 'Rudez', assists: top }, { player: 'Morrow', assists: second }] });
    const tied = resolveTie(rows(6.5, 6.5), { column: 'assists', limit: 1 });
    expect(tied.result.rows).toHaveLength(2);
    expect(tied.note).toMatch(/2 rows tie on assists at 6.5/);
    const clear = resolveTie(rows(9, 6.5), { column: 'assists', limit: 1 });
    expect(clear.result.rows).toHaveLength(1);
    expect(clear.note).toBeUndefined();
  });
});

describe('the composer writes physical names as the warehouse reads them and aliases as its own', () => {
  it('a Snowflake-like dialect leaves plain relation and column names unquoted while every alias stays quoted', () => {
    const vocabulary = buildVocabularyIndex({
      metrics: [{ name: 'revenue', model: 'orders', aggregation: 'sum', physical: { relation: 'sales.orders', expr: 'SUM(sales.orders.amount)', aggregate: 'sum' } }],
      dimensions: [{ name: 'region', model: 'orders', dataType: 'string', physical: { relation: 'sales.orders', column: 'region' } }],
      relations: [{ schema: 'sales', name: 'orders', columns: [{ name: 'amount', dataType: 'NUMBER' }, { name: 'region', dataType: 'VARCHAR' }] }],
    });
    const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:orders.revenue' }], groupBy: [{ ref: 'dimension:orders.region', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }).intent!;
    const snowflakeLike = { quoteIdentifier: (name: string) => `"${name}"`, quotePhysical: (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`), dateTrunc: (grain: string, expr: string) => `DATE_TRUNC('${grain}', ${expr})`, limitClause: (limit: number) => `LIMIT ${limit}` };
    const result = composeRelational(intent, vocabulary, { dialect: snowflakeLike });
    expect(result.candidate?.sql).toContain('FROM sales.orders');
    expect(result.candidate?.sql).toContain('sales.orders.region AS "region"');
    expect(result.candidate?.sql).toContain('AS "revenue"');
    expect(result.candidate?.sql).not.toContain('"sales"');
    const addressed = composeRelational(intent, vocabulary, { dialect: { ...snowflakeLike, qualifyRelation: (relation: string) => `ANALYTICS.${relation}` } });
    expect(addressed.candidate?.sql).toContain('FROM ANALYTICS.sales.orders');
  });

  it('uses an admitted exact binding for FROM as well as a metric expression', () => {
    const binding = physicalRelationBinding({
      logicalRelation: 'PUBLIC.EVENTS', physicalRelation: 'DB_B.PUBLIC.EVENTS',
      source: 'dbt_manifest', columnCompleteness: 'partial', columns: [{ name: 'amount', type: 'NUMBER' }],
    });
    const exact = buildVocabularyIndex({
      metrics: [{
        name: 'revenue', model: 'events', aggregation: 'sum',
        physical: { relation: 'PUBLIC.EVENTS', expr: 'SUM(DB_B.PUBLIC.EVENTS.amount)', aggregate: 'sum', binding },
      }],
      relations: [{
        schema: 'PUBLIC', name: 'EVENTS', columns: [{ name: 'amount', dataType: 'NUMBER' }], binding,
      }],
    });
    const parsed = parseIntent({
      version: 1, kind: 'analytics', reading: 'Revenue.', measures: [{ ref: 'metric:events.revenue' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
    }).intent!;

    const composed = composeRelational(parsed, exact, {});

    expect(composed.candidate?.sql).toContain('FROM "DB_B"."PUBLIC"."EVENTS"');
    expect(composed.candidate?.sql).not.toContain('FROM "PUBLIC"."EVENTS"');
  });

  it('uses logical relation identities for governed joins while rendering their exact target bindings', () => {
    const orders = physicalRelationBinding({
      logicalRelation: 'PUBLIC.ORDERS', physicalRelation: 'DB_B.PUBLIC.ORDERS',
      source: 'warehouse_probe', columnCompleteness: 'complete', columns: [{ name: 'customer_id', type: 'NUMBER' }, { name: 'amount', type: 'NUMBER' }],
    });
    const customers = physicalRelationBinding({
      logicalRelation: 'PUBLIC.CUSTOMERS', physicalRelation: 'DB_B.PUBLIC.CUSTOMERS',
      source: 'warehouse_probe', columnCompleteness: 'complete', columns: [{ name: 'customer_id', type: 'NUMBER' }, { name: 'customer_name', type: 'VARCHAR' }],
    });
    const exact = buildVocabularyIndex({
      metrics: [{ name: 'revenue', model: 'orders', aggregation: 'sum', physical: { relation: 'PUBLIC.ORDERS', expr: 'DB_B.PUBLIC.ORDERS.amount', aggregate: 'sum', binding: orders } }],
      dimensions: [{ name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'PUBLIC.CUSTOMERS', column: 'customer_name', binding: customers } }],
      relations: [
        { schema: 'PUBLIC', name: 'ORDERS', columns: [{ name: 'customer_id', dataType: 'NUMBER' }, { name: 'amount', dataType: 'NUMBER' }], binding: orders },
        { schema: 'PUBLIC', name: 'CUSTOMERS', columns: [{ name: 'customer_id', dataType: 'NUMBER' }, { name: 'customer_name', dataType: 'VARCHAR' }], binding: customers },
      ],
    });
    const parsed = parseIntent({
      version: 1, kind: 'analytics', reading: 'Revenue by customer.', measures: [{ ref: 'metric:orders.revenue' }],
      groupBy: [{ ref: 'dimension:customers.customer_name', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
    }).intent!;
    const joinPath: PrepareDeps['joinPath'] = (from, to) => from === 'PUBLIC.ORDERS' && to === 'PUBLIC.CUSTOMERS'
      ? [{
        relation: 'PUBLIC.CUSTOMERS',
        on: '"DB_B"."PUBLIC"."ORDERS"."customer_id" = "DB_B"."PUBLIC"."CUSTOMERS"."customer_id"',
      }]
      : undefined;

    const composed = composeRelational(parsed, exact, { joinPath });

    expect(composed.refusal).toBeUndefined();
    expect(composed.candidate?.sql).toContain('FROM "DB_B"."PUBLIC"."ORDERS"');
    expect(composed.candidate?.sql).toContain('JOIN "DB_B"."PUBLIC"."CUSTOMERS" ON "DB_B"."PUBLIC"."ORDERS"."customer_id" = "DB_B"."PUBLIC"."CUSTOMERS"."customer_id"');
  });

  it('does not borrow a governed path when the base logical relation is ambiguous across databases', () => {
    const dbAOrders = physicalRelationBinding({
      logicalRelation: 'PUBLIC.ORDERS', physicalRelation: 'DB_A.PUBLIC.ORDERS',
      source: 'dbt_manifest', columnCompleteness: 'partial', columns: [{ name: 'amount', type: 'NUMBER' }],
    });
    const dbBOrders = physicalRelationBinding({
      logicalRelation: 'PUBLIC.ORDERS', physicalRelation: 'DB_B.PUBLIC.ORDERS',
      source: 'warehouse_probe', columnCompleteness: 'complete', columns: [{ name: 'customer_id', type: 'NUMBER' }, { name: 'amount', type: 'NUMBER' }],
    });
    const customers = physicalRelationBinding({
      logicalRelation: 'PUBLIC.CUSTOMERS', physicalRelation: 'DB_B.PUBLIC.CUSTOMERS',
      source: 'warehouse_probe', columnCompleteness: 'complete', columns: [{ name: 'customer_id', type: 'NUMBER' }, { name: 'customer_name', type: 'VARCHAR' }],
    });
    const ambiguous = buildVocabularyIndex({
      metrics: [{ name: 'revenue', model: 'orders', aggregation: 'sum', physical: { relation: 'PUBLIC.ORDERS', expr: 'DB_B.PUBLIC.ORDERS.amount', aggregate: 'sum', binding: dbBOrders } }],
      dimensions: [{ name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'PUBLIC.CUSTOMERS', column: 'customer_name', binding: customers } }],
      relations: [
        { schema: 'PUBLIC', name: 'ORDERS', columns: [{ name: 'amount', dataType: 'NUMBER' }], binding: dbAOrders },
        { schema: 'PUBLIC', name: 'ORDERS', columns: [{ name: 'customer_id', dataType: 'NUMBER' }, { name: 'amount', dataType: 'NUMBER' }], binding: dbBOrders },
        { schema: 'PUBLIC', name: 'CUSTOMERS', columns: [{ name: 'customer_id', dataType: 'NUMBER' }, { name: 'customer_name', dataType: 'VARCHAR' }], binding: customers },
      ],
    });
    const parsed = parseIntent({
      version: 1, kind: 'analytics', reading: 'Revenue by customer.', measures: [{ ref: 'metric:orders.revenue' }],
      groupBy: [{ ref: 'dimension:customers.customer_name', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
    }).intent!;
    const logicalOnlyPath: PrepareDeps['joinPath'] = (from, to) => from === 'PUBLIC.ORDERS' && to === 'PUBLIC.CUSTOMERS'
      ? [{ relation: 'PUBLIC.CUSTOMERS', on: 'ignored' }]
      : undefined;

    const composed = composeRelational(parsed, ambiguous, { joinPath: logicalOnlyPath });

    expect(composed.candidate).toBeUndefined();
    expect(composed.refusal).toMatchObject({ code: 'join_path_required' });
  });
});

// From Metrics means certified joins: the host checks the joins a semantic
// compile took against the DQL relationships (`joinTrust`); one that is a
// draft makes the answer review-required, said in its proof and caveat.
describe('a semantic answer through an uncertified join is labelled for review', () => {
  const grouped = () => intent({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_name', role: 'categorical' }], expectedShape: 'grouped' });
  const compiled = { sql: 'SELECT customer_name, SUM(product_price) AS revenue FROM dev.order_items JOIN dev.orders USING (order_id) JOIN dev.customers USING (customer_id) GROUP BY 1', engine: 'native' };

  it('keeps From Metrics (governed) when every join is certified, or the host could not tell', async () => {
    for (const output of [{ ...compiled, joinTrust: { certified: true } }, compiled]) {
      const result = await prepare({ intent: grouped(), vocabulary, deps: { compileSemantic: async () => output } });
      expect(result.chosen).toMatchObject({ tier: 'semantic', trust: 'governed' });
      expect(result.chosen!.trustCaveat).toBeUndefined();
    }
  });

  it('is review-required when a join is a draft relationship, and names it', async () => {
    const caveat = 'Orders → customers joins through relationship "order_to_customer", which is draft, not certified. Certify the relationship in Modeling, with warehouse validation, for a From Metrics answer.';
    const result = await prepare({ intent: grouped(), vocabulary, deps: { compileSemantic: async () => ({ ...compiled, joinTrust: { certified: false, caveat } }) } });
    expect(result.chosen).toMatchObject({ tier: 'semantic', trust: 'review_required', trustCaveat: caveat });
    expect(result.chosen!.proof).toContain(`joins: ${caveat}`);
    expect((result.chosen!.artifact as { trustState?: string }).trustState).toBe('review_required');
  });
});
