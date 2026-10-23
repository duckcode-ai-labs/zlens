import { describe, expect, it } from 'vitest';
import { buildAnalysisQuestionPlan } from './analysis-planner.js';
import {
  certifiedFitAllowsTier1,
  certifiedTerminationVerdict,
  evaluateCertifiedBlockFit,
  namedQualifiedSemanticMeasures,
} from './block-fit.js';
import type { MetadataObject } from './catalog.js';

function certifiedBlock(name: string, payload: Record<string, unknown>): MetadataObject {
  return {
    objectKey: `dql:block:${name}`,
    objectType: 'dql_block',
    name,
    status: 'certified',
    description: typeof payload.description === 'string' ? payload.description : undefined,
    payload,
  };
}

function fit(question: string, block: MetadataObject) {
  const plan = buildAnalysisQuestionPlan(question);
  return evaluateCertifiedBlockFit({ question, plan, block });
}

describe('certified block fit', () => {
  it('AGT-009 treats tags, examples, and correlated lifetime spend as context when revenue is not a declared output', () => {
    const block = certifiedBlock('top_customers', {
      grain: 'customer',
      declaredOutputs: ['customer_name', 'lifetime_spend', 'order_count'],
      dimensions: ['customer'],
      tags: ['revenue', 'top customers'],
      examples: ['show me revenue'],
      sql: 'select customer_name, lifetime_spend, order_count from customers order by lifetime_spend desc limit 10',
    });

    const result = evaluateCertifiedBlockFit({
      question: 'show me revenue',
      plan: buildAnalysisQuestionPlan('show me revenue'),
      block,
      exactExampleMatch: true,
    });

    expect(result).toMatchObject({ kind: 'context_only', missingMeasures: ['revenue'] });
    expect(certifiedTerminationVerdict({ fit: result, bypass: 'exact_example' })).toMatchObject({ allow: false });
    expect(certifiedFitAllowsTier1({ ...result, kind: 'exact', confidence: 'high' })).toBe(false);
  });

  it('AGT-009 keeps a block with an own revenue output eligible for zero-call termination', () => {
    const block = certifiedBlock('revenue_summary', {
      grain: 'scalar',
      declaredOutputs: ['revenue'],
      sql: 'select sum(order_total) as revenue from orders',
    });
    const result = fit('show me revenue', block);

    expect(result.kind).toBe('exact');
    expect(certifiedTerminationVerdict({ fit: result })).toMatchObject({ allow: true });
  });

  it('AGT-006 rejects an unfiltered lifetime-spend block for beverage-scoped ranking', () => {
    const block = certifiedBlock('top_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'lifetime_spend', 'order_count'],
      dimensions: ['customer'],
      sql: 'select customer_name, lifetime_spend, order_count from customers order by lifetime_spend desc limit 10',
    });

    const result = fit('who are the customers who spent most on beverages?', block);

    expect(result.kind).toBe('context_only');
    expect(result.unsupportedFilters).toContain('beverage');
    expect(result.reasons.join(' ')).toContain('unsupported requested filters');
  });

  it.each([
    'who are the top customers who spent on beverage category products?',
    'who are the top customers by drink revenue?',
  ])('accepts a certified customer ranking whose requested category restriction is baked into its contract and SQL (AGT-009, AGT-010): %s', (question) => {
    const block = certifiedBlock('top_beverage_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'],
      dimensions: ['customer'],
      allowedFilters: ['top_n'],
      tags: ['beverage', 'customer', 'revenue', 'ranking'],
      description: 'Top customers ranked by beverage revenue. One row per customer.',
      sql: `select customer_name, sum(product_price) as beverage_revenue
        from order_items
        join products on order_items.product_id = products.product_id
        where products.is_beverage = true
        group by customer_name
        order by beverage_revenue desc
        limit 10`,
    });

    const result = fit(question, block);
    expect(result.kind).toBe('exact');
    expect(result.confidence).toBe('high');
    expect(result.missingDimensions).toEqual([]);
    expect(result.missingOutputs).toEqual([]);
    expect(result.unsupportedFilters).toEqual([]);
  });

  it('AGT-006 rejects any category-scoped certified ranking when the question requests the overall metric', () => {
    const block = certifiedBlock('priority_account_value', {
      grain: 'account',
      declaredOutputs: ['account_label', 'contract_value'],
      dimensions: ['account'],
      sql: `select account_label, sum(contract_value) as contract_value
        from contracts
        where account_tier = 'priority'
        group by account_label
        order by contract_value desc
        limit 10`,
    });

    const result = fit('Which accounts have the highest contract value?', block);

    expect(result.kind).toBe('context_only');
    expect(result.reasons).toContain('certified static scope is not requested: priority');
  });

  it('AGT-006 accepts the same arbitrary category scope when the question entails it', () => {
    const block = certifiedBlock('priority_account_value', {
      grain: 'account',
      declaredOutputs: ['account_label', 'contract_value'],
      dimensions: ['account'],
      sql: `select account_label, sum(contract_value) as contract_value
        from contracts
        where account_tier = 'priority'
        group by account_label
        order by contract_value desc
        limit 10`,
    });

    const result = fit('Which priority accounts have the highest contract value?', block);

    expect(result.kind).toBe('exact');
    expect(result.reasons).not.toEqual(expect.arrayContaining([expect.stringMatching(/scope is not requested/i)]));
  });

  it('keeps gross as a generic revenue modifier, not an unrequested static scope', () => {
    const block = certifiedBlock('monthly_revenue', {
      grain: 'one row per calendar month',
      declaredOutputs: ['month', 'gross_revenue', 'order_count'],
      dimensions: ['month'],
      description: 'Monthly gross order revenue and order count. One row per calendar month.',
      sql: 'select date_trunc(\'month\', ordered_at) as month, sum(order_total) as gross_revenue, count(*) as order_count from orders group by 1',
    });

    const result = fit('What is monthly revenue?', block);

    expect(result).toMatchObject({ kind: 'exact', confidence: 'high' });
    expect(result.reasons).not.toEqual(expect.arrayContaining([expect.stringMatching(/static scope/i)]));
  });

  it('rejects a high-overlap customer block for a product flow with different required outputs', () => {
    const block = certifiedBlock('top_beverage_customers', {
      grain: 'customer',
      // These are joined/source entities, not the returned row grain.
      entities: ['Order Item', 'Product'],
      declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'],
      dimensions: ['customer'],
      tags: ['beverage', 'customer', 'revenue', 'ranking'],
      description: 'Top customers ranked by beverage revenue. One row per customer.',
      sql: 'select customer_name, beverage_revenue, beverage_orders, beverage_product_types from customer_beverage order by beverage_revenue desc limit 10',
    });

    const result = fit('Show revenue by product type and product name as a source-to-target flow.', block);

    expect(result.kind).toBe('context_only');
    expect(result.missingOutputs).toEqual(expect.arrayContaining(['product_type', 'product_name']));
    expect(result.grainMismatch).toMatch(/customer.*product/i);
    expect(result.reasons.join(' ')).toContain('missing requested outputs');
  });

  it('AGT-009/AGT-010 keeps a row-level profile as context for a scalar aggregate', () => {
    const block = certifiedBlock('customer_profile', {
      grain: 'one row per customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'lifetime_spend', 'first_ordered_at'],
      dimensions: ['customer_name'],
      description: 'Customer lifetime profile. One row per customer.',
      sql: 'select customer_name, lifetime_spend, first_ordered_at from customers',
    });

    const result = fit('What is total lifetime spend across all customers?', block);

    expect(result.kind).toBe('context_only');
    expect(result.grainMismatch).toContain('one aggregate value');
    expect(result.reasons.join(' ')).toContain('one aggregate value');
  });

  it('rejects a category-level revenue block for a product-level revenue request', () => {
    const block = certifiedBlock('food_vs_drink_revenue', {
      grain: 'category',
      entities: ['Category'],
      declaredOutputs: ['category', 'revenue'],
      dimensions: ['category'],
      sql: 'select category, sum(revenue) as revenue from order_items group by category',
    });

    const result = fit(
      'Can you give me the most revenue numbers products who does the most impacted? Give me the complete results with product name, category and revenue',
      block,
    );

    expect(result.kind).toBe('context_only');
    expect(result.confidence).toBe('high');
    expect(result.missingDimensions).toContain('product');
    expect(result.missingOutputs).toContain('product_name');
    expect(result.reasons.join(' ')).toMatch(/product/i);
  });

  it('allows an exact product-level revenue block', () => {
    const block = certifiedBlock('product_revenue', {
      grain: 'product',
      entities: ['Product'],
      declaredOutputs: ['product_name', 'category', 'revenue'],
      dimensions: ['product', 'category'],
      sql: 'select product_name, category, sum(revenue) as revenue from order_items group by product_name, category',
    });

    const result = fit('Show revenue by product with product name, category, and revenue', block);

    expect(result.kind).toBe('exact');
    expect(result.confidence).toBe('high');
    expect(result.missingOutputs).toEqual([]);
    expect(result.missingDimensions).toEqual([]);
  });

  it('uses typed outputContract columns when declared outputs are absent', () => {
    const block = certifiedBlock('product_revenue_contract', {
      grain: 'product',
      entities: ['Product'],
      outputContract: [
        { name: 'product_name', role: 'dimension' },
        { name: 'category', role: 'dimension' },
        { name: 'revenue', role: 'metric' },
      ],
      dimensions: ['product', 'category'],
    });

    const result = fit('Show revenue by product with product name, category, and revenue', block);

    expect(result.kind).toBe('exact');
    expect(result.confidence).toBe('high');
    expect(result.missingOutputs).toEqual([]);
    expect(result.missingDimensions).toEqual([]);
  });

  it('keeps description-only legacy contracts as context until they declare an output identity', () => {
    const block = certifiedBlock('legacy_product_revenue', {
      grain: 'product',
      entities: ['Product'],
      dimensions: ['product'],
      description: 'Revenue by product from legacy certified block metadata.',
    });

    const result = fit('Show revenue by product', block);

    expect(result).toMatchObject({ kind: 'context_only', missingMeasures: ['revenue'] });
  });

  it('treats top-N mismatch as trim-safe when the block otherwise fits', () => {
    const block = certifiedBlock('top_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'revenue', 'order_count'],
      dimensions: ['customer'],
      sql: 'select customer_name, revenue, order_count from customers order by revenue desc limit 10',
    });

    const result = fit('Who are the top 5 customers by revenue?', block);

    expect(result.kind).toBe('trim_safe');
    expect(result.topNAction).toBe('trim');
  });

  it('rejects global top customers for a category-scoped customer follow-up', () => {
    const block = certifiedBlock('top_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'revenue', 'order_count'],
      dimensions: ['customer'],
      sql: 'select customer_name, revenue, order_count from customers order by revenue desc limit 10',
    });

    const result = fit('Who are the top 5 customers for these categories?', block);

    expect(result.kind).toBe('context_only');
    expect(result.missingDimensions).toContain('category');
  });

  it('rejects global top customers for deictic-only category follow-ups', () => {
    const block = certifiedBlock('top_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'revenue', 'order_count'],
      dimensions: ['customer'],
      sql: 'select customer_name, revenue, order_count from customers order by revenue desc limit 10',
    });
    const plan = buildAnalysisQuestionPlan('Who are the top 5 customers for those?', {
      kind: 'drilldown',
      dimensions: ['category'],
      filters: ['Food', 'Drink'],
      priorResultValues: { category: ['Food', 'Drink'] },
      priorMeasures: ['revenue'],
    });

    const result = evaluateCertifiedBlockFit({
      question: 'Who are the top 5 customers for those?',
      plan,
      block,
    });

    expect(result.kind).toBe('context_only');
    expect(result.missingDimensions).toContain('category');
  });

  it('AGT-012 rejects a broad customer profile that cannot honor a named product binding', () => {
    const block = certifiedBlock('customer_profile', {
      grain: 'customer',
      declaredOutputs: ['customer_name', 'customer_type', 'lifetime_spend'],
      dimensions: ['customer'],
      sql: 'select customer_name, customer_type, lifetime_spend from customers order by lifetime_spend desc',
    });
    const question = 'who are the customer from flame impala';
    const plan = buildAnalysisQuestionPlan(question, {
      kind: 'drilldown',
      filters: ['flame impala'],
      dimensions: ['customer', 'product'],
      priorResultValues: { product_name: ['flame impala'] },
      memberBindings: [{
        dimension: 'product',
        values: ['flame impala'],
        source: 'prior_result',
        confidence: 'exact',
      }],
    });

    const result = evaluateCertifiedBlockFit({ question, plan, block });

    expect(result.kind).toBe('context_only');
    expect(result.missingDimensions).toContain('product');
    expect(result.unsupportedFilters).toContain('flame impala');
  });

  it('AGT-012 permits a certified product/customer result that exposes the bound dimension', () => {
    const block = certifiedBlock('product_customers', {
      grain: 'customer_product',
      declaredOutputs: ['customer_name', 'product_name', 'revenue'],
      dimensions: ['customer', 'product'],
      allowedFilters: ['product'],
      sql: 'select customer_name, product_name, revenue from product_customers',
    });
    const question = 'who are the customer from flame impala';
    const plan = buildAnalysisQuestionPlan(question, {
      kind: 'drilldown',
      filters: ['flame impala'],
      dimensions: ['customer', 'product'],
      priorResultValues: { product_name: ['flame impala'] },
      memberBindings: [{
        dimension: 'product',
        values: ['flame impala'],
        source: 'prior_result',
        confidence: 'exact',
      }],
    });

    expect(evaluateCertifiedBlockFit({ question, plan, block }).unsupportedFilters).toEqual([]);
  });
});

describe('member bindings vs Tier-1 termination (Slice 1c)', () => {
  const rankingBlock = (allowedFilters: string[]) => ({
    nodeId: 'block:top_beverage_customers',
    kind: 'block',
    name: 'top_beverage_customers',
    status: 'certified',
    description: 'Top customers ranked by beverage revenue, with beverage order count and product variety. One row per customer.',
    tags: ['beverage', 'customer', 'revenue', 'ranking'],
    grain: 'one row per customer in the beverage purchase ranking',
    declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'],
    dimensions: ['customer_name'],
    allowedFilters,
    sql: 'SELECT 1',
    examples: [],
  });
  const joyFollowUp = {
    kind: 'drilldown',
    memberBindings: [{ dimension: 'customer', values: ['Joy Lam'], source: 'prior_result', confidence: 'exact' }],
  };

  it('keeps the broad ranking question exact (no member binding)', () => {
    const question = 'who are the top customers bought a beverage product?';
    const fit = evaluateCertifiedBlockFit({ question, plan: buildAnalysisQuestionPlan(question), block: rankingBlock([]) as never });
    expect(fit.kind).toBe('exact');
  });

  it('demotes a member-bound follow-up: a dimension column cannot apply the filter verbatim', () => {
    // Regression for the "Joy Lam" hijack: Tier-1 executed the unfiltered
    // top-10 ranking as a certified answer for a member-scoped follow-up
    // because a customer DIMENSION was treated as binding support.
    const question = 'Joy Lam is a customer data. we are asking from the results so I need his products by revenue in berearage';
    const fit = evaluateCertifiedBlockFit({ question, plan: buildAnalysisQuestionPlan(question, joyFollowUp), block: rankingBlock([]) as never });
    expect(fit.kind).toBe('context_only');
    expect(fit.unsupportedFilters).toContain('Joy Lam');
  });

  it('keeps a member binding supported when the block exposes a parameterized filter', () => {
    const question = 'top beverage customers for Joy Lam';
    const fit = evaluateCertifiedBlockFit({ question, plan: buildAnalysisQuestionPlan(question, joyFollowUp), block: rankingBlock(['customer_name']) as never });
    expect(fit.kind).toBe('exact');
    expect(fit.unsupportedFilters).toEqual([]);
  });
});

describe('certifiedTerminationVerdict — the single authority (Slice 2)', () => {
  const fit = (overrides: Partial<import('./block-fit.js').CertifiedBlockFit>): import('./block-fit.js').CertifiedBlockFit => ({
    kind: 'exact',
    confidence: 'high',
    reasons: [],
    missingOutputs: [],
    missingDimensions: [],
    unsupportedFilters: [],
    topNAction: 'none',
    inferredContract: false,
    ...overrides,
  });

  it('allows exact/trim-safe fits at high confidence', () => {
    expect(certifiedTerminationVerdict({ fit: fit({}) }).allow).toBe(true);
    expect(certifiedTerminationVerdict({ fit: fit({ kind: 'trim_safe' }) }).allow).toBe(true);
  });

  it('denies context-only fits without a bypass', () => {
    const verdict = certifiedTerminationVerdict({ fit: fit({ kind: 'context_only', reasons: ['missing requested dimensions: category'] }) });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain('missing requested dimensions');
  });

  it('lets a direct request bypass a shape mismatch (grain implicitly accepted)', () => {
    const verdict = certifiedTerminationVerdict({ fit: fit({ kind: 'context_only' }), bypass: 'named_block' });
    expect(verdict.allow).toBe(true);
    expect(verdict.bypass).toBe('named_block');
  });

  it('NEVER bypasses an unapplied member binding — naming the block does not drop the filter', () => {
    const bound = fit({ kind: 'context_only', unsupportedFilters: ['Joy Lam'] });
    for (const bypass of ['named_block', 'exact_example', 'definition_lookup'] as const) {
      const verdict = certifiedTerminationVerdict({ fit: bound, bypass });
      expect(verdict.allow, bypass).toBe(false);
      expect(verdict.reason).toContain('Joy Lam');
    }
  });

  it('honors the inferred-contract allowance only when the shape has no gaps', () => {
    const medium = fit({ confidence: 'medium', inferredContract: true });
    expect(certifiedTerminationVerdict({ fit: medium }).allow).toBe(false);
    expect(certifiedTerminationVerdict({ fit: medium, allowInferredContract: true }).allow).toBe(true);
    expect(certifiedTerminationVerdict({
      fit: fit({ confidence: 'medium', missingDimensions: ['category'] }),
      allowInferredContract: true,
    }).allow).toBe(false);
  });
});

describe('authored scope of a certified block', () => {
  const beverage = () => certifiedBlock('top_beverage_customers', {
    grain: 'one row per customer in the beverage purchase ranking',
    declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'],
    dimensions: ['customer_name'],
    tags: ['beverage', 'customer', 'revenue', 'ranking'],
    examples: ['Who are the top customers by beverage revenue?'],
    sql: 'select customers.customer_name, sum(order_items.product_price) as beverage_revenue, count(distinct order_items.order_id) as beverage_orders, count(distinct products.product_id) as beverage_product_types from dev.order_items as order_items join dev.products as products on order_items.product_id = products.product_id join dev.orders as orders on order_items.order_id = orders.order_id join dev.customers as customers on orders.customer_id = customers.customer_id where products.is_drink_item = true group by customers.customer_name order by beverage_revenue desc limit 10',
  });

  it('is complete for "top customers by beverage": the output name declares the term and the tag entails the WHERE scope', () => {
    const result = fit('top customers by beverage', beverage());
    expect(result.missingDimensions).toEqual([]);
    expect(result.reasons?.some((reason) => reason.includes('static scope is not requested'))).toBeFalsy();
    expect(certifiedFitAllowsTier1(result)).toBe(true);
  });

  it('stays context-only for the unscoped "top customers": the WHERE scope is not asked for', () => {
    const result = fit('top customers', beverage());
    expect(result.reasons?.some((reason) => reason.includes('static scope is not requested'))).toBe(true);
    expect(certifiedFitAllowsTier1(result)).toBe(false);
  });

  describe('a qualified semantic metric the question names (MCP 2026-10-23)', () => {
    const monthlyRevenue = certifiedBlock('monthly_revenue', {
      grain: 'one row per calendar month',
      declaredOutputs: ['month', 'gross_revenue', 'order_count'],
      dimensions: ['month'],
      tags: ['revenue', 'trend', 'growth'],
      sql: "SELECT date_trunc('month', ordered_at) AS month, SUM(order_total) AS gross_revenue, COUNT(*) AS order_count FROM dev.orders GROUP BY 1",
    });
    const semanticMetric = (name: string, label: string): MetadataObject => ({
      objectKey: `semantic:metric:orders.${name}`,
      objectType: 'semantic_metric',
      name: `orders.${name}`,
      payload: { localId: name, label },
    });
    const metrics = [
      semanticMetric('orders', 'Orders'),
      semanticMetric('large_orders', 'Large Orders'),
      semanticMetric('drink_orders', 'Drink Orders'),
      semanticMetric('order_total', 'Order Total'),
    ];
    const fitWithSemantic = (question: string, block: MetadataObject) => evaluateCertifiedBlockFit({
      question,
      plan: buildAnalysisQuestionPlan(question),
      block,
      namedSemanticMeasures: namedQualifiedSemanticMeasures(question, metrics),
    });

    it('names large_orders for "large orders", and nothing for plain orders or order total', () => {
      expect(namedQualifiedSemanticMeasures('How many large orders did we get each month?', metrics))
        .toEqual([{ metric: 'large_orders', identity: 'large_order', qualifiers: ['large'] }]);
      expect(namedQualifiedSemanticMeasures('How many orders did we get each month?', metrics)).toEqual([]);
      expect(namedQualifiedSemanticMeasures('What is the order total by month?', metrics)).toEqual([]);
    });

    it('keeps monthly_revenue out of Tier 1 for large orders: its order_count counts every order', () => {
      // The planner drops "large" (measures: count, order), which order_count covers.
      const result = fitWithSemantic('How many large orders did we get each month?', monthlyRevenue);
      expect(result.missingMeasures).toEqual(['large_orders']);
      expect(certifiedFitAllowsTier1(result)).toBe(false);
      // Not even a directly named block may answer a measure it does not return.
      expect(certifiedTerminationVerdict({ fit: result, bypass: 'named_block' })).toMatchObject({ allow: false });
    });

    it('still lets monthly_revenue answer plain monthly orders and revenue', () => {
      for (const question of ['How many orders did we get each month?', 'How has revenue changed by month?']) {
        const result = fitWithSemantic(question, monthlyRevenue);
        expect(result.missingMeasures ?? []).toEqual([]);
        expect(certifiedTerminationVerdict({ fit: result })).toMatchObject({ allow: true });
      }
    });

    it('lets a block whose own output or scope declares the qualifier answer it', () => {
      const largeOrders = certifiedBlock('monthly_large_orders', {
        grain: 'one row per calendar month',
        declaredOutputs: ['month', 'large_order_count'],
        dimensions: ['month'],
        sql: "SELECT date_trunc('month', ordered_at) AS month, COUNT(*) AS large_order_count FROM dev.orders WHERE order_total >= 20 GROUP BY 1",
      });
      const result = fitWithSemantic('How many large orders did we get each month?', largeOrders);
      expect(result.missingMeasures ?? []).toEqual([]);
      expect(certifiedTerminationVerdict({ fit: result })).toMatchObject({ allow: true });
    });
  });
});
