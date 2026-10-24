import { describe, expect, it } from 'vitest';
import { formatDQL } from './formatter.js';
import { parse } from '../parser/parser.js';

describe('formatDQL', () => {
  it('formats domain declarations and block contract metadata idempotently', () => {
    const source = `domain "Customer"{owner="customer-analytics" businessOwner="Customer Success" boundedContext="Customer boundary" sourceSystems=["crm","orders"] primaryTerms=["Customer"] reviewCadence="monthly" tags=["customer"]}
block "Customer Orders Rollup"{domain="Customer" type="custom" pattern="entity_rollup" grain="customer_id" entities=["Customer"] outputs=["customer_id","total_orders"] dimensions=["segment"] allowedFilters=["order_date"] parameterPolicy{start_date="dynamic" active_status="static"} filterBindings{date_range="order_date"} sourceSystems=["orders"] replacementFor=["Legacy Orders"] query="""SELECT customer_id, COUNT(*) AS total_orders FROM orders GROUP BY customer_id"""}`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('domain "Customer" {');
    expect(formatted).toContain('boundedContext = "Customer boundary"');
    expect(formatted).toContain('pattern = "entity_rollup"');
    expect(formatted).toContain('grain = "customer_id"');
    expect(formatted).toContain('outputs = ["customer_id", "total_orders"]');
    expect(formatted).toContain('dimensions = ["segment"]');
    expect(formatted).toContain('parameterPolicy {');
    expect(formatted).toContain('start_date = "dynamic"');
    expect(formatted).toContain('filterBindings {');
    expect(formatted).toContain('date_range = "order_date"');
    expect(formatted).toContain('replacementFor = ["Legacy Orders"]');
    expect(formatDQL(formatted)).toBe(formatted);
  });

  it('formats dashboard charts and filters with stable indentation', () => {
    const source = `dashboard "Daily"{
@cache(300)
chart.line(SELECT order_date, SUM(revenue) as total FROM orders GROUP BY order_date,x=order_date,y=total,title="Revenue")
filter.dropdown(SELECT DISTINCT region FROM orders,label="Region",param="region")
}`;

    const formatted = formatDQL(source);

    expect(formatted).toBe(`dashboard "Daily" {
  @cache(300)
  chart.line(
    SELECT order_date, SUM(revenue) as total FROM orders GROUP BY order_date,
    x = order_date,
    y = total,
    title = "Revenue"
  )
  filter.dropdown(
    SELECT DISTINCT region FROM orders,
    label = "Region",
    param = "region"
  )
}
`);
  });

  it('formats block declarations with params/query/visualization/tests', () => {
    const source = `block "rev_by_segment" {
      domain = "sales"
      type = "custom"
      params { region = "NA" }
      query = """
        SELECT segment, SUM(revenue) as rev
        FROM orders
        GROUP BY segment
      """
      visualization { x = segment y = rev title = "Revenue by Segment" }
      tests {
        assert rev > 0
        assert segment IN ["Enterprise","SMB"]
      }
    }`;
    const formatted = formatDQL(source);

    expect(formatted).toContain('block "rev_by_segment" {');
    expect(formatted).toContain('params {');
    expect(formatted).toContain('query = """');
    expect(formatted).toContain('visualization {');
    expect(formatted).toContain('tests {');
    expect(formatted).toContain('assert segment IN ["Enterprise", "SMB"]');
  });

  it('formats v3 dataset metadata deterministically without converting legacy grain metadata', () => {
    const source = `block "Order lines dataset" {
      status = "certified"
      grain = { keys = ["order_line_id"], entities = ["order_line"], keyEvidence = "proof.order-lines", timeGrain = "day" }
      measures {
        net_amount { from = "net_amount", additive = "additive", allowedAggs = ["sum"], agg = "sum" }
      }
      fields {
        net_amount { type = "number", role = "attribute" }
        order_line_id { type = "string", role = "key" }
      }
      query = """SELECT order_line_id, net_amount FROM order_lines"""
    }`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('grain = {');
    expect(formatted).toContain('keyEvidence = "proof.order-lines"');
    expect(formatted).toContain('fields {');
    expect(formatted).toContain('net_amount { role = "attribute", type = "number" }');
    expect(formatted).toContain('measures {');
    expect(formatted).toContain('net_amount { agg = "sum", from = "net_amount", additive = "additive", allowedAggs = ["sum"] }');
    expect(formatDQL(formatted)).toBe(formatted);
    const parsed = parse(formatted);
    const block = parsed.statements[0];
    expect(block.kind).toBeDefined();
  });

  it('formats calculated Dataset measures and aggregate time-bucket declarations deterministically', () => {
    const formatted = formatDQL(`block "Daily Orders" {
      type = "custom"
      status = "review"
      grain = { entities = ["order"], keys = ["order_date", "customer_id"], keyEvidence = "proof.daily", timeGrain = "day", timeBucketBy = "order_date", aggregate = true }
      fields { order_date { role = "time", type = "date", grains = ["day", "month"] } customer_id { role = "key", type = "string" } net_amount { role = "attribute", type = "number" } margin_amount { role = "attribute", type = "number" } }
      measures { gross_margin { agg = "sum", expression = "SUM(margin_amount)", additive = "additive", allowedAggs = ["sum"] } orders_by_day { agg = "count_distinct", from = "customer_id", timeBucketBy = "order_date", additive = "additive", allowedAggs = ["count_distinct"] } }
      query = """SELECT order_date, customer_id, net_amount, margin_amount FROM daily_orders"""
    }`);

    expect(formatted).toContain('timeBucketBy = "order_date"');
    expect(formatted).toContain('aggregate = true');
    expect(formatted).toContain('gross_margin { agg = "sum", expression = "SUM(margin_amount)", additive = "additive", allowedAggs = ["sum"] }');
    expect(formatted).toContain('orders_by_day { agg = "count_distinct", from = "customer_id", timeBucketBy = "order_date", additive = "additive", allowedAggs = ["count_distinct"] }');
    expect(formatDQL(formatted)).toBe(formatted);
  });

  it('canonicalizes legacy singular semantic metrics to the universal array contract', () => {
    const formatted = formatDQL(`block "revenue" {
      type = "semantic"
      metric = "total_revenue"
    }`);

    expect(formatted).toContain('metrics = ["total_revenue"]');
    expect(formatted).toContain('dimensions = []');
    expect(formatted).not.toMatch(/\bmetric\s*=/);
    expect(formatDQL(formatted)).toBe(formatted);
  });

  it('preserves block status and agent-facing metadata', () => {
    const source = `block "fraud_by_region" {
      domain = "cards"
      type = "custom"
      status = "certified"
      description = "Fraud exposure by region"
      tags = ["fraud", "cards"]
      owner = "mei.chen@acme-bank.com"
      llmContext = "Use for fraud monitoring questions."
      examples = [{ question = "Where is fraud highest?", sql = "SELECT region FROM fraud" }]
      invariants = ["exposure_usd >= 0"]
      query = """
        SELECT region, SUM(exposure_usd) AS exposure_usd
        FROM fraud_alerts
        GROUP BY 1
      """
    }`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('status = "certified"');
    expect(formatted).toContain('llmContext = "Use for fraud monitoring questions."');
    expect(formatted).toContain(
      'examples = [{ question = "Where is fraud highest?", sql = "SELECT region FROM fraud" }]',
    );
    expect(formatted).toContain('invariants = ["exposure_usd >= 0"]');
  });

  it('formats digest declarations without dropping content', () => {
    const source = `digest "Weekly Exec" {
narrative { prompt = "Summarize the movement" sources = [ref("Revenue")] }
chart.line(SELECT week, revenue FROM weekly_revenue,x=week,y=revenue)
}`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('digest "Weekly Exec" {');
    expect(formatted).toContain('narrative {');
    expect(formatted).toContain('prompt = "Summarize the movement"');
    expect(formatted).toContain('sources = [ref("Revenue")]');
    expect(formatted).toContain('chart.line(');
    expect(() => parse(formatted)).not.toThrow();
  });

  it('formats business_view declarations with stable includes', () => {
    const source = `business_view "Customer 360"{
domain="Customer"
status="draft"
description="Complete customer view"
owner="Customer Analytics"
terms=["Customer"]
businessOutcome="Improve retention decisions"
includes{block "Customer Identity" business_view "Customer Service Summary"}
}`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('business_view "Customer 360" {');
    expect(formatted).toContain('domain = "Customer"');
    expect(formatted).toContain('terms = ["Customer"]');
    expect(formatted).toContain('businessOutcome = "Improve retention decisions"');
    expect(formatted).toContain('includes {');
    expect(formatted).toContain('block "Customer Identity"');
    expect(formatted).toContain('business_view "Customer Service Summary"');
    expect(() => parse(formatted)).not.toThrow();
  });

  it('formats term declarations and block term references', () => {
    const source = `term "Customer"{
domain="Customer"
type="entity"
status="draft"
description="Customer definition"
owner="Customer Analytics"
identifiers=["customer_id"]
synonyms=["Account"]
businessRules=["One row per customer_id"]
}

block "Customer Identity"{
domain="Customer"
type="custom"
terms=["Customer"]
query="""SELECT customer_id FROM dim_customer"""
}`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('term "Customer" {');
    expect(formatted).toContain('type = "entity"');
    expect(formatted).toContain('identifiers = ["customer_id"]');
    expect(formatted).toContain('terms = ["Customer"]');
    expect(() => parse(formatted)).not.toThrow();
    expect(formatDQL(formatted)).toBe(formatted);
  });

  it('is idempotent and parseable', () => {
    const source = `workbook "Ops Review" {
  page "Overview" {
    layout(columns = 12) {
      row {
        chart.bar(
          SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
          x = category,
          y = total
        ) span 6
        chart.sparkline(
          SELECT order_date, SUM(revenue) as total FROM orders GROUP BY order_date,
          x = order_date,
          y = total
        ) span 6
      }
    }
  }
}`;

    const once = formatDQL(source);
    const twice = formatDQL(once);
    expect(twice).toBe(once);
    expect(() => parse(twice)).not.toThrow();
  });

  it('keeps a block\'s question aliases and caveats', () => {
    const formatted = formatDQL(`block "x" {
  type = "custom"
  caveats = "Excludes refunds"
  synonyms = ["sales", "bookings"]
  query = """SELECT 1"""
}`);
    expect(formatted).toContain('caveats = ["Excludes refunds"]');
    expect(formatted).toContain('synonyms = ["sales", "bookings"]');
    expect(() => parse(formatted)).not.toThrow();
  });
});
