import { describe, it, expect } from 'vitest';
import {
  SemanticLayer,
  parseMetricDefinition,
  parseDimensionDefinition,
  parseHierarchyDefinition,
  parseBlockCompanionDefinition,
  parseSemanticDisplayFormat,
  qualifyBareSqlIdentifiers,
} from './semantic-layer.js';
import { getDialect } from './sql-dialect.js';

describe('SemanticLayer', () => {
  it('adds and retrieves metrics', () => {
    const layer = new SemanticLayer();
    layer.addMetric({
      name: 'total_revenue', label: 'Total Revenue', description: 'Sum of revenue',
      domain: 'revenue', sql: 'SUM(amount)', type: 'sum', table: 'fct_revenue',
    });
    expect(layer.getMetric('total_revenue')).toBeDefined();
    expect(layer.getMetric('total_revenue')!.label).toBe('Total Revenue');
  });

  it('adds and retrieves dimensions', () => {
    const layer = new SemanticLayer();
    layer.addDimension({
      name: 'segment_tier', label: 'Segment', description: 'Customer segment',
      sql: 's.tier', type: 'string', table: 'dim_segment',
    });
    expect(layer.getDimension('segment_tier')).toBeDefined();
  });

  it('lists metrics by domain', () => {
    const layer = new SemanticLayer({
      metrics: [
        { name: 'rev', label: 'Rev', description: '', domain: 'revenue', sql: 'SUM(a)', type: 'sum', table: 't' },
        { name: 'churn', label: 'Churn', description: '', domain: 'retention', sql: 'AVG(c)', type: 'avg', table: 't' },
      ],
      dimensions: [],
    });
    expect(layer.listMetrics('revenue')).toHaveLength(1);
    expect(layer.listMetrics()).toHaveLength(2);
  });

  it('binds a model-qualified metric reference to its exact model when local metric names collide', () => {
    const layer = new SemanticLayer();
    layer.addMetric({
      name: 'revenue', label: 'Order revenue', description: '', domain: 'commerce',
      sql: 'order_amount', type: 'sum', table: 'orders', cube: 'orders',
    });
    layer.addMetric({
      name: 'revenue', label: 'Refund revenue', description: '', domain: 'commerce',
      sql: 'refund_amount', type: 'sum', table: 'refunds', cube: 'refunds',
    });

    expect(layer.getMetric('orders.revenue')).toMatchObject({ table: 'orders', sql: 'order_amount' });
    expect(layer.getMetric('refunds.revenue')).toMatchObject({ table: 'refunds', sql: 'refund_amount' });
    expect(layer.listMetrics(undefined, { includeVariants: true })).toHaveLength(2);
    expect(layer.validateReferences(['orders.revenue', 'refunds.revenue']).unknown).toEqual([]);
    expect(layer.composeQuery({ metrics: ['orders.revenue'], dimensions: [] })?.sql).toContain('SUM(order_amount) AS revenue');
    expect(layer.composeQuery({ metrics: ['refunds.revenue'], dimensions: [] })?.sql).toContain('SUM(refund_amount) AS revenue');
  });

  it('searches metrics and dimensions', () => {
    const layer = new SemanticLayer({
      metrics: [
        { name: 'total_revenue', label: 'Total Revenue', description: 'All revenue', domain: 'revenue', sql: 'SUM(a)', type: 'sum', table: 't' },
        { name: 'churn_rate', label: 'Churn Rate', description: 'Monthly churn', domain: 'retention', sql: 'AVG(c)', type: 'avg', table: 't' },
      ],
      dimensions: [
        { name: 'segment', label: 'Segment', description: 'Customer segment', sql: 's.tier', type: 'string', table: 't' },
      ],
    });
    const result = layer.search('revenue');
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].name).toBe('total_revenue');
  });

  it('validates references', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'rev', label: 'Rev', description: '', domain: 'r', sql: 'SUM(a)', type: 'sum', table: 't' }],
      dimensions: [{ name: 'seg', label: 'Seg', description: '', sql: 's', type: 'string', table: 't' }],
    });
    const result = layer.validateReferences(['rev', 'seg', 'unknown']);
    expect(result.valid).toEqual(['rev', 'seg']);
    expect(result.unknown).toEqual(['unknown']);
  });

  it('generates metric SQL with dimensions', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'revenue', label: 'Revenue', description: '', domain: 'r', sql: 'SUM(amount)', type: 'sum', table: 'fct_revenue' }],
      dimensions: [{ name: 'segment', label: 'Segment', description: '', sql: 's.tier', type: 'string', table: 'dim_segment' }],
    });
    const sql = layer.generateMetricSQL('revenue', ['segment']);
    expect(sql).toContain('SUM(amount) AS revenue');
    expect(sql).toContain('s.tier AS segment');
    expect(sql).toContain('GROUP BY');
  });

  it('wraps raw metric columns with the declared aggregation when composing SQL', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'card_volume', label: 'Card Volume', description: '', domain: 'cards', sql: 'amount_usd', type: 'sum', table: 'transactions' }],
      dimensions: [{ name: 'transaction_status', label: 'Status', description: '', sql: 'status', type: 'string', table: 'transactions' }],
    });

    const result = layer.composeQuery({ metrics: ['card_volume'], dimensions: ['transaction_status'], driver: 'duckdb' });
    expect(result?.sql).toContain('SUM(amount_usd) AS card_volume');
    expect(result?.sql).toContain('status AS transaction_status');
    expect(result?.sql).toContain('GROUP BY status');
  });

  it('refuses to compose (returns null) when a dimension has no join path to the metric table', () => {
    // Prevents degenerate SQL: a metric on `orders` sliced by a dimension on
    // `products` with no join between them would otherwise emit SELECT products.name
    // with NO JOIN for products — a query that errors or returns wrong/zero rows.
    // Refusing lets the caller fall through to a generated join instead.
    const layer = new SemanticLayer({
      metrics: [{ name: 'revenue', label: 'Revenue', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders' }],
      dimensions: [{ name: 'product_name', label: 'Product', description: '', sql: 'name', type: 'string', table: 'products' }],
    });
    expect(layer.composeQuery({ metrics: ['revenue'], dimensions: ['product_name'], driver: 'duckdb' })).toBeNull();
  });

  it('still composes when the metric and dimension share a table', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'revenue', label: 'Revenue', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders' }],
      dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
    });
    expect(layer.composeQuery({ metrics: ['revenue'], dimensions: ['region'], driver: 'duckdb' })?.sql).toContain('SUM(amount) AS revenue');
  });

  it('preserves model-qualified primary and foreign variants of the same entity name', () => {
    const layer = new SemanticLayer();
    layer.addEntity({ name: 'customer', label: 'Order customer', description: '', type: 'foreign', table: 'orders', cube: 'orders' });
    layer.addEntity({ name: 'customer', label: 'Customer', description: '', type: 'primary', table: 'customers', cube: 'customers' });

    expect(layer.listEntities().filter((entity) => entity.name === 'customer')).toEqual(expect.arrayContaining([
      expect.objectContaining({ cube: 'orders', type: 'foreign' }),
      expect.objectContaining({ cube: 'customers', type: 'primary' }),
    ]));
    expect(layer.getEntity('customer')).toEqual(expect.objectContaining({ cube: 'customers', type: 'primary' }));
    expect(layer.getEntity('customer', 'orders')).toEqual(expect.objectContaining({ cube: 'orders', type: 'foreign' }));
    expect(layer.getEntity('customers.customer')).toEqual(expect.objectContaining({ cube: 'customers', type: 'primary' }));
  });

  it('AGT-010 emits stable aliases and qualified members across a multi-hop semantic path', () => {
    const layer = new SemanticLayer();
    const cube = (
      name: string,
      table: string,
      joins: Array<{ name: string; left: string; right: string; type: 'left'; sql: string }> = [],
    ) => ({
      name,
      label: name,
      description: '',
      sql: `SELECT * FROM ${table}`,
      table,
      domain: 'commerce',
      measures: [],
      dimensions: [],
      timeDimensions: [],
      joins,
      segments: [],
      preAggregations: [],
    });
    layer.addCube(cube('order_item', 'order_items', [
      { name: 'orders', left: 'order_item', right: 'orders', type: 'left', sql: '${left}.order_id = ${right}.order_id' },
      { name: 'products', left: 'order_item', right: 'products', type: 'left', sql: '${left}.product_id = ${right}.product_id' },
    ]));
    layer.addCube(cube('orders', 'orders', [
      { name: 'customers', left: 'orders', right: 'customers', type: 'left', sql: '${left}.customer_id = ${right}.customer_id' },
    ]));
    layer.addCube(cube('customers', 'customers'));
    layer.addCube(cube('products', 'products'));
    layer.addMetric({ name: 'revenue', label: 'Revenue', description: '', domain: 'commerce', sql: 'product_price', type: 'sum', table: 'order_items' });
    layer.addDimension({ name: 'product_name', label: 'Product', description: '', sql: 'product_name', type: 'string', table: 'products' });
    layer.addDimension({ name: 'customer_name', label: 'Customer', description: '', sql: 'customer_name', type: 'string', table: 'customers' });

    const result = layer.composeQuery({
      metrics: ['revenue'],
      dimensions: ['product_name'],
      filters: [{ dimension: 'customer_name', operator: 'equals', values: ['Melissa Lopez'] }],
      orderBy: [{ name: 'revenue', direction: 'desc' }],
      limit: 10,
      tableMapping: {
        order_items: 'dev.order_items',
        orders: 'dev.orders',
        customers: 'dev.customers',
        products: 'dev.products',
      },
    });

    expect(result?.sql).toContain('FROM dev.order_items AS order_item');
    expect(result?.sql).toContain('SUM(order_item.product_price) AS revenue');
    expect(result?.sql).toContain('LEFT JOIN dev.orders AS orders ON order_item.order_id = orders.order_id');
    expect(result?.sql).toContain('LEFT JOIN dev.customers AS customers ON orders.customer_id = customers.customer_id');
    expect(result?.sql).toContain('LEFT JOIN dev.products AS products ON order_item.product_id = products.product_id');
    expect(result?.sql).toContain("WHERE customers.customer_name = 'Melissa Lopez'");
    expect(result?.sql).toContain('GROUP BY products.product_name');

    // Direct joins aggregate AFTER joining, so a duplicate join key on the
    // joined side would inflate SUMs. The compose result must carry the
    // structural fanout probe (base vs joined row counts) for the executor.
    expect(result?.fanoutProbeSql).toContain('AS base_rows');
    expect(result?.fanoutProbeSql).toContain('AS joined_rows');
    expect(result?.fanoutProbeSql).toContain('FROM dev.order_items AS order_item');
    expect(result?.fanoutProbeSql).toContain('LEFT JOIN dev.customers AS customers');
    // The probe is structural: no WHERE — filters could mask key duplication.
    expect(result?.fanoutProbeSql).not.toContain('WHERE');
  });

  it('omits the fanout probe for single-table compositions', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'revenue', label: 'Revenue', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders' }],
      dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
    });
    const result = layer.composeQuery({ metrics: ['revenue'], dimensions: ['region'], driver: 'duckdb' });
    expect(result?.sql).toContain('SUM(amount) AS revenue');
    expect(result?.fanoutProbeSql).toBeUndefined();
  });

  it('orders only by selected output aliases or exact selected physical expressions', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'revenue', label: 'Revenue', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders' }],
      dimensions: [{
        name: 'customer_name',
        qualifiedName: 'customer__customer_name',
        label: 'Customer',
        description: '',
        sql: 'customer_name',
        type: 'string',
        table: 'orders',
      }],
    });

    const valid = layer.composeQuery({
      metrics: ['revenue'],
      dimensions: ['customer__customer_name'],
      orderBy: [
        { name: 'revenue', direction: 'desc' },
        { name: 'customer_name', direction: 'asc' },
      ],
      limit: 10,
      driver: 'duckdb',
    });
    expect(valid?.sql).toContain('ORDER BY revenue DESC, customer_name ASC\nLIMIT 10');

    // A registry path is a lookup identity, never SQL. When it names a selected
    // dimension it orders by that dimension's projected alias (a semantic
    // block's `order_by` repeats the spelling of its `dimensions`)...
    expect(layer.composeQuery({
      metrics: ['revenue'],
      dimensions: ['customer__customer_name'],
      orderBy: [
        { name: 'revenue', direction: 'desc' },
        { name: 'customer__customer_name', direction: 'asc' },
      ],
      limit: 10,
      driver: 'duckdb',
    })?.sql).toContain('ORDER BY revenue DESC, customer_name ASC\nLIMIT 10');

    // ...and a name that is neither projected nor a selected member still refuses.
    expect(layer.composeQuery({
      metrics: ['revenue'],
      dimensions: ['customer__customer_name'],
      orderBy: [{ name: 'customer__customer_region', direction: 'asc' }],
      limit: 10,
      driver: 'duckdb',
    })).toBeNull();
  });

  it('pre-aggregates metrics from different fact tables before joining at a conformed grain', () => {
    const layer = new SemanticLayer();
    const cube = (name: string, joins: Array<{ name: string; left: string; right: string; type: 'left'; sql: string }> = []) => ({
      name, label: name, description: '', sql: `SELECT * FROM ${name}`, table: name, domain: 'finance',
      measures: [], dimensions: [], timeDimensions: [], joins, segments: [], preAggregations: [],
    });
    layer.addCube(cube('orders', [{ name: 'regions', left: 'orders', right: 'regions', type: 'left', sql: '${left}.region_id = ${right}.region_id' }]));
    layer.addCube(cube('refunds', [{ name: 'regions', left: 'refunds', right: 'regions', type: 'left', sql: '${left}.region_id = ${right}.region_id' }]));
    layer.addCube(cube('regions'));
    layer.addMetric({ name: 'order_revenue', label: 'Revenue', description: '', domain: 'finance', sql: 'amount', type: 'sum', table: 'orders' });
    layer.addMetric({ name: 'refund_amount', label: 'Refunds', description: '', domain: 'finance', sql: 'amount', type: 'sum', table: 'refunds' });
    layer.addDimension({ name: 'region_name', label: 'Region', description: '', sql: 'name', type: 'string', table: 'regions' });

    const result = layer.composeQuery({
      metrics: ['order_revenue', 'refund_amount'],
      dimensions: ['region_name'],
      orderBy: [{ name: 'order_revenue', direction: 'desc' }],
      limit: 10,
      driver: 'duckdb',
    });

    expect(result?.strategy).toBe('aggregate_islands');
    expect(result?.grainKeys).toEqual(['region_name']);
    expect(result?.sql).toContain('metric_1_order_revenue AS');
    expect(result?.sql).toContain('metric_2_refund_amount AS');
    expect(result?.sql).toContain('grain_keys AS');
    expect(result?.sql).toContain('LEFT JOIN metric_1_order_revenue ON grain_keys.region_name = metric_1_order_revenue.region_name');
    expect(result?.sql).not.toMatch(/FROM orders[\s\S]*JOIN refunds/);
    expect(result?.sql).toContain('ORDER BY order_revenue DESC');
    expect(result?.sql).toContain('LIMIT 10');
  });

  describe('governed metric-scoped filters (G1)', () => {
    // dbt Labs' insurance semantic layer: loss payments are the claim amounts
    // the loss_payment table holds, marked by a constant `has_loss_payment`.
    const markerLayer = () => new SemanticLayer({
      metrics: [
        { name: 'loss_payment_amount', label: 'Loss payments', description: '', domain: 'claims', sql: 'claim_amount', type: 'sum', table: 'claim_amount', cube: 'claim_amount', filter: "{{ Dimension('claim_amount__has_loss_payment') }} = 1" },
        { name: 'total_claim_amount', label: 'All claim amounts', description: '', domain: 'claims', sql: 'claim_amount', type: 'sum', table: 'claim_amount', cube: 'claim_amount' },
      ],
      dimensions: [
        { name: 'has_loss_payment', label: 'Has loss payment', description: '', sql: '1', type: 'number', table: 'loss_payment', cube: 'loss_payment' },
        { name: 'amount_type_code', label: 'Amount type', description: '', sql: 'amount_type_code', type: 'string', table: 'claim_amount', cube: 'claim_amount' },
      ],
    });

    it('refuses a metric whose filter lives on a table the query does not join, instead of summing every row', () => {
      const layer = markerLayer();
      expect(layer.composeQuery({ metrics: ['loss_payment_amount'], dimensions: [], driver: 'duckdb' })).toBeNull();
      expect(layer.composeQuery({ metrics: ['loss_payment_amount', 'total_claim_amount'], dimensions: ['amount_type_code'], driver: 'duckdb' })).toBeNull();
      // The unfiltered metric still composes.
      expect(layer.composeQuery({ metrics: ['total_claim_amount'], dimensions: [], driver: 'duckdb' })?.sql).toContain('SUM(claim_amount) AS total_claim_amount');
    });

    it('hoists a single metric filter to WHERE', () => {
      const layer = new SemanticLayer({
        metrics: [{ name: 'completed_revenue', label: 'Completed Revenue', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders', filter: "status = 'completed'" }],
        dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
      });
      const result = layer.composeQuery({ metrics: ['completed_revenue'], dimensions: ['region'], driver: 'duckdb' });
      expect(result?.sql).toContain('SUM(amount) AS completed_revenue');
      expect(result?.sql).toContain("WHERE status = 'completed'");
      expect(result?.sql).not.toContain('CASE WHEN');
    });

    it('hoists to WHERE when every metric shares the same filter', () => {
      const layer = new SemanticLayer({
        metrics: [
          { name: 'completed_revenue', label: 'A', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders', filter: "status = 'completed'" },
          { name: 'completed_orders', label: 'B', description: '', domain: 'sales', sql: '*', type: 'count', table: 'orders', filter: "status = 'completed'" },
        ],
        dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
      });
      const result = layer.composeQuery({ metrics: ['completed_revenue', 'completed_orders'], dimensions: ['region'], driver: 'duckdb' });
      expect(result?.sql).toContain("WHERE status = 'completed'");
      expect(result?.sql).toContain('COUNT(*) AS completed_orders');
      expect(result?.sql).not.toContain('CASE WHEN');
    });

    it('applies mixed per-metric filters via CASE WHEN inside the aggregate', () => {
      const layer = new SemanticLayer({
        metrics: [
          { name: 'total_revenue', label: 'Total', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders' },
          { name: 'completed_revenue', label: 'Completed', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders', filter: "status = 'completed'" },
        ],
        dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
      });
      const result = layer.composeQuery({ metrics: ['total_revenue', 'completed_revenue'], dimensions: ['region'], driver: 'duckdb' });
      expect(result?.sql).toContain('SUM(amount) AS total_revenue');
      expect(result?.sql).toContain("SUM(CASE WHEN status = 'completed' THEN amount END) AS completed_revenue");
      // A per-metric filter must NOT leak into a global WHERE.
      expect(result?.sql).not.toContain("WHERE status = 'completed'");
    });

    it('wraps COUNT(DISTINCT ...) and COUNT(*) filters correctly', () => {
      const layer = new SemanticLayer({
        metrics: [
          { name: 'all_customers', label: 'All', description: '', domain: 'sales', sql: 'customer_id', type: 'count_distinct', table: 'orders' },
          { name: 'active_customers', label: 'Active', description: '', domain: 'sales', sql: 'customer_id', type: 'count_distinct', table: 'orders', filter: "status = 'active'" },
        ],
        dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
      });
      const result = layer.composeQuery({ metrics: ['all_customers', 'active_customers'], dimensions: ['region'], driver: 'duckdb' });
      expect(result?.sql).toContain("COUNT(DISTINCT CASE WHEN status = 'active' THEN customer_id END) AS active_customers");
    });

    it('substitutes MetricFlow {{ Dimension(...) }} references in string filters', () => {
      const layer = new SemanticLayer({
        metrics: [{ name: 'completed_revenue', label: 'Completed', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders', filter: "{{ Dimension('order__status') }} = 'completed'" }],
        dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
      });
      const result = layer.composeQuery({ metrics: ['completed_revenue'], dimensions: ['region'], driver: 'duckdb' });
      expect(result?.sql).toContain("WHERE status = 'completed'");
    });

    it('renders object-shaped filters', () => {
      const layer = new SemanticLayer({
        metrics: [{ name: 'big_orders', label: 'Big', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders', filter: { field: 'amount', operator: 'gte', value: 100 } }],
        dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
      });
      const result = layer.composeQuery({ metrics: ['big_orders'], dimensions: ['region'], driver: 'duckdb' });
      expect(result?.sql).toContain('WHERE amount >= 100');
    });

    it('refuses to compose (null) when a metric filter is unrenderable', () => {
      const layer = new SemanticLayer({
        metrics: [{ name: 'weird', label: 'Weird', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders', filter: "{{ Metric('other') }} > 0" }],
        dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
      });
      expect(layer.composeQuery({ metrics: ['weird'], dimensions: ['region'], driver: 'duckdb' })).toBeNull();
    });

    it('ties a text filter to its own table once another table is joined', () => {
      // Both tables have `region`: unqualified, `WHERE region = 'East'` is ambiguous.
      const layer = new SemanticLayer();
      const cube = (name: string, table: string, joins: Array<{ name: string; left: string; right: string; type: 'left'; sql: string }> = []) => ({
        name, label: name, description: '', sql: `SELECT * FROM ${table}`, table, domain: 'sales',
        measures: [], dimensions: [], timeDimensions: [], joins, segments: [], preAggregations: [],
      });
      layer.addCube(cube('orders', 'orders', [
        { name: 'customers', left: 'orders', right: 'customers', type: 'left', sql: '${left}.customer_id = ${right}.customer_id' },
      ]));
      layer.addCube(cube('customers', 'customers'));
      layer.addMetric({ name: 'east_sales', label: 'East Sales', description: '', domain: 'sales', sql: 'sales', type: 'sum', table: 'orders', filter: "region = 'East' and order_date >= current_date - interval '30 days'" });
      layer.addMetric({ name: 'total_sales', label: 'Total Sales', description: '', domain: 'sales', sql: 'sales', type: 'sum', table: 'orders' });
      layer.addDimension({ name: 'segment', label: 'Segment', description: '', sql: 'segment', type: 'string', table: 'customers' });

      const hoisted = layer.composeQuery({ metrics: ['east_sales'], dimensions: ['segment'], driver: 'duckdb' });
      expect(hoisted?.sql).toContain("WHERE orders.region = 'East' and orders.order_date >= current_date - interval '30 days'");
      const scoped = layer.composeQuery({ metrics: ['east_sales', 'total_sales'], dimensions: ['segment'], driver: 'duckdb' });
      expect(scoped?.sql).toContain("SUM(CASE WHEN orders.region = 'East' and orders.order_date >= current_date - interval '30 days' THEN orders.sales END) AS east_sales");
      // With no join, the filter stays as written.
      expect(layer.composeQuery({ metrics: ['east_sales'], dimensions: [], driver: 'duckdb' })?.sql).toContain("WHERE region = 'East'");
    });

    it('leaves qualified columns, date-part units and subqueries in a text filter as written', () => {
      expect(qualifyBareSqlIdentifiers("customers.segment = 'SMB' and extract(year from order_date) = 2024", 'orders'))
        .toBe("customers.segment = 'SMB' and extract(year from orders.order_date) = 2024");
      // SQL Server's quoted name is one name.
      expect(qualifyBareSqlIdentifiers('SUM([Order ID])', 'orders')).toBe('SUM([Order ID])');
    });

        it('refuses when a per-metric filter targets an unparseable (ratio) aggregate', () => {
      const layer = new SemanticLayer({
        metrics: [
          { name: 'plain', label: 'Plain', description: '', domain: 'sales', sql: 'amount', type: 'sum', table: 'orders' },
          { name: 'margin', label: 'Margin', description: '', domain: 'sales', sql: 'SUM(profit) / SUM(amount)', type: 'custom', table: 'orders', filter: "status = 'completed'" },
        ],
        dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'orders' }],
      });
      // Mixed filters + a ratio aggregate that can't take a CASE WHEN safely → fail safe.
      expect(layer.composeQuery({ metrics: ['plain', 'margin'], dimensions: ['region'], driver: 'duckdb' })).toBeNull();
    });
  });

  it('supports hierarchy registration and drill-path resolution', () => {
    const layer = new SemanticLayer({
      metrics: [],
      dimensions: [
        { name: 'country', label: 'Country', description: '', sql: 'country', type: 'string', table: 'geo' },
        { name: 'state', label: 'State', description: '', sql: 'state', type: 'string', table: 'geo' },
        { name: 'city', label: 'City', description: '', sql: 'city', type: 'string', table: 'geo' },
      ],
      hierarchies: [
        {
          name: 'geo_hierarchy',
          label: 'Geo',
          description: 'Geographic drill path',
          domain: 'revenue',
          defaultRollup: 'sum',
          levels: [
            { name: 'country_level', label: 'Country', description: '', dimension: 'country', order: 1 },
            { name: 'state_level', label: 'State', description: '', dimension: 'state', order: 2 },
            { name: 'city_level', label: 'City', description: '', dimension: 'city', order: 3 },
          ],
          drillPaths: [
            { name: 'geo_default', levels: ['country_level', 'state_level', 'city_level'] },
          ],
          defaultDrillPath: 'geo_default',
        },
      ],
    });

    expect(layer.listHierarchies('revenue')).toHaveLength(1);
    expect(layer.getHierarchy('geo_hierarchy')?.defaultRollup).toBe('sum');

    const path = layer.resolveDrillPath('geo_hierarchy');
    expect(path.map((level) => level.name)).toEqual(['country_level', 'state_level', 'city_level']);

    const next = layer.nextDrillLevel('geo_hierarchy', 'state_level');
    expect(next?.name).toBe('city_level');

    const refs = layer.validateReferences(['geo_hierarchy', 'city_level', 'missing_ref']);
    expect(refs.valid).toEqual(['geo_hierarchy', 'city_level']);
    expect(refs.unknown).toEqual(['missing_ref']);
  });

  it('registers segments and pre-aggregations and resolves compatible dimensions across joins', () => {
    const layer = new SemanticLayer();
    layer.addCube({
      name: 'orders',
      label: 'Orders',
      description: 'Orders cube',
      sql: 'SELECT * FROM orders',
      table: 'orders',
      domain: 'revenue',
      measures: [
        {
          name: 'total_revenue',
          label: 'Total Revenue',
          description: '',
          domain: 'revenue',
          sql: 'SUM(amount)',
          type: 'sum',
          table: 'orders',
          cube: 'orders',
          tags: ['finance'],
        },
      ],
      dimensions: [
        {
          name: 'order_status',
          label: 'Order Status',
          description: '',
          domain: 'revenue',
          sql: 'status',
          type: 'string',
          table: 'orders',
          cube: 'orders',
        },
      ],
      timeDimensions: [],
      joins: [
        {
          name: 'customers',
          left: 'orders',
          right: 'customers',
          type: 'left',
          sql: '${left}.customer_id = ${right}.id',
        },
      ],
      segments: [
        {
          name: 'completed_orders',
          label: 'Completed Orders',
          description: '',
          domain: 'revenue',
          cube: 'orders',
          sql: "status = 'completed'",
        },
      ],
      preAggregations: [
        {
          name: 'orders_monthly_rollup',
          label: 'Orders Monthly Rollup',
          description: '',
          domain: 'revenue',
          cube: 'orders',
          measures: ['total_revenue'],
          dimensions: ['order_status'],
          timeDimension: 'order_date',
          granularity: 'month',
        },
      ],
      tags: ['finance'],
    });
    layer.addCube({
      name: 'customers',
      label: 'Customers',
      description: 'Customers cube',
      sql: 'SELECT * FROM customers',
      table: 'customers',
      domain: 'revenue',
      measures: [],
      dimensions: [
        {
          name: 'customer_country',
          label: 'Customer Country',
          description: '',
          domain: 'revenue',
          sql: 'country',
          type: 'string',
          table: 'customers',
          cube: 'customers',
        },
      ],
      timeDimensions: [],
      joins: [],
      segments: [],
      preAggregations: [],
    });

    expect(layer.listSegments('revenue').map((segment) => segment.name)).toEqual(['completed_orders']);
    expect(layer.listPreAggregations('revenue').map((preAggregation) => preAggregation.name)).toEqual(['orders_monthly_rollup']);
    expect(layer.listCompatibleDimensions(['total_revenue']).map((dimension) => dimension.name)).toContain('customer_country');
    expect(layer.searchAdvanced('revenue', { domains: ['revenue'], types: ['metric'] }).metrics.map((metric) => metric.name)).toContain('total_revenue');
    expect(layer.listDomains()).toEqual(['revenue']);
    expect(layer.listTags()).toContain('finance');
  });

  it('resolves dbt metrics with empty table fields through their input measures and intersects multi-metric compatibility', () => {
    const layer = new SemanticLayer({
      metrics: [
        { name: 'revenue', label: 'Revenue', description: '', domain: 'sales', sql: 'revenue', type: 'custom', table: '', typeParams: { measure: { name: 'revenue' } } },
        { name: 'orders', label: 'Orders', description: '', domain: 'sales', sql: 'orders', type: 'custom', table: '', typeParams: { measure: { name: 'order_count' } } },
      ],
      dimensions: [
        { name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'order_items' },
        { name: 'customer_tier', label: 'Customer Tier', description: '', sql: 'tier', type: 'string', table: 'customers' },
      ],
      measures: [
        { name: 'revenue', label: 'Revenue', description: '', agg: 'sum', table: 'order_items' },
        { name: 'order_count', label: 'Orders', description: '', agg: 'count', table: 'order_items' },
      ],
      semanticModels: [
        { name: 'order_items', label: 'Order Items', description: '', table: 'order_items', entities: [], measures: ['revenue', 'order_count'], dimensions: ['region'], timeDimensions: [] },
      ],
    });

    expect(layer.listCompatibleDimensions(['revenue']).map((dimension) => dimension.name)).toEqual(['region']);
    expect(layer.listCompatibleDimensions(['revenue', 'orders']).map((dimension) => dimension.name)).toEqual(['region']);
  });

  it('composes dbt simple metrics natively through their input measures', () => {
    const layer = new SemanticLayer({
      metrics: [{
        name: 'revenue', label: 'Revenue', description: '', domain: 'sales',
        sql: 'revenue', type: 'custom', table: '', metricType: 'simple',
        typeParams: { measure: { name: 'revenue' } },
      }],
      dimensions: [{
        name: 'category', label: 'Category', description: '', domain: 'sales',
        sql: 'category', type: 'string', table: 'order_items',
      }],
      measures: [{
        name: 'revenue', label: 'Revenue', description: '', domain: 'sales',
        agg: 'sum', expr: 'product_price', table: 'order_items',
      }],
    });

    const composed = layer.composeQuery({
      metrics: ['revenue'],
      dimensions: ['category'],
      tableMapping: { order_items: 'analytics.order_items' },
    });

    expect(composed?.sql).toContain('SUM(product_price) AS revenue');
    expect(composed?.sql).toContain('FROM analytics.order_items');
    expect(composed?.sql).toContain('GROUP BY category');
    expect(layer.canComposeMetric('revenue')).toBe(true);
  });

  it('binds a repeated report_date dimension to the selected metric model instead of the last loaded model', () => {
    const layer = new SemanticLayer();
    layer.addCube({
      name: 'usage_daily', label: 'Usage daily', description: '', domain: 'usage',
      sql: 'SELECT * FROM analytics.usage_daily', table: 'analytics.usage_daily',
      measures: [{ name: 'total_bcm', label: 'Total BCM', description: '', domain: 'usage', sql: 'SUM(bcm)', type: 'sum', table: 'analytics.usage_daily', cube: 'usage_daily' }],
      dimensions: [],
      timeDimensions: [{ name: 'report_date', label: 'Report date', description: '', sql: 'report_date', type: 'date', table: 'analytics.usage_daily', cube: 'usage_daily', isTimeDimension: true, granularities: ['day'] }],
      joins: [{ name: 'account_snapshot', left: 'usage_daily', right: 'account_snapshot', type: 'left', sql: '${left}.account_id = ${right}.account_id' }],
      segments: [], preAggregations: [],
    });
    layer.addCube({
      name: 'account_snapshot', label: 'Account snapshot', description: '', domain: 'usage',
      sql: 'SELECT * FROM analytics.account_snapshot', table: 'analytics.account_snapshot',
      measures: [],
      dimensions: [{ name: 'account_tier', label: 'Account tier', description: '', sql: 'account_tier', type: 'string', table: 'analytics.account_snapshot', cube: 'account_snapshot' }],
      timeDimensions: [{ name: 'report_date', label: 'Report date', description: '', sql: 'report_date', type: 'date', table: 'analytics.account_snapshot', cube: 'account_snapshot', isTimeDimension: true, granularities: ['day'] }],
      joins: [], segments: [], preAggregations: [],
    });

    const composed = layer.composeQuery({
      metrics: ['total_bcm'],
      dimensions: ['report_date', 'account_tier'],
    });

    expect(composed?.sql).toContain('usage_daily.report_date AS report_date');
    expect(composed?.sql).toContain('account_snapshot.account_tier AS account_tier');
    expect(composed?.sql).not.toContain('account_snapshot.report_date AS report_date');
    expect(layer.listCompatibleDimensions(['total_bcm']).find((dimension) => dimension.name === 'report_date')?.table)
      .toBe('analytics.usage_daily');
    expect(layer.listCompatibleDimensions(['total_bcm'])
      .filter((dimension) => dimension.name === 'report_date')
      .map((dimension) => dimension.cube))
      .toEqual(['usage_daily', 'account_snapshot']);
  });

  it('ID-001/E2E-008 preserves every model-owned dimension identity in discovery and exact lookup', () => {
    const layer = new SemanticLayer();
    layer.addCube({
      name: 'usage_daily', label: 'Usage daily', description: '', domain: 'usage',
      sql: 'SELECT * FROM analytics.usage_daily', table: 'analytics.usage_daily',
      measures: [],
      dimensions: [],
      timeDimensions: [{
        name: 'report_date', label: 'Reporting date', description: '', sql: 'report_as_of_dt',
        type: 'date', table: 'analytics.usage_daily', cube: 'usage_daily',
        isTimeDimension: true, qualifiedName: 'usage__report_date', entityLink: 'usage',
        granularities: ['day'],
      }],
      joins: [], segments: [], preAggregations: [],
    });
    layer.addCube({
      name: 'account_snapshot', label: 'Account snapshot', description: '', domain: 'usage',
      sql: 'SELECT * FROM analytics.account_snapshot', table: 'analytics.account_snapshot',
      measures: [],
      dimensions: [],
      timeDimensions: [{
        name: 'report_date', label: 'Snapshot date', description: '', sql: 'report_as_of_dt',
        type: 'date', table: 'analytics.account_snapshot', cube: 'account_snapshot',
        isTimeDimension: true, qualifiedName: 'account__report_date', entityLink: 'account',
        granularities: ['day'],
      }],
      joins: [], segments: [], preAggregations: [],
    });

    expect(layer.listDimensions(undefined, { includeVariants: true }).map((dimension) => dimension.cube))
      .toEqual(['usage_daily', 'account_snapshot']);
    expect(layer.getDimension('usage_daily.report_date')?.qualifiedName).toBe('usage__report_date');
    expect(layer.getDimension('account_snapshot.report_date')?.qualifiedName).toBe('account__report_date');
    expect(layer.validateReferences(['usage_daily.report_date', 'account__report_date'])).toEqual({
      valid: ['usage_daily.report_date', 'account__report_date'],
      unknown: [],
    });
  });

  it('AGT-010 resolves a repeated bare dimension relative to the selected metric model', () => {
    const layer = new SemanticLayer({
      metrics: [{
        name: 'eu_gb_months_bcm_qty', label: 'EU GB Months BCM Qty', description: '', domain: 'usage',
        sql: 'bcm_qty', type: 'sum', table: 'analytics.usage_daily', cube: 'usage_daily',
      }],
      dimensions: [
        {
          name: 'report_date', label: 'Usage reporting date', description: '', domain: 'usage',
          sql: 'report_as_of_dt', type: 'date', table: 'analytics.usage_daily', cube: 'usage_daily',
          qualifiedName: 'usage__report_date', entityLink: 'usage', isTimeDimension: true,
        },
        {
          name: 'report_date', label: 'Account snapshot date', description: '', domain: 'usage',
          sql: 'report_as_of_dt', type: 'date', table: 'analytics.account_snapshot', cube: 'account_snapshot',
          qualifiedName: 'account__report_date', entityLink: 'account', isTimeDimension: true,
        },
      ],
    });

    expect(layer.resolveDimension('report_date', ['eu_gb_months_bcm_qty'])?.cube).toBe('usage_daily');
    const compiled = layer.generateMetricSQL('eu_gb_months_bcm_qty', ['report_date']);
    expect(compiled).toContain('FROM analytics.usage_daily');
    expect(compiled).not.toContain('analytics.account_snapshot');
  });

  it('refuses to natively compose a dbt derived metric without a physical table', () => {
    const layer = new SemanticLayer({
      metrics: [{
        name: 'revenue_ratio', label: 'Revenue ratio', description: '', domain: 'sales',
        sql: 'revenue_ratio', type: 'custom', table: '', metricType: 'ratio',
      }],
      dimensions: [],
    });

    expect(layer.composeQuery({ metrics: ['revenue_ratio'], dimensions: [] })).toBeNull();
    expect(layer.canComposeMetric('revenue_ratio')).toBe(false);
  });

  it('checks native capability across an enterprise-size catalog without composing SQL', () => {
    const metricCount = 7_500;
    const layer = new SemanticLayer({
      metrics: Array.from({ length: metricCount }, (_, index) => ({
        name: `metric_${index}`,
        label: `Metric ${index}`,
        description: '',
        domain: `domain_${index % 20}`,
        sql: `SUM(value_${index})`,
        type: 'sum' as const,
        table: `model_${index % 4_000}`,
      })),
      dimensions: [],
    });

    expect(Array.from({ length: metricCount }, (_, index) =>
      layer.canComposeMetric(`metric_${index}`)).every(Boolean)).toBe(true);
  });
});

describe('composeQuery reports the joins it took', () => {
  // A host checks these against its relationship model before it labels a
  // compile From Metrics (2026-10-23: a compile through a draft relationship
  // was labelled Governed).
  const layerWithJoin = (joinSql: string) => {
    const layer = new SemanticLayer();
    layer.addCube({
      name: 'orders', label: 'Orders', description: '', sql: 'SELECT * FROM dev.orders', table: 'dev.orders', domain: 'revenue',
      measures: [{ name: 'total_revenue', label: 'Total Revenue', description: '', domain: 'revenue', sql: 'SUM(amount)', type: 'sum', table: 'dev.orders', cube: 'orders' }],
      dimensions: [{ name: 'order_status', label: 'Order Status', description: '', domain: 'revenue', sql: 'status', type: 'string', table: 'dev.orders', cube: 'orders' }],
      timeDimensions: [],
      joins: [{ name: 'customers', left: 'orders', right: 'customers', type: 'left', sql: joinSql }],
      segments: [], preAggregations: [],
    });
    layer.addCube({
      name: 'customers', label: 'Customers', description: '', sql: 'SELECT * FROM dev.customers', table: 'dev.customers', domain: 'revenue',
      measures: [],
      dimensions: [{ name: 'customer_country', label: 'Customer Country', description: '', domain: 'revenue', sql: 'country', type: 'string', table: 'dev.customers', cube: 'customers' }],
      timeDimensions: [], joins: [], segments: [], preAggregations: [],
    });
    return layer;
  };

  it('names the cubes, tables and key pairs of a join', () => {
    const composed = layerWithJoin('${left}.customer_id = ${right}.id').composeQuery({ metrics: ['total_revenue'], dimensions: ['customer_country'] });
    expect(composed?.joinPath).toEqual([{ left: 'orders', right: 'customers', leftTable: 'dev.orders', rightTable: 'dev.customers', keys: [{ from: 'customer_id', to: 'id' }] }]);
  });

  it('reads keys written right-to-left, and none from an ON clause that is not plain key equalities', () => {
    const reversed = layerWithJoin('${right}.id = ${left}.customer_id AND ${right}.region = ${left}.region').composeQuery({ metrics: ['total_revenue'], dimensions: ['customer_country'] });
    expect(reversed?.joinPath?.[0]?.keys).toEqual([{ from: 'customer_id', to: 'id' }, { from: 'region', to: 'region' }]);
    const conditional = layerWithJoin("${left}.customer_id = ${right}.id AND ${right}.status = 'active'").composeQuery({ metrics: ['total_revenue'], dimensions: ['customer_country'] });
    expect(conditional?.joinPath?.[0]?.keys).toEqual([]);
  });

  it('reports no join for a single-table compile', () => {
    const composed = layerWithJoin('${left}.customer_id = ${right}.id').composeQuery({ metrics: ['total_revenue'], dimensions: ['order_status'] });
    expect(composed?.joinPath).toEqual([]);
  });
});

describe('parseMetricDefinition', () => {
  it('parses a raw object into MetricDefinition', () => {
    const metric = parseMetricDefinition({
      name: 'total_revenue', label: 'Total Revenue', description: 'Sum',
      domain: 'revenue', sql: 'SUM(amount)', type: 'sum', table: 'fct_revenue',
      status: 'certified', tags: ['revenue'], owner: 'kranthi',
    });
    expect(metric.name).toBe('total_revenue');
    expect(metric.type).toBe('sum');
    expect(metric.status).toBe('certified');
    expect(metric.tags).toEqual(['revenue']);
  });
});

describe('parseDimensionDefinition', () => {
  it('parses a raw object into DimensionDefinition', () => {
    const dim = parseDimensionDefinition({
      name: 'segment', label: 'Segment', description: 'Tier',
      status: 'review', sql: 's.tier', type: 'string', table: 'dim_segment',
    });
    expect(dim.name).toBe('segment');
    expect(dim.type).toBe('string');
    expect(dim.status).toBe('review');
  });
});

describe('parseHierarchyDefinition', () => {
  it('parses hierarchy metadata, drill paths, and default rollup', () => {
    const hierarchy = parseHierarchyDefinition({
      name: 'time_hierarchy',
      label: 'Time',
      description: 'Time levels',
      domain: 'revenue',
      defaultRollup: 'avg',
      levels: [
        { name: 'year', dimension: 'year', order: 1 },
        { name: 'quarter', dimension: 'quarter', order: 2 },
      ],
      drillPaths: [{ name: 'calendar', levels: ['year', 'quarter'] }],
      defaultDrillPath: 'calendar',
      tags: ['time'],
      owner: 'analytics',
    });

    expect(hierarchy.name).toBe('time_hierarchy');
    expect(hierarchy.defaultRollup).toBe('avg');
    expect(hierarchy.levels).toHaveLength(2);
    expect(hierarchy.drillPaths?.[0].name).toBe('calendar');
    expect(hierarchy.defaultDrillPath).toBe('calendar');
    expect(hierarchy.owner).toBe('analytics');
  });
});

describe('parseBlockCompanionDefinition', () => {
  it('parses companion business metadata for a block', () => {
    const companion = parseBlockCompanionDefinition({
      name: 'revenue_by_segment',
      block: 'revenue_by_segment',
      domain: 'revenue',
      description: 'Business context for segment revenue reporting',
      owner: 'finance-analytics',
      tags: ['revenue', 'segment'],
      glossary: ['ARR', 'net retention'],
      semanticMappings: {
        segment: 'segment_tier',
        revenue: 'total_revenue',
      },
      lineage: ['warehouse.fct_revenue', 'warehouse.dim_segment'],
      notes: ['Reviewed with finance on 2026-03-01'],
      reviewStatus: 'review',
    });

    expect(companion.block).toBe('revenue_by_segment');
    expect(companion.reviewStatus).toBe('review');
    expect(companion.semanticMappings?.segment).toBe('segment_tier');
    expect(companion.lineage).toEqual(['warehouse.fct_revenue', 'warehouse.dim_segment']);
  });
});

describe('SQL Dialect support', () => {
  function buildLayerWithTimeDimension(): SemanticLayer {
    const layer = new SemanticLayer();
    layer.addMetric({
      name: 'total_revenue', label: 'Total Revenue', description: 'Sum',
      domain: 'revenue', sql: 'SUM(amount)', type: 'sum', table: 'orders',
    });
    layer.addDimension({
      name: 'order_date', label: 'Order Date', description: 'Date of order',
      sql: 'order_date', type: 'date', table: 'orders',
    });
    layer.addDimension({
      name: 'channel', label: 'Channel', description: 'Sales channel',
      sql: 'channel', type: 'string', table: 'orders',
    });
    return layer;
  }

  it('generates DuckDB-compatible SQL by default', () => {
    const layer = buildLayerWithTimeDimension();
    const result = layer.composeQuery({
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
    });
    expect(result).not.toBeNull();
    expect(result!.sql).toContain("DATE_TRUNC('month', orders.order_date)");
  });

  it('generates BigQuery-compatible SQL with reversed DATE_TRUNC args', () => {
    const layer = buildLayerWithTimeDimension();
    const result = layer.composeQuery({
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      driver: 'bigquery',
    });
    expect(result).not.toBeNull();
    expect(result!.sql).toContain('DATE_TRUNC(orders.order_date, MONTH)');
  });

  it('generates MySQL-compatible DATE_FORMAT for month truncation', () => {
    const layer = buildLayerWithTimeDimension();
    const result = layer.composeQuery({
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      driver: 'mysql',
    });
    expect(result).not.toBeNull();
    expect(result!.sql).toContain("DATE_FORMAT(orders.order_date, '%Y-%m-01')");
  });

  it('generates ClickHouse-compatible toStartOfMonth for month truncation', () => {
    const layer = buildLayerWithTimeDimension();
    const result = layer.composeQuery({
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      driver: 'clickhouse',
    });
    expect(result).not.toBeNull();
    expect(result!.sql).toContain('toStartOfMonth(orders.order_date)');
  });

  it('generates MSSQL-compatible DATETRUNC for month truncation', () => {
    const layer = buildLayerWithTimeDimension();
    const result = layer.composeQuery({
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      driver: 'mssql',
    });
    expect(result).not.toBeNull();
    expect(result!.sql).toContain('DATETRUNC(month, orders.order_date)');
  });

  it('generates SQLite-compatible STRFTIME for month truncation', () => {
    const layer = buildLayerWithTimeDimension();
    const result = layer.composeQuery({
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      timeDimension: { name: 'order_date', granularity: 'month' },
      driver: 'sqlite',
    });
    expect(result).not.toBeNull();
    expect(result!.sql).toContain("STRFTIME('%Y-%m-01', orders.order_date)");
  });

  it('uses OFFSET/FETCH for MSSQL LIMIT clause', () => {
    const layer = buildLayerWithTimeDimension();
    const result = layer.composeQuery({
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      limit: 10,
      driver: 'mssql',
    });
    expect(result).not.toBeNull();
    expect(result!.sql).toContain('OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY');
    expect(result!.sql).not.toContain('LIMIT');
  });

  it('accepts a dialect object directly', () => {
    const layer = buildLayerWithTimeDimension();
    const dialect = getDialect('snowflake');
    const result = layer.composeQuery({
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      timeDimension: { name: 'order_date', granularity: 'quarter' },
      dialect,
    });
    expect(result).not.toBeNull();
    expect(result!.sql).toContain("DATE_TRUNC('quarter', orders.order_date)");
  });

  it('all 14 drivers resolve to a valid dialect', () => {
    const drivers = [
      'postgresql', 'redshift', 'duckdb', 'file', 'snowflake', 'bigquery',
      'mysql', 'sqlite', 'mssql', 'fabric', 'clickhouse', 'databricks',
      'trino', 'athena',
    ];
    for (const driver of drivers) {
      const dialect = getDialect(driver);
      expect(dialect).toBeDefined();
      expect(dialect.name).toBeTruthy();
      // Every dialect must produce valid dateTrunc output
      const result = dialect.dateTrunc('month', 'col');
      expect(result).toBeTruthy();
    }
  });
});

describe('derived-metric dimension compatibility (office-test survivor fix)', () => {
  const layerWithDerived = () => new SemanticLayer({
    metrics: [
      { name: 'bcm', label: 'BCM', description: '', domain: 'usage', sql: 'bcm', type: 'custom', table: '', typeParams: { measure: { name: 'bcm' } } },
      // Derived metric referencing another metric — some dbt versions omit
      // transitive input_measures, which used to leave the reachable-table set
      // empty and gray out EVERY dimension (including the time dimension).
      { name: 'previous_day_bcm', label: 'Previous Day BCM', description: '', domain: 'usage', sql: 'previous_day_bcm', type: 'custom', table: '', metricType: 'derived', typeParams: { metrics: [{ name: 'bcm', offset_window: '1 day' }] } },
      // Ratio metric via numerator/denominator references.
      { name: 'percent_dod_acm', label: 'Percent DoD ACM', description: '', domain: 'usage', sql: 'percent_dod_acm', type: 'custom', table: '', metricType: 'ratio', typeParams: { numerator: { name: 'previous_day_bcm' }, denominator: { name: 'bcm' } } },
    ],
    dimensions: [
      { name: 'usage_source', label: 'Usage source', description: '', sql: 'usage_source', type: 'string', table: 'usage_daily' },
      { name: 'report_date', label: 'Report date', description: '', sql: 'report_date', type: 'date', table: 'usage_daily' },
    ],
    measures: [
      { name: 'bcm', label: 'BCM', description: '', agg: 'sum', table: 'usage_daily' },
    ],
    semanticModels: [
      { name: 'usage_daily', label: 'Usage daily', description: '', table: 'usage_daily', entities: [], measures: ['bcm'], dimensions: ['usage_source'], timeDimensions: ['report_date'] },
    ],
  });

  it('reaches dimensions through the referenced-metric graph for derived metrics', () => {
    const layer = layerWithDerived();
    const names = layer.listCompatibleDimensions(['previous_day_bcm']).map((dimension) => dimension.name);
    expect(names).toContain('usage_source');
    expect(names).toContain('report_date');
  });

  it('reaches dimensions through numerator/denominator for ratio metrics (two hops)', () => {
    const layer = layerWithDerived();
    const names = layer.listCompatibleDimensions(['percent_dod_acm']).map((dimension) => dimension.name);
    expect(names).toContain('usage_source');
  });

  it('still refuses native composition for the derived metric itself', () => {
    const layer = layerWithDerived();
    expect(layer.canComposeMetric('previous_day_bcm')).toBe(false);
    expect(layer.canComposeMetric('bcm')).toBe(true);
  });
});

describe('display-format contract', () => {
  it('parses dbt meta shorthands and structured forms', () => {
    expect(parseSemanticDisplayFormat({ format: 'currency' })).toEqual({ kind: 'currency', currency: 'USD', decimals: 2 });
    expect(parseSemanticDisplayFormat({ format: 'usd' })).toEqual({ kind: 'currency', currency: 'USD', decimals: 2 });
    expect(parseSemanticDisplayFormat({ format: '%' })).toEqual({ kind: 'percent' });
    expect(parseSemanticDisplayFormat({ format: { kind: 'percent', decimals: 1 } })).toEqual({ kind: 'percent', decimals: 1 });
    expect(parseSemanticDisplayFormat({ currency: 'eur' })).toEqual({ kind: 'currency', currency: 'EUR', decimals: 2 });
    expect(parseSemanticDisplayFormat({ format: 'count' })).toEqual({ kind: 'count' });
    expect(parseSemanticDisplayFormat({})).toBeUndefined();
    expect(parseSemanticDisplayFormat(undefined)).toBeUndefined();
  });

  it('retains an authored native YAML display format on the executable metric', () => {
    const metric = parseMetricDefinition({
      name: 'gross_margin_rate', label: 'Gross margin rate', description: '', domain: 'commerce',
      sql: 'SUM(margin) / NULLIF(SUM(revenue), 0)', type: 'custom', table: 'order_lines',
      format: { kind: 'percent', decimals: 1 },
    });
    expect(metric.displayFormat).toEqual({ kind: 'percent', decimals: 1 });
  });

  it('resolves formats metric-first, then measure, then ratio inference', () => {
    const layer = new SemanticLayer({
      metrics: [
        { name: 'bcm', label: 'BCM', description: '', domain: 'usage', sql: 'bcm', type: 'custom', table: '', typeParams: { measure: { name: 'bcm' } } },
        { name: 'arr', label: 'ARR', description: '', domain: 'finance', sql: 'arr', type: 'custom', table: 'facts', displayFormat: { kind: 'currency', currency: 'USD', decimals: 0 } },
        { name: 'dod_ratio', label: 'DoD', description: '', domain: 'usage', sql: 'dod_ratio', type: 'custom', table: '', metricType: 'ratio', typeParams: {} },
      ],
      dimensions: [],
      measures: [
        { name: 'bcm', label: 'BCM', description: '', agg: 'sum', table: 'usage_daily', displayFormat: { kind: 'currency', currency: 'USD', decimals: 2 } },
      ],
      semanticModels: [
        { name: 'usage_daily', label: 'Usage daily', description: '', table: 'usage_daily', entities: [], measures: ['bcm'], dimensions: [], timeDimensions: [] },
      ],
    });

    expect(layer.displayFormatFor('arr')).toEqual({ kind: 'currency', currency: 'USD', decimals: 0 });
    expect(layer.displayFormatFor('bcm')).toEqual({ kind: 'currency', currency: 'USD', decimals: 2 });
    expect(layer.displayFormatFor('dod_ratio')).toEqual({ kind: 'percent' });
    expect(layer.displayFormatFor('nonexistent')).toBeUndefined();
  });
});

describe('explainCompatibleDimensions memoization', () => {
  const build = (): SemanticLayer => {
    const layer = new SemanticLayer();
    layer.addMetric({
      name: 'revenue', label: 'Revenue', description: 'Revenue.',
      domain: 'finance', sql: 'amount', type: 'sum', table: 'orders',
    });
    layer.addDimension({
      name: 'channel', label: 'Channel', description: 'Channel.',
      domain: 'finance', sql: 'channel', type: 'string', table: 'orders',
    });
    return layer;
  };

  it('returns an identical result on repeat calls and is order-independent', () => {
    const layer = build();
    const first = layer.explainCompatibleDimensions(['revenue']);
    const second = layer.explainCompatibleDimensions(['revenue']);
    // Same object identity proves the memo served it rather than recomputing:
    // the agent asks many times per question and each call BFSs per dimension.
    expect(second).toBe(first);
    expect(first.compatible.map((dimension) => dimension.name)).toContain('channel');

    layer.addMetric({
      name: 'orders_count', label: 'Orders', description: 'Orders.',
      domain: 'finance', sql: '1', type: 'count', table: 'orders',
    });
    // Compatibility is an intersection over the metric SET, so argument order
    // must not produce a second cache entry.
    expect(layer.explainCompatibleDimensions(['revenue', 'orders_count']))
      .toBe(layer.explainCompatibleDimensions(['orders_count', 'revenue']));
  });

  it('invalidates when the layer changes, so a stale answer cannot survive', () => {
    const layer = build();
    expect(layer.explainCompatibleDimensions(['revenue']).compatible.map((d) => d.name)).toEqual(['channel']);

    // The layer is still mutable after construction; a memo that ignored this
    // would hide a newly added dimension for the life of the process.
    layer.addDimension({
      name: 'region', label: 'Region', description: 'Region.',
      domain: 'finance', sql: 'region', type: 'string', table: 'orders',
    });
    expect(layer.explainCompatibleDimensions(['revenue']).compatible.map((d) => d.name).sort())
      .toEqual(['channel', 'region']);
  });
});

describe('joins that follow a dbt entity are walked many-to-one only', () => {
  const cube = (name: string, joins: Array<{ right: string; key: string; entity?: string }>) => ({
    name, label: name, description: '', sql: name, table: name, domain: 'claims', measures: [], dimensions: [], timeDimensions: [], segments: [], preAggregations: [],
    joins: joins.map((join) => ({ name: join.right, left: name, right: join.right, type: 'left' as const, sql: `\${left}.${join.key} = \${right}.${join.key}`, ...(join.entity ? { entity: join.entity } : {}) })),
  });
  const layer = (entityJoins: boolean) => {
    const e = (entity: string) => (entityJoins ? entity : undefined);
    const built = new SemanticLayer({
      metrics: [
        { name: 'claims', label: 'Claims', description: '', domain: 'claims', sql: 'claim_id', type: 'count', table: 'claim', cube: 'claim' },
        { name: 'coverage_rows', label: 'Coverage rows', description: '', domain: 'claims', sql: '*', type: 'count', table: 'claim_coverage', cube: 'claim_coverage' },
      ],
      dimensions: [
        { name: 'policy_number', label: 'Policy', description: '', sql: 'policy_number', type: 'string', table: 'policy', cube: 'policy' },
        { name: 'claim_status', label: 'Status', description: '', sql: 'status', type: 'string', table: 'claim', cube: 'claim' },
      ],
    });
    // claim_coverage holds claim and policy as foreign entities.
    built.addCube(cube('claim_coverage', [{ right: 'claim', key: 'claim_id', entity: e('claim') }, { right: 'policy', key: 'policy_id', entity: e('policy') }]));
    built.addCube(cube('claim', []));
    built.addCube(cube('policy', []));
    return built;
  };

  it('composes along the entity (many-to-one), and refuses a path that walks one backwards', () => {
    const governed = layer(true);
    expect(governed.composeQuery({ metrics: ['coverage_rows'], dimensions: ['claim_status'], driver: 'duckdb' })?.sql).toMatch(/JOIN\s+claim/i);
    // claim → claim_coverage runs one-to-many: counting claims per policy that
    // way multiplies them; MetricFlow refuses it, and so does DQL.
    expect(governed.composeQuery({ metrics: ['claims'], dimensions: ['policy_number'], driver: 'duckdb' })).toBeNull();
  });

  it('leaves hand-written joins, which declare no entity, as they were', () => {
    expect(layer(false).composeQuery({ metrics: ['claims'], dimensions: ['policy_number'], driver: 'duckdb' })).not.toBeNull();
  });
});

describe('a semantic filter is bound or the composition refuses', () => {
  const layer = new SemanticLayer();
  layer.addMetric({
    name: 'total_points', label: 'Total points', description: '', domain: 'nba', sql: 'total_points', type: 'sum',
    table: 'TRANSFORMED.local_player_season_facts',
  });
  layer.addDimension({
    name: 'player', label: 'Player', description: '', domain: 'nba', sql: 'player_name', type: 'string',
    table: 'TRANSFORMED.local_player_season_facts',
  });

  it('resolves a native dimension by the table-qualified spelling its own vocabulary uses', () => {
    const compiled = layer.composeQuery({
      metrics: ['total_points'], dimensions: [],
      filters: [{ dimension: 'local_player_season_facts.player', operator: 'equals', values: ['LeBron James'] }],
    });
    expect(compiled?.sql).toContain('player_name');
    expect(compiled?.sql).not.toMatch(/\.player\s*=/);
  });

  it('refuses rather than emitting a registry name as a column, or dropping the restriction', () => {
    expect(layer.composeQuery({
      metrics: ['total_points'], dimensions: [],
      filters: [{ dimension: 'no_such_dimension', operator: 'equals', values: ['x'] }],
    })).toBeNull();
    // One resolved filter must not hide an unresolved one.
    expect(layer.composeQuery({
      metrics: ['total_points'], dimensions: [],
      filters: [
        { dimension: 'player', operator: 'equals', values: ['LeBron James'] },
        { dimension: 'no_such_dimension', operator: 'equals', values: ['x'] },
      ],
    })).toBeNull();
  });
});
