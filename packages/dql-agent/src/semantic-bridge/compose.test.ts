import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@zlens/core';
import { composeSemanticQueryForQuestion, composeSemanticQueryForQuestionWithCoverage, composeSemanticQueryFromMembers } from './compose.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';

function layer(): SemanticLayer {
  return new SemanticLayer({
    metrics: [{ name: 'total_revenue', label: 'Total Revenue', description: 'Recognized revenue.', domain: 'finance', sql: 'amount', type: 'sum', table: 'orders' }],
    dimensions: [{ name: 'channel', label: 'Channel', description: 'Sales channel.', domain: 'finance', sql: 'channel', type: 'string', table: 'orders' }],
  });
}

describe('composeSemanticQueryFromMembers — hollow-answer guard', () => {
  it('compiles an entity-relative measure comparison at peer grain without an LLM', () => {
    const l = new SemanticLayer({
      metrics: [{ name: 'tax_paid', label: 'Tax Paid', description: 'Tax paid by customers.', domain: 'commerce', sql: 'tax_amount', type: 'sum', table: 'orders' }],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: 'Customer name.', domain: 'commerce', sql: 'customer_name', type: 'string', table: 'orders' }],
    });
    const question = 'Who are the other customers who paid less tax than Melissa?';

    const compiled = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
      filterValueBindings: (value) => value === 'Melissa'
        ? [{ column: 'customer_name', canonicalValue: 'Melissa Lopez', match: 'fuzzy', confidence: 0.97 }]
        : [],
    });
    expect(compiled?.metric).toBe('tax_paid');
    expect(compiled?.dimensions).toEqual(['customer_name']);
    expect(compiled?.filters).toEqual([{
      dimension: 'customer_name',
      operator: 'less_than_reference',
      values: ['Melissa Lopez'],
    }]);
    expect(compiled?.sql).toContain('WITH peer_values AS');
    expect(compiled?.sql).toContain('SUM(tax_amount) AS tax_paid');
    expect(compiled?.sql).toContain('WHERE "customer_name" = \'Melissa Lopez\'');
    expect(compiled?.sql).toContain('peer."tax_paid" < reference.baseline_value');
    expect(compiled?.sql).toContain('peer."customer_name" <> \'Melissa Lopez\'');
    expect(compiled?.sql).toContain('ORDER BY peer."tax_paid" DESC');
    expect(compiled?.sql).toContain('LIMIT 100');
    expect(composeSemanticQueryFromMembers({
      semanticLayer: l,
      question,
      selection: {
        metrics: ['tax_paid'],
        dimensions: ['customer_name'],
        filters: [{ dimension: 'customer_name', operator: 'equals', values: ['Melissa Lopez'] }],
      },
    })).toBeUndefined();
  });

  it('rejects a degenerate compile (empty/blank SQL) so the loop falls through to generation', () => {
    // Reproduces the "Answered from governed semantic metrics … " with an EMPTY SQL
    // preview and no rows: an incompatible metric×dimension combo compiles to blank
    // SQL. Accepting it would surface a hollow governed answer; it must be rejected.
    const l = layer();
    (l as unknown as { composeQuery: () => { sql: string } }).composeQuery = () => ({ sql: '   ' });
    const result = composeSemanticQueryFromMembers({
      semanticLayer: l,
      question: 'top customers who bought the top products with revenue',
      selection: { metrics: ['total_revenue'], dimensions: ['channel'] },
    });
    expect(result).toBeUndefined();
  });

  it('accepts a real compiled query with executable SQL', () => {
    const l = layer();
    (l as unknown as { composeQuery: () => { sql: string } }).composeQuery = () =>
      ({ sql: 'SELECT channel, SUM(amount) AS total_revenue FROM orders GROUP BY channel' });
    const result = composeSemanticQueryFromMembers({
      semanticLayer: l,
      question: 'revenue by channel',
      selection: { metrics: ['total_revenue'], dimensions: ['channel'] },
    });
    expect(result?.sql).toContain('SELECT channel');
    expect(result?.metrics).toEqual(['total_revenue']);
  });
});

describe('composeSemanticQueryForQuestion — grain-aware metric disambiguation', () => {
  it('compiles an across-all metric question without adding an entity GROUP BY', () => {
    const l = new SemanticLayer({
      metrics: [
        { name: 'lifetime_spend', label: 'Lifetime Spend', description: 'Gross customer lifetime spend.', domain: 'customers', sql: 'lifetime_spend', type: 'sum', table: 'customers' },
      ],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: 'Customer name.', domain: 'customers', sql: 'customer_name', type: 'string', table: 'customers' },
      ],
    });
    const question = 'What is total lifetime spend across all customers?';
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
    });

    expect(result?.metric).toBe('lifetime_spend');
    expect(result?.dimensions).toEqual([]);
    expect(result?.sql).toContain('SUM(lifetime_spend)');
    expect(result?.sql).not.toContain('customer_name');
    expect(result?.sql).not.toContain('GROUP BY');
  });

  it('AGT-005 binds a complete named value and selects the entity display dimension', () => {
    const l = new SemanticLayer({
      metrics: [
        { name: 'revenue', label: 'Revenue', description: 'Product revenue.', domain: 'commerce', sql: 'product_price', type: 'sum', table: 'purchases' },
      ],
      dimensions: [
        { name: 'product_description', label: 'Product Description', description: '', domain: 'commerce', sql: 'product_description', type: 'string', table: 'purchases' },
        { name: 'product_name', label: 'Product', description: 'Product display name.', domain: 'commerce', sql: 'product_name', type: 'string', table: 'purchases' },
        { name: 'customer_name', label: 'Customer', description: 'Customer display name.', domain: 'commerce', sql: 'customer_name', type: 'string', table: 'purchases' },
      ],
    });
    const question = 'what are the top product Melissa Lopex got it? what is the revenue?';
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
      filterValueBindings: (value) => value === 'Melissa Lopex'
        ? [{ column: 'customer_name', canonicalValue: 'Melissa Lopez', match: 'fuzzy', confidence: 0.9231 }]
        : [],
    });

    expect(result?.dimensions).toEqual(['product_name']);
    expect(result?.filters).toEqual([{
      dimension: 'customer_name',
      operator: 'equals',
      values: ['Melissa Lopez'],
    }]);
    expect(result?.sql).toContain("customer_name = 'Melissa Lopez'");
    expect(result?.sql).not.toContain("IN ('melissa', 'lopex')");
  });

  it('AGT-005 prefers a qualifier-specific governed metric over broad lifetime spend', () => {
    const l = new SemanticLayer({
      metrics: [
        { name: 'lifetime_spend', label: 'Lifetime Spend', description: 'All customer lifetime spend.', domain: 'customers', sql: 'lifetime_spend', type: 'sum', table: 'customers' },
        { name: 'drink_revenue', label: 'Drink Revenue', description: 'Revenue from beverage and drink purchases.', domain: 'customers', sql: 'drink_revenue', type: 'sum', table: 'customers' },
      ],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: 'Customer name.', domain: 'customers', sql: 'customer_name', type: 'string', table: 'customers' },
      ],
    });
    const question = 'who are the customers who spent most on beverages?';
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
      matchedMetric: { nodeId: 'metric:lifetime_spend', kind: 'metric', name: 'lifetime_spend' },
    });

    expect(result?.metric).toBe('drink_revenue');
    expect(result?.sql).toContain('SUM(drink_revenue)');
    expect(result?.sql).toContain('customer_name');
    expect(result?.filters).toEqual([]);
  });

  it('AGT-005 does not erase a qualifier when the specific metric cannot compile at the requested grain', () => {
    const l = new SemanticLayer({
      metrics: [
        { name: 'lifetime_spend', label: 'Lifetime Spend', description: 'All customer lifetime spend.', domain: 'customers', sql: 'lifetime_spend', type: 'sum', table: 'customers' },
        { name: 'drink_revenue', label: 'Drink Revenue', description: 'Revenue from beverage and drink purchases.', domain: 'orders', sql: 'product_price', type: 'sum', table: 'order_items' },
      ],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: 'Customer name.', domain: 'customers', sql: 'customer_name', type: 'string', table: 'customers' },
      ],
    });
    const question = 'who are the customers who spent most on beverages?';
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
      matchedMetric: { nodeId: 'metric:lifetime_spend', kind: 'metric', name: 'lifetime_spend' },
    });

    expect(result).toBeUndefined();
  });

  // Mirrors the real jaffle project: two revenue metrics at different grains. The
  // measure-family match picks one, but only the product-grain metric can be
  // grouped "by product". Previously the wrong-grain pick failed to compose and the
  // question fell to raw generation; now the retry lands on the composable metric.
  function twoGrainLayer(): SemanticLayer {
    return new SemanticLayer({
      metrics: [
        { name: 'total_revenue', label: 'Total Revenue', description: 'Gross revenue.', domain: 'revenue', sql: 'order_total', type: 'sum', table: 'orders' },
        { name: 'product_revenue', label: 'Product Revenue', description: 'Item revenue.', domain: 'products', sql: 'product_price', type: 'sum', table: 'order_items' },
      ],
      dimensions: [
        { name: 'location_name', label: 'Location', description: 'Store location.', domain: 'revenue', sql: 'location_name', type: 'string', table: 'orders' },
        { name: 'product_name', label: 'Product', description: 'Product name.', domain: 'products', sql: 'product_name', type: 'string', table: 'order_items' },
      ],
    });
  }

  it("composes the product-grain metric for 'total revenue by product' (not the all-orders one)", () => {
    const l = twoGrainLayer();
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question: 'total revenue by product',
      questionPlan: buildAnalysisQuestionPlan('total revenue by product'),
    });
    expect(result?.sql).toContain('SUM(product_price)');
    expect(result?.sql).toContain('product_name');
    expect(result?.metric).toBe('product_revenue');
  });

  it("still composes the all-orders metric for a breakdown its grain DOES cover", () => {
    const l = twoGrainLayer();
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question: 'total revenue by location',
      questionPlan: buildAnalysisQuestionPlan('total revenue by location'),
    });
    expect(result?.sql).toContain('SUM(order_total)');
    expect(result?.sql).toContain('location_name');
    expect(result?.metric).toBe('total_revenue');
  });

  it('keeps multiple explicitly selected semantic metrics in one governed compiler plan', () => {
    const l = new SemanticLayer({
      metrics: [
        { name: 'revenue', label: 'Revenue', description: '', domain: 'finance', sql: 'amount', type: 'sum', table: 'orders' },
        { name: 'refunds', label: 'Refunds', description: '', domain: 'finance', sql: 'amount', type: 'sum', table: 'refund_events' },
      ],
      dimensions: [],
    });
    const result = composeSemanticQueryFromMembers({
      semanticLayer: l,
      question: 'revenue and refunds',
      selection: { metrics: ['revenue', 'refunds'] },
    });
    expect(result?.metrics).toEqual(['revenue', 'refunds']);
    expect(result?.composeResult.strategy).toBe('aggregate_islands');
    expect(result?.sql).toContain('CROSS JOIN metric_2_refunds');
  });

  it('AGT-017 preserves multiple metrics named in a natural-language question', () => {
    const l = new SemanticLayer({
      metrics: [
        { name: 'revenue', label: 'Revenue', description: '', domain: 'finance', sql: 'amount', type: 'sum', table: 'orders' },
        { name: 'refunds', label: 'Refunds', description: '', domain: 'finance', sql: 'refund_amount', type: 'sum', table: 'orders' },
        { name: 'gross_margin', label: 'Gross Margin', description: '', domain: 'finance', sql: 'margin_amount', type: 'sum', table: 'orders' },
      ],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', domain: 'finance', sql: 'customer_name', type: 'string', table: 'orders' },
      ],
    });
    const question = 'Show revenue, refunds, and gross margin by customer';
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
    });

    expect(result?.metrics).toEqual(['revenue', 'refunds', 'gross_margin']);
    expect(result?.dimensions).toEqual(['customer_name']);
    expect(result?.sql).toContain('AS revenue');
    expect(result?.sql).toContain('AS refunds');
    expect(result?.sql).toContain('AS gross_margin');
  });

  it('AGT-021 preserves five explicitly named metrics across metric and measure objects', () => {
    const names = [
      'percent_dod_eu_core_ccu_acm_qty',
      'percent_dod_eu_core_ccu_bcm',
      'percent_dod_eu_core_ccu_bcm_qty',
      'percent_dod_legacy_acm_qty',
      'percent_dod_legacy_bcm',
    ];
    const l = new SemanticLayer({
      metrics: names.map((name, index) => ({
        name,
        label: name,
        description: '',
        domain: 'consumption',
        sql: name,
        type: 'sum' as const,
        table: 'consumption_daily',
        objectKind: index === 2 ? 'metric' as const : 'measure' as const,
      })),
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', domain: 'consumption', sql: 'customer_name', type: 'string', table: 'consumption_daily' },
      ],
    });
    const question = `what is ${names.map((name) => `"${name}"`).join(', ')} for Capital One?`;
    const direct = composeSemanticQueryFromMembers({
      semanticLayer: l,
      question,
      selection: {
        metrics: names,
        dimensions: [],
        filters: [{ dimension: 'customer_name', operator: 'equals', values: ['Capital One'] }],
      },
    });
    const result = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
      filterValueBindings: (value) => value.toLowerCase() === 'capital one'
        ? [{ column: 'customer_name', canonicalValue: 'Capital One', match: 'exact', confidence: 1 }]
        : [],
    });

    expect(direct?.metrics).toEqual(names);
    expect(result?.metrics).toEqual(names);
    for (const name of names) {
      expect(direct?.sql).toContain(`AS ${name}`);
      expect(result?.sql).toContain(`AS ${name}`);
    }
    expect(result?.sql).toContain("customer_name = 'Capital One'");
    expect(result?.dqlArtifact.source).toContain(`metrics = [${names.map((name) => `"${name}"`).join(', ')}]`);
    expect(result?.dqlArtifact.source).toContain('dimensions = []');
    expect(result?.dqlArtifact.source).not.toMatch(/\n\s*metric\s*=/);
  });
});

describe('metric/measure de-conflation (Phase 5)', () => {
  it('prefers a real metric over a same-concept measure of the same table', () => {
    // A dbt measure `bcm_amount` and a real metric `total_bcm` both live on
    // bcm_hdr; addCube tags the measure objectKind:'measure'. A "total bcm"
    // question must bind the METRIC, not the measure.
    const l = new SemanticLayer({
      metrics: [
        { name: 'bcm_amount', label: 'BCM Amount', description: 'Billed consumption measure.', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', objectKind: 'measure' },
        { name: 'total_bcm', label: 'Total BCM', description: 'Total billed consumption.', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', objectKind: 'metric' },
      ],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: 'Customer.', domain: 'bcm', sql: 'customer_name', type: 'string', table: 'bcm_hdr' }],
    });
    const question = 'total bcm by customer';
    const compiled = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
    });
    expect(compiled?.metric).toBe('total_bcm');
  });

  it('still binds a measure when the question names only the measure (fallback)', () => {
    const l = new SemanticLayer({
      metrics: [
        { name: 'bcm_line_amount', label: 'BCM Line Amount', description: 'Line-level billed consumption.', domain: 'bcm', sql: 'SUM(line_amount)', type: 'sum', table: 'bcm_dtl', objectKind: 'measure' },
      ],
      dimensions: [{ name: 'line_status', label: 'Line status', description: 'Status.', domain: 'bcm', sql: 'line_status', type: 'string', table: 'bcm_dtl' }],
    });
    const question = 'bcm line amount by line status';
    const compiled = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
    });
    expect(compiled?.metric).toBe('bcm_line_amount');
  });
});
describe('explicit metric naming — a nested phrase is not a second metric', () => {
  it('keeps only the specific metric when a broad name is contained in it', () => {
    const mk = (name: string) => ({ name, label: name, description: `${name}.`, domain: 'commerce', sql: 'amount', type: 'sum' as const, table: 'orders' });
    const l = new SemanticLayer({
      metrics: [mk('revenue'), mk('drink_revenue'), mk('orders'), mk('drink_orders')],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: 'Customer name.', domain: 'commerce', sql: 'customer_name', type: 'string', table: 'orders' }],
    });
    const question = 'drink revenue and drink orders by customer name';
    const composed = composeSemanticQueryForQuestion({
      semanticLayer: l,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
    });
    // "drink revenue" also contains the bare phrase "revenue"; selecting both
    // turned a two-metric question into a four-metric block.
    expect(composed?.metrics).toEqual(['drink_revenue', 'drink_orders']);
  });
});

describe('business synonyms reach the specific metric', () => {
  const mk = (name: string) => ({ name, label: name, description: `${name}.`, domain: 'commerce', sql: 'amount', type: 'sum' as const, table: 'orders' });
  const layerFor = () => new SemanticLayer({
    metrics: [mk('revenue'), mk('drink_revenue'), mk('food_revenue'), mk('drink_orders')],
    dimensions: [{ name: 'customer_name', label: 'Customer', description: 'Customer name.', domain: 'commerce', sql: 'customer_name', type: 'string', table: 'orders' }],
  });
  const metricsFor = (question: string) => composeSemanticQueryForQuestion({
    semanticLayer: layerFor(),
    question,
    questionPlan: buildAnalysisQuestionPlan(question),
  })?.metrics;

  it('resolves "beverage revenue" to drink_revenue, not the generic revenue', () => {
    // The question planner discards the qualifier — both "beverage revenue" and
    // "drink revenue" parse to measures:["revenue"], filters:[] — so verbatim
    // phrase matching is the only stage that can still see "beverage".
    expect(metricsFor('beverage revenue by customer name')).toEqual(['drink_revenue']);
    expect(metricsFor('drink revenue by customer name')).toEqual(['drink_revenue']);
  });

  it('does not let the routing hint re-broaden a qualified selection', () => {
    // The catalog's KG match is deliberately broad. Adding it back alongside the
    // specific metric the qualifier resolved would undo the narrowing.
    const composed = composeSemanticQueryForQuestion({
      semanticLayer: layerFor(),
      question: 'beverage revenue by customer name',
      questionPlan: buildAnalysisQuestionPlan('beverage revenue by customer name'),
      matchedMetric: { id: 'semantic:metric:revenue', kind: 'semantic_metric', name: 'revenue' } as never,
    });
    expect(composed?.metrics).toEqual(['drink_revenue']);
  });

  it('leaves an unqualified measure on the generic metric', () => {
    expect(metricsFor('revenue by customer name')).toEqual(['revenue']);
  });
});

describe('project vocabulary from DQL terms', () => {
  const officeLayer = (): SemanticLayer => new SemanticLayer({
    metrics: [
      { name: 'bcm_total', label: 'BCM Total', description: 'Booked contribution margin.', domain: 'finance', sql: 'bcm_amount', type: 'sum', table: 'fct_bcm' },
      { name: 'total_revenue', label: 'Total Revenue', description: 'Recognized revenue.', domain: 'finance', sql: 'amount', type: 'sum', table: 'fct_bcm' },
    ],
    dimensions: [{ name: 'channel', label: 'Channel', description: 'Sales channel.', domain: 'finance', sql: 'channel', type: 'string', table: 'fct_bcm' }],
  });

  it('resolves an internal term to the metric it names, with no change to the built-in synonym table', () => {
    // The built-in clusters are deliberately domain-neutral, so an internal
    // term like "BCM" used to be teachable ONLY by editing compose.ts. A term
    // declaring metricRefs now carries it instead.
    const question = 'what is BCM by channel';

    const withoutVocabulary = composeSemanticQueryForQuestion({
      semanticLayer: officeLayer(),
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
    });

    const withVocabulary = composeSemanticQueryForQuestion({
      semanticLayer: officeLayer(),
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
      vocabulary: { metricAliases: { bcm: ['bcm_total'] } },
    });

    expect(withVocabulary?.metric).toBe('bcm_total');
    // Guard the premise: if the bare question already resolved, the test would
    // prove nothing about the vocabulary.
    expect(withoutVocabulary?.metric).not.toBe('bcm_total');
  });

  it('extends the built-in vocabulary instead of replacing it', () => {
    // A project word reaches its metric through a project cluster...
    const question = 'show me margin by channel';
    expect(composeSemanticQueryForQuestion({
      semanticLayer: officeLayer(),
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
      vocabulary: { synonymClusters: [['margin', 'bcm']], metricAliases: { bcm: ['bcm_total'] } },
    })?.metric).toBe('bcm_total');

    // ...and a question the built-ins already handled resolves exactly as
    // before once a project cluster is present. Project vocabulary must never
    // shadow the defaults.
    const revenueQuestion = 'total revenue by channel';
    const plan = buildAnalysisQuestionPlan(revenueQuestion);
    expect(composeSemanticQueryForQuestion({
      semanticLayer: officeLayer(), question: revenueQuestion, questionPlan: plan,
    })?.metric).toBe('total_revenue');
    expect(composeSemanticQueryForQuestion({
      semanticLayer: officeLayer(), question: revenueQuestion, questionPlan: plan,
      vocabulary: { synonymClusters: [['margin', 'bcm']], metricAliases: { bcm: ['bcm_total'] } },
    })?.metric).toBe('total_revenue');
  });

  it('does not leak the vocabulary from one call into the next', () => {
    const question = 'what is BCM by channel';
    composeSemanticQueryForQuestion({
      semanticLayer: officeLayer(),
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
      vocabulary: { metricAliases: { bcm: ['bcm_total'] } },
    });
    // A long-lived server serves many questions; the overlay must be per-call.
    expect(composeSemanticQueryForQuestion({
      semanticLayer: officeLayer(),
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
    })?.metric).not.toBe('bcm_total');
  });
});

describe('time-sliced answers default to most recent first', () => {
  const timeLayer = (): SemanticLayer => new SemanticLayer({
    metrics: [{ name: 'revenue', label: 'Revenue', description: 'Revenue.', domain: 'finance', sql: 'amount', type: 'sum', table: 'orders' }],
    dimensions: [
      { name: 'channel', label: 'Channel', description: 'Channel.', domain: 'finance', sql: 'channel', type: 'string', table: 'orders' },
      {
        name: 'metric_time', label: 'Metric time', description: 'Aggregate time axis.', domain: 'finance',
        sql: 'ordered_at', type: 'date', table: 'orders', isTimeDimension: true,
        granularities: ['day', 'week', 'month', 'quarter', 'year'], baseGranularity: 'day', primaryTime: true,
      },
    ],
  });

  it('orders a time breakdown newest first instead of emitting no ordering', () => {
    // With no ORDER BY the warehouse returned rows in whatever order it liked --
    // in practice oldest first -- so a LIMIT kept the OLDEST periods and "revenue
    // by month" showed the start of history rather than what just happened.
    const compiled = composeSemanticQueryFromMembers({
      semanticLayer: timeLayer(),
      question: 'revenue by month',
      selection: { metrics: ['revenue'], timeDimension: { name: 'metric_time', granularity: 'month' } },
    });
    expect(compiled?.sql).toContain('ORDER BY metric_time_month DESC');
  });

  it('lets an explicit ranking win, because that ordering is the question', () => {
    const compiled = composeSemanticQueryFromMembers({
      semanticLayer: timeLayer(),
      question: 'lowest revenue month',
      selection: {
        metrics: ['revenue'],
        timeDimension: { name: 'metric_time', granularity: 'month' },
        orderBy: [{ name: 'revenue', direction: 'asc' }],
      },
    });
    expect(compiled?.sql).toContain('ORDER BY revenue ASC');
    expect(compiled?.sql).not.toContain('metric_time_month DESC');
  });

  it('adds no ordering when there is no time axis to order by', () => {
    const compiled = composeSemanticQueryFromMembers({
      semanticLayer: timeLayer(),
      question: 'revenue by channel',
      selection: { metrics: ['revenue'], dimensions: ['channel'] },
    });
    expect(compiled?.sql).not.toContain('ORDER BY');
  });
});

describe('composeSemanticQueryForQuestion — closest metric by name or label (MCP 2026-10-23)', () => {
  // The jaffle-shop shape the Claude Desktop recording asked about.
  function jaffleLayer(options: { averageOrderValueOffset?: boolean } = {}): SemanticLayer {
    return new SemanticLayer({
      metrics: [
        { name: 'orders', label: 'Orders', description: 'Count of orders.', domain: 'orders', sql: '1', type: 'sum', table: 'orders', aggTimeDimension: 'order_date' },
        { name: 'drink_orders', label: 'Drink Orders', description: 'Count of orders that contain drink order items', domain: 'orders', sql: '1', type: 'sum', table: 'orders', aggTimeDimension: 'order_date' },
        { name: 'large_orders', label: 'Large Orders', description: 'Count of orders with order total over 20.', domain: 'orders', sql: '1', type: 'sum', table: 'orders', aggTimeDimension: 'order_date' },
        { name: 'revenue', label: 'Revenue', description: 'Sum of the product revenue for each order item.', domain: 'order_item', sql: 'product_price', type: 'sum', table: 'order_items', aggTimeDimension: 'ordered_at' },
        { name: 'food_revenue', label: 'Food Revenue', description: 'The revenue from food in each order', domain: 'order_item', sql: 'case when is_food_item then product_price else 0 end', type: 'sum', table: 'order_items', aggTimeDimension: 'ordered_at' },
        {
          name: 'food_revenue_pct', label: 'Food Revenue %', description: 'The % of order revenue from food.', domain: 'order_item', sql: '', type: 'custom', table: '', cube: 'order_items',
          metricType: 'ratio', typeParams: { numerator: 'food_revenue', denominator: 'revenue' },
        },
        { name: 'count_lifetime_orders', label: 'Count Lifetime Orders', description: 'Count of lifetime orders', domain: 'customers', sql: 'count_lifetime_orders', type: 'sum', table: 'customers' },
        { name: 'lifetime_spend_pretax', label: 'LTV Pre-tax', description: "Customer's lifetime spend before tax", domain: 'customers', sql: 'lifetime_spend_pretax', type: 'sum', table: 'customers' },
        { name: 'customers', label: 'customers', description: 'Count of unique customers', domain: 'customers', sql: 'customer_id', type: 'count_distinct', table: 'customers' },
        {
          name: 'average_order_value', label: 'Average Order Value', description: 'LTV pre-tax / number of orders', domain: 'customers', sql: '', type: 'custom', table: '', cube: 'customers',
          metricType: 'derived',
          typeParams: {
            expr: 'lifetime_spend_pretax / count_lifetime_orders',
            metrics: [
              { name: 'count_lifetime_orders' },
              options.averageOrderValueOffset
                ? { name: 'lifetime_spend_pretax', offset_window: '1 month' }
                : { name: 'lifetime_spend_pretax' },
            ],
          },
        },
      ],
      dimensions: [
        { name: 'customer_name', label: 'customer_name', description: "Customers' full name.", sql: 'customer_name', type: 'string', table: 'customers' },
        { name: 'customer_type', label: 'customer_type', description: "Options are 'new' or 'returning', indicating if a customer has ordered more than once.", sql: 'customer_type', type: 'string', table: 'customers' },
        { name: 'ordered_at', label: 'ordered_at', description: '', sql: 'ordered_at', type: 'time', table: 'order_items', isTimeDimension: true },
        { name: 'order_date', label: 'order_date', description: '', sql: 'ordered_at', type: 'time', table: 'orders', isTimeDimension: true },
        { name: 'first_ordered_at', label: 'first_ordered_at', description: '', sql: 'first_ordered_at', type: 'time', table: 'customers', isTimeDimension: true },
      ],
    } as never);
  }
  const compose = (question: string, semanticLayer = jaffleLayer()) => composeSemanticQueryForQuestion({
    semanticLayer,
    question,
    questionPlan: buildAnalysisQuestionPlan(question),
  });

  it('answers average order value by customer type with average_order_value, a derived metric', () => {
    const result = compose('What is the average order value by customer type?');
    expect(result?.metrics).toEqual(['average_order_value']);
    expect(result?.dimensions).toEqual(['customer_type']);
    expect(result?.sql).toContain('lifetime_spend_pretax / ratio_inputs.count_lifetime_orders AS average_order_value');
  });

  it('reads "new versus returning customers" as the documented values of customer_type, not a customers count', () => {
    const result = compose('What is the average order value for new versus returning customers?');
    expect(result?.metrics).toEqual(['average_order_value']);
    expect(result?.dimensions).toEqual(['customer_type']);
  });

  it('answers a share question with the share metric, per month on its own time dimension', () => {
    const result = compose('What share of revenue comes from food each month?');
    expect(result?.metrics).toEqual(['food_revenue_pct']);
    expect(result?.timeDimension).toEqual({ name: 'ordered_at', granularity: 'month' });
  });

  it('keeps the month grain of "each month" when no time column is named', () => {
    const result = compose('How many large orders did we get each month?');
    expect(result?.metrics).toEqual(['large_orders']);
    expect(result?.timeDimension).toEqual({ name: 'order_date', granularity: 'month' });
  });

  it('returns no match rather than drop a year or date range it cannot filter on', () => {
    expect(compose('How many large orders did we get each month in 2025?')).toBeUndefined();
    expect(compose('How many large orders since March 2025?')).toBeUndefined();
    expect(compose('How many large orders did we get each month?')?.metrics).toEqual(['large_orders']);
  });

  it('names no metric from generic words alone', () => {
    // "employees" is unknown, so the plan is just `count`; count_lifetime_orders is not an answer.
    expect(compose('How many employees work at each store?')).toBeUndefined();
  });

  it('returns no match instead of an unrelated metric when the named metric cannot compile', () => {
    // An offset window is MetricFlow-only; drink_orders shares only the word "order".
    expect(compose('What is the average order value by customer type?', jaffleLayer({ averageOrderValueOffset: true }))).toBeUndefined();
  });
});

describe('composeSemanticQueryForQuestion — every breakdown and filter the question asks for (MCP 2026-10-23)', () => {
  // jaffle-shop shape: orders reach the location through the order_to_location join.
  function ordersLayer(): SemanticLayer {
    return new SemanticLayer({
      metrics: [
        { name: 'orders', label: 'Orders', description: 'Count of orders.', domain: 'orders', sql: '1', type: 'sum', table: 'orders', aggTimeDimension: 'ordered_at' },
        { name: 'large_orders', label: 'Large Orders', description: 'Count of orders with order total over 20.', domain: 'orders', sql: '1', type: 'sum', table: 'orders', aggTimeDimension: 'ordered_at' },
        { name: 'revenue', label: 'Revenue', description: 'Sum of order revenue.', domain: 'orders', sql: 'order_total', type: 'sum', table: 'orders', aggTimeDimension: 'ordered_at' },
      ],
      dimensions: [
        { name: 'location_name', label: 'location_name', description: 'The name of the store location.', sql: 'location_name', type: 'string', table: 'orders' },
        { name: 'customer_type', label: 'customer_type', description: "Options are 'new' or 'returning'.", sql: 'customer_type', type: 'string', table: 'orders' },
        { name: 'ordered_at', label: 'ordered_at', description: '', sql: 'ordered_at', type: 'time', table: 'orders', isTimeDimension: true },
      ],
    } as never);
  }
  const coverage = (question: string) => composeSemanticQueryForQuestionWithCoverage({
    semanticLayer: ordersLayer(),
    question,
    questionPlan: buildAnalysisQuestionPlan(question),
  });

  it('refuses the all-orders total for the busiest hour of the day in Philadelphia, and names both missing parts', () => {
    const out = coverage('What was the busiest hour of the day for orders in Philadelphia?');
    expect(out.result).toBeUndefined();
    expect(out.metric).toBe('orders');
    expect(out.unexpressed).toEqual(['filter "Philadelphia"', 'breakdown "hour of the day"']);
    expect(composeSemanticQueryForQuestion({
      semanticLayer: ordersLayer(),
      question: 'What was the busiest hour of the day for orders in Philadelphia?',
      questionPlan: buildAnalysisQuestionPlan('What was the busiest hour of the day for orders in Philadelphia?'),
    })).toBeUndefined();
  });

  it('refuses large orders in Brooklyn in March 2025, naming the member and the date range', () => {
    const out = coverage('How many large orders in Brooklyn in March 2025?');
    expect(out.result).toBeUndefined();
    expect(out.metric).toBe('large_orders');
    expect(out.unexpressed).toEqual(['date range "in March 2025"', 'filter "Brooklyn"']);
  });

  it('refuses a named member, a month with no year, or a relative window it cannot filter on', () => {
    expect(coverage('What is total revenue in Brooklyn?').unexpressed).toEqual(['filter "Brooklyn"']);
    expect(coverage('How many large orders in March?').unexpressed).toEqual(['date range "in March"']);
    expect(coverage('What was revenue this year?').result).toBeUndefined();
    expect(coverage('What was revenue last quarter?').result).toBeUndefined();
    expect(coverage('How many orders on weekends?').unexpressed).toEqual(['breakdown "weekends"']);
    expect(coverage('How many orders per hour?').unexpressed).toEqual(['breakdown "hour"']);
  });

  it('compiles the filter when the question names the member with its dimension', () => {
    const out = coverage('How many orders at the Philadelphia location?');
    expect(out.unexpressed).toEqual([]);
    expect(out.result?.filters).toEqual([{ dimension: 'location_name', operator: 'equals', values: ['Philadelphia'] }]);
    expect(out.result?.sql).toContain("'Philadelphia'");
  });

  it('keeps answering questions whose breakdowns the members express', () => {
    expect(coverage('How many large orders did we get each month?').result?.timeDimension).toEqual({ name: 'ordered_at', granularity: 'month' });
    expect(coverage('What is revenue by customer type?').result?.dimensions).toEqual(['customer_type']);
    expect(coverage('Which store location had the most orders?').result?.dimensions).toEqual(['location_name']);
    expect(coverage('How many orders by location?').unexpressed).toEqual([]);
  });

  it('does not read a lower-case word as a member value', () => {
    // "new" and "returning" are customer_type values the dimension already groups by.
    expect(coverage('What is revenue for new versus returning customers?').unexpressed).toEqual([]);
  });
});
