import { describe, it, expect } from 'vitest';
import { Parser, parse } from './parser.js';
import { NodeKind } from '../ast/nodes.js';
import { analyze } from '../semantic/analyzer.js';

describe('Parser', () => {
  it('parses domain declarations and enterprise block contract metadata', () => {
    const source = `domain "Customer" {
      owner = "customer-analytics"
      businessOwner = "Customer Success"
      boundedContext = "Customer identity, lifecycle, value, and retention"
      sourceSystems = ["crm", "orders"]
      primaryTerms = ["Customer", "Lifetime Value"]
      reviewCadence = "monthly"
      tags = ["customer", "retention"]
    }

    block "Customer Orders Rollup" {
      domain = "Customer"
      type = "custom"
      status = "draft"
      pattern = "entity_rollup"
      grain = "customer_id"
      entities = ["Customer"]
      terms = ["Customer", "Lifetime Value"]
      outputs = ["customer_id", "total_orders", "lifetime_revenue"]
      dimensions = ["segment", "region"]
      allowedFilters = ["order_date", "segment", "region"]
      parameterPolicy {
        start_date = "dynamic"
        active_status = "static"
      }
      filterBindings {
        date_range = "order_date"
        segment = "segment"
      }
      sourceSystems = ["orders"]
      replacementFor = ["Legacy Customer Orders"]

      query = """
        SELECT customer_id, COUNT(*) AS total_orders
        FROM orders
        GROUP BY customer_id
      """
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(2);
    const domain = ast.statements[0];
    expect(domain.kind).toBe(NodeKind.DomainDecl);
    if (domain.kind === NodeKind.DomainDecl) {
      expect(domain.name).toBe('Customer');
      expect(domain.sourceSystems).toEqual(['crm', 'orders']);
      expect(domain.primaryTerms).toEqual(['Customer', 'Lifetime Value']);
    }

    const block = ast.statements[1];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.grain).toBe('customer_id');
      expect(block.pattern).toBe('entity_rollup');
      expect(block.entities).toEqual(['Customer']);
      expect(block.outputs).toEqual(['customer_id', 'total_orders', 'lifetime_revenue']);
      expect(block.dimensions).toEqual(['segment', 'region']);
      expect(block.dimensionsRef).toBeUndefined();
      expect(block.allowedFilters).toEqual(['order_date', 'segment', 'region']);
      expect(block.parameterPolicy).toEqual([
        expect.objectContaining({ name: 'start_date', policy: 'dynamic' }),
        expect.objectContaining({ name: 'active_status', policy: 'static' }),
      ]);
      expect(block.filterBindings).toEqual([
        expect.objectContaining({ filter: 'date_range', binding: 'order_date' }),
        expect.objectContaining({ filter: 'segment', binding: 'segment' }),
      ]);
      expect(block.sourceSystems).toEqual(['orders']);
      expect(block.replacementFor).toEqual(['Legacy Customer Orders']);
    }
  });

  it('parses a standalone chart call', () => {
    const source = `chart.line(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue,
      title = "Revenue Trend"
    )`;

    const ast = parse(source);
    expect(ast.kind).toBe(NodeKind.Program);
    expect(ast.statements).toHaveLength(1);

    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('line');
      expect(chart.query.rawSQL).toContain('SELECT date, revenue FROM sales');
      expect(chart.args).toHaveLength(3);
      expect(chart.args[0].name).toBe('x');
      expect(chart.args[1].name).toBe('y');
      expect(chart.args[2].name).toBe('title');
    }
  });

  it('parses legacy block query sections', () => {
    const source = `block "Legacy SQL Shape" {
      domain = "nba"
      owner = "analytics"
      description = "Legacy query block shape"

      query {
        sql = """
          SELECT player_name, SUM(points) AS total_points
          FROM transformed.player_stats
          GROUP BY player_name
        """
      }
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.query?.rawSQL).toContain('SELECT player_name');
      expect(block.query?.rawSQL).toContain('GROUP BY player_name');
    }
  });

  it('parses the v3 dataset grain and separate physical and measure namespaces', () => {
    const ast = parse(`block "Order lines dataset" {
      domain = "commerce"
      type = "custom"
      status = "certified"
      grain = {
        entities = ["order_line"]
        keys = ["order_line_id"]
        keyEvidence = "proof.order-lines"
        timeGrain = "day"
      }
      fields {
        order_line_id { role = "key", type = "string" }
        order_date { role = "time", type = "date", grains = ["day", "month"], primary = true }
        net_amount { role = "attribute", type = "number" }
      }
      measures {
        net_amount { agg = "sum", from = "net_amount", additive = "additive", allowedAggs = ["sum"] }
        margin_rate { agg = "ratio", numerator = "net_amount", denominator = "cost_amount", additive = "semi_additive", allowedAggs = ["ratio"] }
      }
      query = """SELECT order_line_id, order_date, net_amount, cost_amount FROM order_lines"""
    }`);

    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.grain).toBeUndefined();
      expect(block.datasetGrain).toMatchObject({ entities: ['order_line'], keys: ['order_line_id'], keyEvidence: 'proof.order-lines' });
      expect(block.datasetFields?.map((field) => field.name)).toEqual(['order_line_id', 'order_date', 'net_amount']);
      expect(block.datasetMeasures?.map((measure) => measure.name)).toEqual(['net_amount', 'margin_rate']);
      expect(block.datasetMeasures?.[1]).toMatchObject({ aggregation: 'ratio', numerator: 'net_amount', denominator: 'cost_amount' });
    }
  });

  it('parses calculated Dataset measures and aggregate native time-bucket evidence without changing legacy grain', () => {
    const ast = parse(`block "Daily order rollup" {
      domain = "commerce"
      type = "custom"
      status = "review"
      grain = {
        entities = ["order"]
        keys = ["order_date", "customer_id"]
        keyEvidence = "proof.daily-orders"
        timeGrain = "day"
        timeBucketBy = "order_date"
        aggregate = true
      }
      fields {
        order_date { role = "time", type = "date", grains = ["day", "month", "year"] }
        customer_id { role = "key", type = "string" }
        net_amount { role = "attribute", type = "number" }
        margin_amount { role = "attribute", type = "number" }
      }
      measures {
        gross_margin { agg = "sum", expression = "SUM(margin_amount)", additive = "additive", allowedAggs = ["sum"] }
        average_order_value { agg = "ratio", expression = "SUM(net_amount) / NULLIF(COUNT(order_date), 0)", additive = "non_additive", allowedAggs = ["ratio"] }
        orders_by_day { agg = "count_distinct", from = "customer_id", timeBucketBy = "order_date", additive = "additive", allowedAggs = ["count_distinct"] }
      }
      query = """SELECT order_date, customer_id, net_amount, margin_amount FROM daily_orders"""
    }`);

    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.grain).toBeUndefined();
      expect(block.datasetGrain).toMatchObject({ aggregate: true, timeGrain: 'day', timeBucketBy: 'order_date' });
      expect(block.datasetMeasures?.[0]).toMatchObject({ aggregation: 'sum', expression: 'SUM(margin_amount)' });
      expect(block.datasetMeasures?.[1]).toMatchObject({ aggregation: 'ratio', expression: 'SUM(net_amount) / NULLIF(COUNT(order_date), 0)' });
      expect(block.datasetMeasures?.[2]).toMatchObject({ aggregation: 'count_distinct', timeBucketBy: 'order_date' });
    }
  });

  it('parses semantic block order and limit draft metadata', () => {
    const ast = parse(`block "Top Revenue Channels" {
      domain = "finance"
      type = "semantic"
      status = "draft"
      metric = "total_revenue"
      dimensions = ["channel"]
      time_dimension = "order_date"
      granularity = "month"
      requested_filters = ["channel=Online"]
      order_by = ["total_revenue desc"]
      limit = 5
      draft_path = "blocks/_drafts/top_revenue_channels.dql"
    }`);

    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.metricRef).toBe('total_revenue');
      expect(block.dimensionsRef).toEqual(['channel']);
      expect(block.timeDimension).toBe('order_date');
      expect(block.granularity).toBe('month');
      expect(block.requestedFilters).toEqual(['channel=Online']);
      expect(block.orderBy).toEqual(['total_revenue desc']);
      expect(block.limit).toBe(5);
      expect(block.draftPath).toBe('blocks/_drafts/top_revenue_channels.dql');
    }
  });

  it('parses a dashboard with variables and charts', () => {
    const source = `dashboard "Daily Report" {
      let today = CURRENT_DATE

      chart.kpi(
        SELECT SUM(revenue) as total FROM orders,
        metrics = ["total"],
        compare_to_previous = true
      )

      chart.bar(
        SELECT product, SUM(qty) as units FROM items GROUP BY product,
        x = product,
        y = units,
        title = "Top Products"
      )
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);

    const dashboard = ast.statements[0];
    expect(dashboard.kind).toBe(NodeKind.Dashboard);
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.title).toBe('Daily Report');
      expect(dashboard.body).toHaveLength(3); // 1 variable + 2 charts

      // Variable
      expect(dashboard.body[0].kind).toBe(NodeKind.VariableDecl);

      // KPI chart
      expect(dashboard.body[1].kind).toBe(NodeKind.ChartCall);

      // Bar chart
      expect(dashboard.body[2].kind).toBe(NodeKind.ChartCall);
    }
  });

  it('parses decorators', () => {
    const source = `@schedule(daily, "9:00 AM")
    @email_to("team@company.com")
    dashboard "Report" {
      chart.line(
        SELECT date, value FROM data,
        x = date,
        y = value
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    expect(dashboard.kind).toBe(NodeKind.Dashboard);
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.decorators).toHaveLength(2);
      expect(dashboard.decorators[0].name).toBe('schedule');
      expect(dashboard.decorators[0].arguments).toHaveLength(2);
      expect(dashboard.decorators[1].name).toBe('email_to');
    }
  });

  it('parses chart with theme and styling options', () => {
    const source = `chart.line(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue,
      theme = "dark",
      color = "#FF6B6B",
      line_width = 3,
      fill_opacity = 0.3,
      title = "Revenue Trend",
      show_grid = true,
      show_legend = true
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.args).toHaveLength(9);
      const themeArg = chart.args.find((a) => a.name === 'theme');
      expect(themeArg).toBeDefined();
      if (themeArg && themeArg.value.kind === NodeKind.StringLiteral) {
        expect(themeArg.value.value).toBe('dark');
      }
    }
  });

  it('parses SQL with template interpolation', () => {
    const source = `dashboard "Test" {
      let today = CURRENT_DATE

      chart.line(
        SELECT * FROM orders WHERE date = '{today}',
        x = date,
        y = revenue
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    if (dashboard.kind === NodeKind.Dashboard) {
      const chart = dashboard.body[1];
      if (chart.kind === NodeKind.ChartCall) {
        expect(chart.query.interpolations).toHaveLength(1);
        expect(chart.query.interpolations[0].variableName).toBe('today');
      }
    }
  });

  it('parses SQL with ${param} interpolation', () => {
    const source = `dashboard "Test" {
      param region: string = "NA"

      chart.line(
        SELECT * FROM orders WHERE region = \${region},
        x = date,
        y = revenue
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    if (dashboard.kind === NodeKind.Dashboard) {
      const chart = dashboard.body[1];
      if (chart.kind === NodeKind.ChartCall) {
        expect(chart.query.interpolations).toHaveLength(1);
        expect(chart.query.interpolations[0].variableName).toBe('region');
      }
    }
  });

  it('parses array literal arguments', () => {
    const source = `chart.kpi(
      SELECT SUM(rev) as r, COUNT(*) as c FROM t,
      metrics = ["r", "c"]
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    if (chart.kind === NodeKind.ChartCall) {
      const metricsArg = chart.args.find((a) => a.name === 'metrics');
      expect(metricsArg).toBeDefined();
      if (metricsArg && metricsArg.value.kind === NodeKind.ArrayLiteral) {
        expect(metricsArg.value.elements).toHaveLength(2);
      }
    }
  });

  it('handles empty dashboard', () => {
    const source = `dashboard "Empty" { }`;
    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    if (ast.statements[0].kind === NodeKind.Dashboard) {
      expect(ast.statements[0].body).toHaveLength(0);
    }
  });

  it('parses chart with drill_down and link_to interaction args', () => {
    const source = `chart.bar(
      SELECT category, SUM(revenue) as rev FROM orders GROUP BY category,
      x = category,
      y = rev,
      title = "Revenue by Category",
      drill_down = "SELECT * FROM orders WHERE category = '{clicked_value}'",
      link_to = "detail.dql"
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.args).toHaveLength(5);
      const drillArg = chart.args.find((a) => a.name === 'drill_down');
      expect(drillArg).toBeDefined();
      if (drillArg && drillArg.value.kind === NodeKind.StringLiteral) {
        expect(drillArg.value.value).toContain('{clicked_value}');
      }
      const linkArg = chart.args.find((a) => a.name === 'link_to');
      expect(linkArg).toBeDefined();
      if (linkArg && linkArg.value.kind === NodeKind.StringLiteral) {
        expect(linkArg.value.value).toBe('detail.dql');
      }
    }
  });

  it('parses chart with filter_by arg', () => {
    const source = `chart.pie(
      SELECT category, COUNT(*) as cnt FROM products GROUP BY category,
      x = category,
      y = cnt,
      filter_by = category
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    if (chart.kind === NodeKind.ChartCall) {
      const filterArg = chart.args.find((a) => a.name === 'filter_by');
      expect(filterArg).toBeDefined();
      if (filterArg && filterArg.value.kind === NodeKind.Identifier) {
        expect(filterArg.value.name).toBe('category');
      }
    }
  });

  it('parses hyphen chart aliases and normalizes chart type', () => {
    const source = `chart.grouped-bar(
      SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
      x = category,
      y = total
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('grouped_bar');
    }
  });

  it('parses tree-map alias and normalizes to treemap', () => {
    const source = `chart.tree-map(
      SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
      x = category,
      y = total
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('treemap');
    }
  });

  it('parses business_view declarations with block and business_view includes', () => {
    const source = `business_view "Customer 360" {
      domain = "Customer"
      status = "draft"
      description = "Complete customer view for account review."
      owner = "Customer Analytics"
      tags = ["customer", "360"]
      terms = ["Customer", "Customer Health"]
      businessOutcome = "Understand customer value, activity, and service risk."
      decisionUse = "Account planning and churn review"
      reviewCadence = "weekly"

      includes {
        block "Customer Identity"
        block "Customer Orders Rollup"
        business_view "Customer Service Summary"
      }
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    const view = ast.statements[0];
    expect(view.kind).toBe(NodeKind.BusinessViewDecl);
    if (view.kind === NodeKind.BusinessViewDecl) {
      expect(view.name).toBe('Customer 360');
      expect(view.domain).toBe('Customer');
      expect(view.status).toBe('draft');
      expect(view.tags).toEqual(['customer', '360']);
      expect(view.termRefs).toEqual(['Customer', 'Customer Health']);
      expect(view.businessOutcome).toContain('Understand customer value');
      expect(view.includes.map((ref) => `${ref.refType}:${ref.name}`)).toEqual([
        'block:Customer Identity',
        'block:Customer Orders Rollup',
        'business_view:Customer Service Summary',
      ]);
    }
  });

  it('parses term declarations and block term references', () => {
    const source = `term "Customer" {
      domain = "Customer"
      type = "entity"
      status = "draft"
      description = "A person or account that can place orders."
      owner = "Customer Analytics"
      tags = ["customer", "glossary"]
      identifiers = ["customer_id"]
      synonyms = ["Account"]
      businessOwner = "Customer Success"
      businessRules = ["One row per customer_id"]
      caveats = ["Merged accounts may appear under a surviving customer_id"]
    }

    block "Customer Identity" {
      domain = "Customer"
      type = "custom"
      terms = ["Customer"]
      query = """
        SELECT customer_id, customer_name FROM dim_customer
      """
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(2);
    const term = ast.statements[0];
    const block = ast.statements[1];
    expect(term.kind).toBe(NodeKind.TermDecl);
    if (term.kind === NodeKind.TermDecl) {
      expect(term.name).toBe('Customer');
      expect(term.termType).toBe('entity');
      expect(term.identifiers).toEqual(['customer_id']);
      expect(term.synonyms).toEqual(['Account']);
      expect(term.businessRules).toEqual(['One row per customer_id']);
    }
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.termRefs).toEqual(['Customer']);
    }
  });

  it('parses flow alias and normalizes to sankey', () => {
    const source = `chart.flow(
      SELECT src, dst, val FROM flows,
      x = src,
      y = val,
      color_field = dst
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('sankey');
    }
  });

  it('parses spark alias and normalizes to sparkline', () => {
    const source = `chart.spark(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('sparkline');
    }
  });

  it('parses small-multiples alias and normalizes to small_multiples', () => {
    const source = `chart.small-multiples(
      SELECT date, region, revenue FROM sales,
      x = date,
      y = revenue,
      facet = region
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('small_multiples');
    }
  });

  it('parses filter.dropdown with SQL query', () => {
    const source = `dashboard "Test" {
      filter.dropdown(
        SELECT DISTINCT category FROM products,
        label = "Category",
        param = "cat_filter"
      )

      chart.bar(
        SELECT name, revenue FROM products,
        x = name,
        y = revenue
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    expect(dashboard.kind).toBe(NodeKind.Dashboard);
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.body).toHaveLength(2);
      expect(dashboard.body[0].kind).toBe(NodeKind.FilterCall);
      if (dashboard.body[0].kind === NodeKind.FilterCall) {
        expect(dashboard.body[0].filterType).toBe('dropdown');
        expect(dashboard.body[0].query).toBeDefined();
        expect(dashboard.body[0].query?.rawSQL).toContain('SELECT DISTINCT category FROM products');
        expect(dashboard.body[0].args).toHaveLength(2);
        expect(dashboard.body[0].args[0].name).toBe('label');
        expect(dashboard.body[0].args[1].name).toBe('param');
      }
    }
  });

  it('parses filter.text without SQL query', () => {
    const source = `dashboard "Test" {
      filter.text(
        label = "Search",
        param = "search_q",
        placeholder = "Type to search..."
      )

      chart.table(
        SELECT * FROM products,
        title = "Products"
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    if (dashboard.kind === NodeKind.Dashboard) {
      const filterNode = dashboard.body[0];
      expect(filterNode.kind).toBe(NodeKind.FilterCall);
      if (filterNode.kind === NodeKind.FilterCall) {
        expect(filterNode.filterType).toBe('text');
        expect(filterNode.query).toBeUndefined();
        expect(filterNode.args).toHaveLength(3);
      }
    }
  });

  it('parses multiple filters in a dashboard', () => {
    const source = `dashboard "Filtered" {
      filter.dropdown(
        SELECT DISTINCT status FROM orders,
        label = "Status",
        param = "status_filter"
      )

      filter.date_range(
        label = "Date",
        param = "date_filter"
      )

      chart.line(
        SELECT date, COUNT(*) as cnt FROM orders GROUP BY date,
        x = date,
        y = cnt
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.body).toHaveLength(3);
      expect(dashboard.body[0].kind).toBe(NodeKind.FilterCall);
      expect(dashboard.body[1].kind).toBe(NodeKind.FilterCall);
      expect(dashboard.body[2].kind).toBe(NodeKind.ChartCall);

      if (dashboard.body[0].kind === NodeKind.FilterCall) {
        expect(dashboard.body[0].filterType).toBe('dropdown');
      }
      if (dashboard.body[1].kind === NodeKind.FilterCall) {
        expect(dashboard.body[1].filterType).toBe('date_range');
      }
    }
  });
});

describe('Parser - Block Declaration', () => {
  it('parses a minimal block declaration', () => {
    const source = `block "Revenue by Segment" {
      domain = "revenue"
      type = "custom"
      query = """SELECT tier, SUM(revenue) FROM fct_revenue GROUP BY tier"""
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.name).toBe('Revenue by Segment');
      expect(block.domain).toBe('revenue');
      expect(block.blockType).toBe('custom');
    }
  });

  it('parses the Block Studio context fields: question aliases and rules and caveats', () => {
    const source = `block "Orders by Store" {
      domain = "commerce"
      type = "custom"
      businessOutcome = "Staff stores to demand"
      llmContext = "Use for order counts per store"
      terms = ["Order"]
      sourceSystems = ["dbt:orders"]
      synonyms = ["store orders", "orders per location"]
      primaryTerms = ["order volume"]
      caveats = ["Excludes cancelled orders"]
      query = """SELECT 1 AS order_count"""
    }`;
    const ast = parse(source);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.synonyms).toEqual(['store orders', 'orders per location']);
      expect(block.caveats).toEqual(['Excludes cancelled orders']);
      expect(block.termRefs).toEqual(['Order']);
      expect(block.primaryTerms).toEqual(['order volume']);
    }
  });

  it('reads a single-string caveats as a one-item list', () => {
    const ast = parse(`block "x" {
      type = "custom"
      caveats = "Excludes refunds"
      query = """SELECT 1"""
    }`);
    const block = ast.statements[0];
    if (block.kind !== NodeKind.BlockDecl) throw new Error('expected a block');
    expect(block.caveats).toEqual(['Excludes refunds']);
  });

  it('parses a full block with all sections', () => {
    const source = `block "Revenue by Segment" {
      domain = "revenue"
      type = "custom"
      description = "Quarterly revenue breakdown"
      tags = ["revenue", "segment", "quarterly"]

      params {
        period = "current_quarter"
        compare = "prev_quarter"
      }

      query = """
        SELECT s.tier AS segment, SUM(r.revenue) AS revenue
        FROM fct_revenue r
        JOIN dim_segment s ON r.segment_id = s.id
        WHERE r.period = {period}
        GROUP BY s.tier
      """

      visualization {
        chart = "bar"
        x = segment
        y = revenue
        color = "#7c8cf5"
      }

      tests {
        assert row_count > 0
        assert revenue > 0
        assert segment IN ["Enterprise", "Mid-Market", "SMB"]
      }
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.name).toBe('Revenue by Segment');
      expect(block.domain).toBe('revenue');
      expect(block.blockType).toBe('custom');
      expect(block.description).toBe('Quarterly revenue breakdown');
      expect(block.tags).toEqual(['revenue', 'segment', 'quarterly']);

      // Params
      expect(block.params).toBeDefined();
      expect(block.params!.params).toHaveLength(2);
      expect(block.params!.params[0].name).toBe('period');
      expect(block.params!.params[1].name).toBe('compare');

      // Query
      expect(block.query).toBeDefined();
      expect(block.query!.rawSQL).toContain('SELECT s.tier AS segment');
      expect(block.query!.rawSQL).toContain('fct_revenue');
      expect(block.query!.interpolations).toHaveLength(1);
      expect(block.query!.interpolations[0].variableName).toBe('period');

      // Visualization
      expect(block.visualization).toBeDefined();
      expect(block.visualization!.properties).toHaveLength(4);
      expect(block.visualization!.properties[0].name).toBe('chart');
      expect(block.visualization!.properties[1].name).toBe('x');
      expect(block.visualization!.properties[2].name).toBe('y');
      expect(block.visualization!.properties[3].name).toBe('color');

      // Tests
      expect(block.tests).toBeDefined();
      expect(block.tests).toHaveLength(3);
      expect(block.tests![0].field).toBe('row_count');
      expect(block.tests![0].operator).toBe('>');
      expect(block.tests![1].field).toBe('revenue');
      expect(block.tests![1].operator).toBe('>');
      expect(block.tests![2].field).toBe('segment');
      expect(block.tests![2].operator).toBe('IN');
    }
  });

  it('parses block with decorators', () => {
    const source = `@schedule(daily, "9:00 AM")
    @cache("1h")
    block "Daily Revenue" {
      domain = "revenue"
      type = "custom"
      query = """
        SELECT SUM(revenue) as total FROM fct_revenue
      """
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.decorators).toHaveLength(2);
      expect(block.decorators[0].name).toBe('schedule');
      expect(block.decorators[1].name).toBe('cache');
      expect(block.name).toBe('Daily Revenue');
    }
  });

  it('parses block alongside dashboard', () => {
    const source = `block "Churn KPI" {
      domain = "retention"
      type = "semantic"
      metric = "churn_rate"
    }

    dashboard "Overview" {
      chart.bar(
        SELECT region, SUM(rev) as revenue FROM sales GROUP BY region,
        x = region,
        y = revenue
      )
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(2);
    expect(ast.statements[0].kind).toBe(NodeKind.BlockDecl);
    expect(ast.statements[1].kind).toBe(NodeKind.Dashboard);
  });

  it('parses block owner field', () => {
    const source = `block "Owned" {
      domain = "revenue"
      type = "custom"
      owner = "kranthi"
      query = """SELECT 1"""
    }`;
    const ast = parse(source);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.owner).toBe('kranthi');
    }
  });

  it('parses block test operators >= <= == !=', () => {
    const source = `block "Operator Test" {
      domain = "ops"
      type = "custom"
      query = """SELECT COUNT(*) as row_count FROM ops_data"""
      tests {
        assert row_count >= 1
        assert row_count <= 100
        assert row_count == 42
        assert row_count != 0
      }
    }`;
    const ast = parse(source);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.tests).toHaveLength(4);
      expect(block.tests?.map((t) => t.operator)).toEqual(['>=', '<=', '==', '!=']);
    }
  });

  it('parses use declaration with quoted name', () => {
    const source = `dashboard "Composed" {
      use "Revenue by Segment"
    }`;
    const ast = parse(source);
    const dashboard = ast.statements[0];
    expect(dashboard.kind).toBe(NodeKind.Dashboard);
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.body).toHaveLength(1);
      expect(dashboard.body[0].kind).toBe(NodeKind.UseDecl);
      if (dashboard.body[0].kind === NodeKind.UseDecl) {
        expect(dashboard.body[0].name).toBe('Revenue by Segment');
      }
    }
  });
});

// ---- Phase A: Block Schema tests (A8–A12) ----

describe('Block declarations — Phase A schema enforcement', () => {
  // A8: legacy blocks without type still parse as custom blocks for migration compatibility.
  it('A8 — defaults a legacy block without type to custom', () => {
    const source = `block "Revenue KPI" {
      domain = "revenue"
      query = """SELECT SUM(amount) FROM orders"""
    }`;
    const ast = parse(source);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.blockType).toBe('custom');
    }
    const errors = analyze(ast).filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  // A9: semantic analyzer rejects semantic block with query but no metricRef
  it('A9 — semantic analyzer rejects semantic block with query and no metricRef', () => {
    const source = `block "Revenue Metric" {
      domain = "revenue"
      type = "semantic"
      query = """SELECT SUM(amount) FROM orders"""
    }`;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.message.includes('must not contain a query field'))).toBe(true);
  });

  // A10: semantic analyzer rejects custom block without query
  it('A10 — semantic analyzer rejects custom block without query', () => {
    const source = `block "Revenue Custom" {
      domain = "revenue"
      type = "custom"
    }`;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.message.includes('must have a query field'))).toBe(true);
  });

  // A11: accepts semantic block with only metricRef (no query)
  it('A11 — accepts semantic block with metricRef and no query', () => {
    const source = `block "Revenue Metric" {
      domain = "revenue"
      type = "semantic"
      metric = "revenue_growth"
    }`;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);

    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.blockType).toBe('semantic');
      expect(block.metricRef).toBe('revenue_growth');
    }
  });

  it('accepts semantic block with metrics and dimensions', () => {
    const source = `block "Revenue by Segment" {
      domain = "revenue"
      type = "semantic"
      metrics = ["total_revenue", "order_count"]
      dimensions = ["customer_segment"]
    }`;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);

    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.metricsRef).toEqual(['total_revenue', 'order_count']);
      expect(block.dimensionsRef).toEqual(['customer_segment']);
    }
  });

  // A12: accepts custom block with SQL
  it('A12 — accepts custom block with SQL query', () => {
    const source = `block "Revenue Custom" {
      domain = "revenue"
      type = "custom"
      query = """SELECT SUM(amount) AS total FROM orders"""
      visualization {
        chart = "kpi"
        y = total
      }
    }`;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);

    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.blockType).toBe('custom');
    }
  });

  // Regression: the parser used to infinite-loop on input it could not recognize
  // (no forward-progress guard), which OOM-crashed the notebook runtime on EVERY
  // raw-SQL query passed through the cell executor. It must always terminate —
  // returning or throwing — never hang. A hang fails this test via the timeout.
  it('terminates on non-DQL / raw SQL input instead of looping forever', () => {
    const samples = [
      'SELECT COUNT(*) AS n FROM dev.customers',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'select 1 as n',
      '@@@ not dql at all %%% ;;;',
      '}{)(',
      '',
    ];
    for (const source of samples) {
      // Throwing is acceptable; spinning forever is the bug under test.
      try {
        parse(source);
      } catch {
        /* a parse error is fine — reaching this line proves termination */
      }
    }
    expect(true).toBe(true);
  }, 5000);
});

describe('parse error message (B10)', () => {
  it('names the line, column and token of the first problem, not only the file', () => {
    const source = '// dql-format: 1\n\nblock "x" {\n  query = """SELECT 1"""\n}\n  owner = "sales-analytics"\n';
    let message = '';
    try {
      new Parser(source, '<block-invocation>').parse();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^Parse errors in <block-invocation>: line 6, column 3: Unexpected token 'owner'/);
  });
});
