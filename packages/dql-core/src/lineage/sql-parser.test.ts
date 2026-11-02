import { describe, it, expect } from 'vitest';
import { analyzeSqlReferences, buildGeneratedAnalyticalSqlSignature, buildSqlAnalyticalSignature, buildSqlOutputExpressionSignature, extractTablesFromSql } from './sql-parser.js';

describe('buildSqlAnalyticalSignature', () => {
  it('normalizes cosmetic quoting but rejects semantic plan changes', () => {
    const source = buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total FROM orders o WHERE o.status = $1 GROUP BY o.region');
    expect(source).toEqual(buildSqlAnalyticalSignature('select sum(o.amount) as total from "orders" o where o.status = $1 group by o.region'));
    expect(source).not.toEqual(buildSqlAnalyticalSignature('SELECT AVG(o.amount) AS total FROM orders o WHERE o.status = $1 GROUP BY o.region'));
    expect(source).not.toEqual(buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total FROM orders o GROUP BY o.region'));
    expect(source).not.toEqual(buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total FROM orders o WHERE o.status = $2 GROUP BY o.region'));
    expect(source).not.toEqual(buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS changed FROM orders o WHERE o.status = $1 GROUP BY o.region'));
    expect(source).not.toEqual(buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total, o.region FROM orders o WHERE o.status = $1 GROUP BY o.region'));
    expect(source).not.toEqual(buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total FROM orders o WHERE o.status = $1 GROUP BY o.status'));
    expect(source).not.toEqual(buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.status = $1 GROUP BY o.region'));
    expect(source).not.toEqual(buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total FROM orders o JOIN customers c ON o.account_id = c.id WHERE o.status = $1 GROUP BY o.region'));
    const joined = buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.status = $1 GROUP BY o.region');
    expect(joined).not.toEqual(buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total FROM orders o JOIN accounts c ON o.customer_id = c.id WHERE o.status = $1 GROUP BY o.region'));
    expect(joined).not.toEqual(buildSqlAnalyticalSignature('SELECT SUM(o.amount) AS total FROM orders o JOIN customers c ON o.account_id = c.id WHERE o.status = $1 GROUP BY o.region'));
  });

  it('fails closed for unsupported and multi-statement SQL', () => {
    expect(buildSqlAnalyticalSignature('SELECT 1; SELECT 2')).toBeUndefined();
    expect(buildSqlAnalyticalSignature('not sql')).toBeUndefined();
  });
});

describe('buildSqlOutputExpressionSignature', () => {
  it('binds the complete named output expression while ignoring relation aliases only', () => {
    const signature = buildSqlOutputExpressionSignature(
      'SELECT SUM(o.food_revenue) / SUM(o.revenue) AS food_revenue_pct FROM orders o',
      'food_revenue_pct',
    );
    expect(signature).toMatchObject({
      outputAlias: 'food_revenue_pct',
      operators: ['/'],
      columns: ['food_revenue', 'revenue'],
      aggregateFunctions: ['SUM'],
    });
    expect(signature?.canonicalExpression).toBe(buildSqlOutputExpressionSignature(
      'SELECT SUM(items.food_revenue) / SUM(items.revenue) AS food_revenue_pct FROM orders items',
      'food_revenue_pct',
    )?.canonicalExpression);
    expect(signature?.canonicalExpression).toBe(buildSqlOutputExpressionSignature(
      'SELECT CAST(SUM(items.food_revenue) AS DOUBLE) / CAST(NULLIF(SUM(items.revenue), 0) AS DOUBLE) AS food_revenue_pct FROM orders items',
      'food_revenue_pct',
    )?.canonicalExpression);
    expect(signature?.canonicalExpression).not.toBe(buildSqlOutputExpressionSignature(
      'SELECT SUM(o.food_revenue) + SUM(o.revenue) AS food_revenue_pct FROM orders o',
      'food_revenue_pct',
    )?.canonicalExpression);
  });

  it('fails closed when the output alias is absent or ambiguous across scopes', () => {
    expect(buildSqlOutputExpressionSignature('SELECT SUM(amount) AS total FROM orders', 'missing')).toBeUndefined();
    expect(buildSqlOutputExpressionSignature(
      'WITH a AS (SELECT SUM(amount) AS total FROM orders) SELECT SUM(amount) AS total FROM orders',
      'total',
    )).toBeUndefined();
  });
});

describe('buildGeneratedAnalyticalSqlSignature', () => {
  it('retains parser-owned output, grouping, join, filter, order, and limit semantics', () => {
    const signature = buildGeneratedAnalyticalSqlSignature(`
      SELECT c.customer_name AS customer_name, SUM(o.revenue) AS revenue
      FROM orders o JOIN customers c ON o.customer_id = c.customer_id
      WHERE c.status = 'active'
      GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10
    `);
    expect(signature).toMatchObject({
      groupByColumns: ['customer_name'],
      orderBy: [{ expression: 'revenue', direction: 'desc' }],
      limit: { kind: 'literal', value: 10 },
      sourceRelations: ['customers', 'orders'],
      joins: [{ leftRelation: 'orders', leftColumn: 'customer_id', rightRelation: 'customers', rightColumn: 'customer_id' }],
      setOperations: [],
      hasWindow: false,
    });
    expect(signature?.outputs.find((output) => output.outputAlias === 'revenue')).toMatchObject({
      aggregateFunctions: ['SUM'],
      columns: ['revenue'],
      aggregateInputs: [{ func: 'SUM', distinct: false, column: 'revenue', relation: 'orders' }],
      columnReferences: [{ column: 'revenue', relation: 'orders', tableAlias: 'o', unqualified: false }],
    });
    expect(signature?.filterExpression).toBeTruthy();
  });

  it('keeps source-column proof scoped to each quoted output alias', () => {
    const signature = buildGeneratedAnalyticalSqlSignature(
      'SELECT "order_items"."order_id" AS "order_id", "order_items"."product_id" AS "product_id" FROM "order_items"',
    );
    expect(signature?.outputs.find((output) => output.outputAlias === 'order_id')?.columnReferences).toEqual([
      { column: 'order_id', relation: 'order_items', tableAlias: 'order_items', unqualified: false },
    ]);
    expect(signature?.outputs.find((output) => output.outputAlias === 'product_id')?.columnReferences).toEqual([
      { column: 'product_id', relation: 'order_items', tableAlias: 'order_items', unqualified: false },
    ]);
  });

  it('exposes spoofed aggregate expressions and UNION branches', () => {
    const spoof = buildGeneratedAnalyticalSqlSignature(
      'SELECT customer_name, SUM(revenue) + COUNT(*) AS revenue FROM orders GROUP BY customer_name UNION SELECT customer_name, SUM(revenue) AS revenue FROM archive GROUP BY customer_name',
    );
    expect(spoof?.outputs.find((output) => output.outputAlias === 'revenue')).toMatchObject({ aggregateFunctions: ['COUNT', 'SUM'] });
    expect(spoof?.setOperations).toEqual(['union']);
  });
});

describe('extractTablesFromSql', () => {
  it('extracts a single table from a simple SELECT', () => {
    const result = extractTablesFromSql('SELECT * FROM orders');
    expect(result.tables).toEqual(['orders']);
    expect(result.ctes).toEqual([]);
    expect(result.refs).toEqual([]);
  });

  it('extracts multiple tables from JOINs', () => {
    const result = extractTablesFromSql(`
      SELECT o.id, c.name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN products p ON o.product_id = p.id
    `);
    expect(result.tables).toContain('orders');
    expect(result.tables).toContain('customers');
    expect(result.tables).toContain('products');
    expect(result.tables).toHaveLength(3);
  });

  it('extracts schema-qualified table names', () => {
    const result = extractTablesFromSql('SELECT * FROM analytics.fct_revenue');
    expect(result.tables).toContain('analytics.fct_revenue');
  });

  it('extracts quoted table names', () => {
    const result = extractTablesFromSql('SELECT * FROM "my-table"');
    expect(result.tables).toContain('my-table');
  });

  it('filters out CTE names', () => {
    const result = extractTablesFromSql(`
      WITH monthly_revenue AS (
        SELECT date_trunc('month', created_at) AS month, SUM(amount) AS revenue
        FROM orders
      )
      SELECT * FROM monthly_revenue
    `);
    expect(result.tables).toEqual(['orders']);
    expect(result.ctes).toEqual(['monthly_revenue']);
  });

  it('AGT-005/E2E-008 treats a quoted generated alias as a CTE instead of a Snowflake table', () => {
    const sql = `
      WITH "subq_2" AS (
        SELECT customer_id, product_id FROM analytics.order_items
      )
      SELECT s.customer_id
      FROM "subq_2" AS s
      JOIN analytics.products AS p ON s.product_id = p.product_id
    `;
    const result = extractTablesFromSql(sql);
    const analysis = analyzeSqlReferences(sql, 'snowflake');

    expect(result.ctes).toContain('subq_2');
    expect(result.tables).toEqual(expect.arrayContaining(['analytics.order_items', 'analytics.products']));
    expect(result.tables).not.toContain('subq_2');
    expect(result.tables).not.toContain('"');
    expect(analysis.ctes).toContain('subq_2');
    expect(analysis.tables).not.toContain('subq_2');
    expect(analysis.tables).not.toContain('"');
  });

  it('handles multiple CTEs', () => {
    const result = extractTablesFromSql(`
      WITH
        active_customers AS (
          SELECT * FROM customers WHERE status = 'active'
        ),
        recent_orders AS (
          SELECT * FROM orders WHERE created_at > '2024-01-01'
        )
      SELECT ac.name, ro.amount
      FROM active_customers ac
      JOIN recent_orders ro ON ac.id = ro.customer_id
    `);
    expect(result.tables).toContain('customers');
    expect(result.tables).toContain('orders');
    expect(result.tables).not.toContain('active_customers');
    expect(result.tables).not.toContain('recent_orders');
    expect(result.ctes).toContain('active_customers');
    expect(result.ctes).toContain('recent_orders');
  });

  it('handles recursive CTEs', () => {
    const result = extractTablesFromSql(`
      WITH RECURSIVE hierarchy AS (
        SELECT id, parent_id, name FROM departments WHERE parent_id IS NULL
        UNION ALL
        SELECT d.id, d.parent_id, d.name FROM departments d
        JOIN hierarchy h ON d.parent_id = h.id
      )
      SELECT * FROM hierarchy
    `);
    expect(result.tables).toContain('departments');
    expect(result.tables).not.toContain('hierarchy');
    expect(result.ctes).toContain('hierarchy');
  });

  it('extracts ref() calls', () => {
    const result = extractTablesFromSql(`
      SELECT * FROM ref("revenue_by_segment")
      JOIN ref('customer_metrics') ON 1=1
    `);
    expect(result.refs).toContain('revenue_by_segment');
    expect(result.refs).toContain('customer_metrics');
  });

  it('ignores tables inside string literals', () => {
    const result = extractTablesFromSql(`
      SELECT 'FROM fake_table' AS label FROM real_table
    `);
    expect(result.tables).toContain('real_table');
    expect(result.tables).not.toContain('fake_table');
  });

  it('ignores tables inside comments', () => {
    const result = extractTablesFromSql(`
      -- FROM commented_table
      SELECT * FROM actual_table
      /* FROM another_comment */
    `);
    expect(result.tables).toContain('actual_table');
    expect(result.tables).not.toContain('commented_table');
    expect(result.tables).not.toContain('another_comment');
  });

  it('filters out DuckDB functions like read_csv_auto', () => {
    const result = extractTablesFromSql(`
      SELECT * FROM read_csv_auto('./data/orders.csv')
    `);
    expect(result.tables).not.toContain('read_csv_auto');
  });

  it('handles subqueries without extracting them as tables', () => {
    const result = extractTablesFromSql(`
      SELECT * FROM orders
      WHERE customer_id IN (SELECT id FROM customers WHERE tier = 'gold')
    `);
    expect(result.tables).toContain('orders');
    expect(result.tables).toContain('customers');
  });

  it('handles UNION queries', () => {
    const result = extractTablesFromSql(`
      SELECT id, name FROM customers
      UNION ALL
      SELECT id, name FROM prospects
    `);
    expect(result.tables).toContain('customers');
    expect(result.tables).toContain('prospects');
  });

  it('returns empty for a query with no tables', () => {
    const result = extractTablesFromSql("SELECT 1 AS one, 'hello' AS greeting");
    expect(result.tables).toEqual([]);
    expect(result.ctes).toEqual([]);
    expect(result.refs).toEqual([]);
  });

  it('handles case-insensitive FROM/JOIN', () => {
    const result = extractTablesFromSql('select * from Orders join Customers on 1=1');
    expect(result.tables).toContain('Orders');
    expect(result.tables).toContain('Customers');
  });

  it('handles INSERT INTO', () => {
    const result = extractTablesFromSql(`
      INSERT INTO target_table
      SELECT * FROM source_table
    `);
    expect(result.tables).toContain('target_table');
    expect(result.tables).toContain('source_table');
  });

  it('does not extract ref() calls inside comments', () => {
    const result = extractTablesFromSql(`
      -- ref("old_block") was removed
      SELECT * FROM actual_table
    `);
    expect(result.refs).toEqual([]);
    expect(result.tables).toContain('actual_table');
  });

  it('does not extract ref() calls inside string literals', () => {
    const result = extractTablesFromSql(`
      SELECT 'ref("fake")' AS label FROM real_table
    `);
    expect(result.refs).toEqual([]);
    expect(result.tables).toContain('real_table');
  });

  it('returns deduplicated table names', () => {
    const result = extractTablesFromSql(`
      SELECT a.id FROM orders a
      JOIN orders b ON a.id = b.id
    `);
    const orderCount = result.tables.filter((t) => t === 'orders').length;
    expect(orderCount).toBe(1);
  });

  it('handles empty SQL string', () => {
    const result = extractTablesFromSql('');
    expect(result.tables).toEqual([]);
    expect(result.ctes).toEqual([]);
    expect(result.refs).toEqual([]);
  });

  it('handles DQL triple-quoted SQL with read_csv_auto', () => {
    const result = extractTablesFromSql(`
      SELECT segment_tier AS segment, SUM(amount) AS revenue
      FROM read_csv_auto('./data/revenue.csv')
      GROUP BY segment_tier
    `);
    expect(result.tables).toEqual(["read_csv_auto('./data/revenue.csv')"]);
  });

  describe('FROM inside an expression is not a table', () => {
    const tablesOf = (sql: string) => [...extractTablesFromSql(sql).tables].sort();

    it('EXTRACT(part FROM column): the NBA top-scorers block', () => {
      expect(tablesOf(`
        SELECT player_name, SUM(COALESCE(pts, 0)) AS total_points
        FROM TRANSFORMED.int_player_stats
        WHERE EXTRACT(YEAR FROM game_date_est) BETWEEN \${season_start} AND \${season_end}
        GROUP BY player_name
        ORDER BY total_points DESC
        LIMIT \${top_n}
      `)).toEqual(['TRANSFORMED.int_player_stats']);
      // Lowercase, extra spaces, and in the select list and GROUP BY.
      expect(tablesOf('select extract ( month from o.created_at ) as m, count(*) from orders o group by extract(month from o.created_at)'))
        .toEqual(['orders']);
    });

    it('SUBSTRING(s FROM n FOR m) and SUBSTRING(s FROM column)', () => {
      expect(tablesOf('SELECT SUBSTRING(sku FROM 1 FOR 3), SUBSTRING(name FROM start_pos) FROM products')).toEqual(['products']);
    });

    it("TRIM([LEADING|TRAILING|BOTH] 'x' FROM column)", () => {
      expect(tablesOf("SELECT TRIM(LEADING '0' FROM account_code), TRIM(BOTH FROM padded) FROM accounts a JOIN regions r ON a.r = r.id"))
        .toEqual(['accounts', 'regions']);
    });

    it("OVERLAY(s PLACING 'x' FROM n) and POSITION('x' IN s)", () => {
      expect(tablesOf("SELECT OVERLAY(phone PLACING '***' FROM offset_col FOR 3), POSITION('@' IN email) FROM customers"))
        .toEqual(['customers']);
    });

    it('IS [NOT] DISTINCT FROM column', () => {
      expect(tablesOf('SELECT * FROM a JOIN b ON a.k IS NOT DISTINCT FROM b.k WHERE a.v IS DISTINCT FROM previous_v'))
        .toEqual(['a', 'b']);
    });

    it('a subquery nested in a function keeps its own FROM', () => {
      expect(tablesOf('SELECT EXTRACT(YEAR FROM (SELECT MAX(d) FROM calendar)) AS y FROM facts'))
        .toEqual(['calendar', 'facts']);
    });

    it('normal FROM, JOIN, subquery and CTE cases are unchanged', () => {
      const result = extractTablesFromSql(`
        WITH recent AS (
          SELECT * FROM analytics.orders WHERE EXTRACT(YEAR FROM order_date) = 2024
        )
        SELECT c.name, SUM(r.amount)
        FROM recent r
        LEFT JOIN analytics.customers c ON c.id = r.customer_id
        JOIN (SELECT id FROM analytics.segments) s ON s.id = c.segment_id
        WHERE r.status IN (SELECT status FROM analytics.valid_statuses)
        GROUP BY c.name
      `);
      expect([...result.tables].sort()).toEqual([
        'analytics.customers', 'analytics.orders', 'analytics.segments', 'analytics.valid_statuses',
      ]);
      expect(result.ctes).toEqual(['recent']);
    });
  });

  describe('quoted, schema-qualified names', () => {
    it('reads a fully quoted schema.table as the table, not the schema', () => {
      // The shape "Start from a table" Datasets generate.
      const result = extractTablesFromSql('SELECT "order_line_id" FROM "main"."order_lines"');
      expect(result.tables).toEqual(['main.order_lines']);
    });

    it('keeps the case of quoted parts and reads unquoted three-part names beside them', () => {
      const result = extractTablesFromSql(
        'SELECT * FROM warehouse.sales.orders o JOIN "Sales"."Customers" c ON o.cid = c.id',
      );
      expect(result.tables).toEqual(['warehouse.sales.orders', 'Sales.Customers']);
    });

    it.each([
      ['"main".order_lines', 'main.order_lines'],
      ['main."Order Lines"', 'main.Order Lines'],
      ['warehouse."Sales".orders', 'warehouse.Sales.orders'],
      ['"warehouse"."sales"."orders"', 'warehouse.sales.orders'],
      ['"weird""name"', 'weird"name'],
    ])('reads mixed quoting %s as %s', (relation, expected) => {
      expect(extractTablesFromSql(`SELECT * FROM ${relation} AS t`).tables).toEqual([expected]);
    });

    it('reads backtick and bracket quoting', () => {
      expect(extractTablesFromSql('SELECT * FROM `proj`.`sales`.`Orders`').tables).toEqual(['proj.sales.Orders']);
      expect(extractTablesFromSql('SELECT * FROM `proj.sales.Orders`').tables).toEqual(['proj.sales.Orders']);
      expect(extractTablesFromSql('SELECT * FROM [dbo].[Order Lines]').tables).toEqual(['dbo.Order Lines']);
      expect(extractTablesFromSql('SELECT * FROM [odd]]name]').tables).toEqual(['odd]name']);
    });

    it('reads quoted names in INSERT INTO', () => {
      const result = extractTablesFromSql('INSERT INTO "main"."target" SELECT * FROM "main"."source"');
      expect(result.tables).toEqual(['main.source', 'main.target']);
    });

    it('treats quoted and unquoted spellings of one relation as one table', () => {
      const result = extractTablesFromSql('SELECT * FROM "main"."orders" a JOIN main.orders b ON a.id = b.id');
      expect(result.tables).toEqual(['main.orders']);
    });

    it('still excludes CTEs and keeps ref(), @metric and reader functions beside quoted tables', () => {
      const result = extractTablesFromSql(`
        WITH "recent" AS (
          SELECT * FROM "main"."orders" WHERE placed_at > '2024-01-01'
        )
        SELECT r.*, @metric(revenue)
        FROM "recent" r
        JOIN ref("customer_segments") s ON r.customer_id = s.customer_id
        JOIN read_parquet('s3://lake/returns/*.parquet', hive_partitioning = true) x ON x.order_id = r.order_id
      `);
      expect(result.ctes).toEqual(['recent']);
      expect(result.tables).toEqual(['main.orders', "read_parquet('s3://lake/returns/*.parquet')"]);
      expect(result.refs).toEqual(['customer_segments']);
      expect(result.metricRefs).toEqual(['revenue']);
    });

    it('ignores quoted names inside comments and string literals', () => {
      const result = extractTablesFromSql(`
        -- FROM "main"."ghost_comment"
        /* JOIN "main"."ghost_block" */
        SELECT 'FROM "main"."ghost_string"' AS label FROM "main"."real"
      `);
      expect(result.tables).toEqual(['main.real']);
    });

    it('matches the parser-based analysis for every quoting it can parse', () => {
      for (const sql of [
        'SELECT "order_line_id" FROM "main"."order_lines"',
        'SELECT * FROM warehouse.sales.orders o JOIN "Sales"."Customers" c ON o.cid = c.id',
        'SELECT * FROM "main".order_lines',
        'SELECT * FROM main."Order Lines"',
      ]) {
        expect(extractTablesFromSql(sql).tables).toEqual(analyzeSqlReferences(sql, 'duckdb').tables);
      }
    });
  });
});

describe('analyzeSqlReferences', () => {
  it('extracts relations, aliases, CTEs, and columns from generated drilldown SQL', () => {
    const result = analyzeSqlReferences(`
      WITH enterprise AS (
        SELECT o.customer_id, o.week, SUM(o.amount) AS revenue
        FROM analytics.fct_orders o
        JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
        WHERE c.segment = 'Enterprise'
        GROUP BY 1, 2
      )
      SELECT week, revenue FROM enterprise WHERE revenue > 0
    `);

    expect(result.parsed).toBe(true);
    expect(result.tables).toEqual(
      expect.arrayContaining(['analytics.fct_orders', 'analytics.dim_customers']),
    );
    expect(result.tables).not.toContain('enterprise');
    expect(result.ctes).toContain('enterprise');
    expect(result.aliasToRelation.o).toBe('analytics.fct_orders');
    expect(result.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringContaining('cte:enterprise'),
        aliasToRelation: expect.objectContaining({
          o: 'analytics.fct_orders',
          c: 'analytics.dim_customers',
        }),
      }),
    ]));
    expect(result.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'analytics.fct_orders', column: 'amount' }),
        expect.objectContaining({ relation: 'analytics.dim_customers', column: 'segment' }),
      ]),
    );
  });

  it('distinguishes an ambiguous source reference from a legal output-alias reference', () => {
    const result = analyzeSqlReferences(`
      SELECT report_as_of_dt AS report_as_of_dt, SUM(o.amount) AS revenue
      FROM analytics.fct_orders o
      JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
      GROUP BY report_as_of_dt
      ORDER BY revenue DESC
    `, 'snowflake');
    const scope = result.scopes.find((candidate) => candidate.aliasToRelation.o);

    expect(scope?.columns.find((column) => column.column === 'report_as_of_dt')?.outputAliasReference).toBeUndefined();
    expect(scope?.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'revenue', outputAliasReference: true }),
    ]));
  });

  it('extracts equality join conditions with aliases resolved to relations', () => {
    const result = analyzeSqlReferences(`
      SELECT SUM(o.order_total) AS revenue
      FROM fct_orders o
      JOIN order_items oi ON oi.order_id = o.order_id
    `);
    expect(result.joins).toEqual([
      expect.objectContaining({
        leftRelation: 'order_items',
        leftColumn: 'order_id',
        rightRelation: 'fct_orders',
        rightColumn: 'order_id',
      }),
    ]);
  });

  it('AGT-010/EXP-003 classifies nested subquery aliases as derived instead of physical relations', () => {
    const result = analyzeSqlReferences(`
      SELECT "subq_2".customer_id, p.product_name
      FROM (
        SELECT customer_id, product_id
        FROM analytics.order_items
      ) AS "subq_2"
      JOIN analytics.products AS p
        ON "subq_2".product_id = p.product_id
    `, 'snowflake');

    expect(result.parsed).toBe(true);
    expect(result.derivedRelations).toContain('subq_2');
    expect(result.tables).toEqual(expect.arrayContaining(['analytics.order_items', 'analytics.products']));
    expect(result.tables).not.toContain('subq_2');
    expect(result.columns).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'subq_2' }),
    ]));
  });

  it('extracts aggregate function references with their relation and distinct flag', () => {
    const result = analyzeSqlReferences(`
      SELECT SUM(o.order_total) AS revenue, COUNT(DISTINCT o.customer_id) AS customers
      FROM fct_orders o
    `);
    expect(result.aggregates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ func: 'SUM', column: 'order_total', relation: 'fct_orders', distinct: false }),
        expect.objectContaining({ func: 'COUNT', column: 'customer_id', relation: 'fct_orders', distinct: true }),
      ]),
    );
  });

  it('AGT-005 attributes wrapped and calculated aggregates to their source relation', () => {
    const result = analyzeSqlReferences(`
      SELECT
        SUM(ROUND(COALESCE(o.amount, 0), 2)) AS rounded_amount,
        SUM(o.unit_price * o.quantity) AS extended_amount
      FROM analytics.fct_orders o
    `);

    expect(result.aggregates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ func: 'SUM', column: 'amount', relation: 'analytics.fct_orders' }),
        expect.objectContaining({ func: 'SUM', column: undefined, relation: 'analytics.fct_orders' }),
      ]),
    );
  });
});

describe('the names a WITH list defines', () => {
  const names = (sql: string) => analyzeSqlReferences(sql).ctes;
  it('reads column lists, MATERIALIZED and every entry of the list', () => {
    expect(names('WITH RECURSIVE tree(id, n) AS (SELECT 1, 2 UNION ALL SELECT id, n FROM tree), a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT * FROM tree, a, b').sort()).toEqual(['a', 'b', 'tree']);
  });
  it('a CTE can only be defined at the head of a list entry', () => {
    expect(names("SELECT 1 FROM a WHERE x <> 'WITH salaries AS ('")).toEqual([]);
    expect(names('SELECT 1 /* WITH salaries AS ( */ FROM a')).toEqual([]);
    expect(names('WITH k AS (SELECT 1) SELECT 1 FROM a WINDOW salaries AS (PARTITION BY x)')).toEqual(['k']);
    expect(names('WITH "main.salaries" AS (SELECT 1) SELECT 1 FROM a')).toEqual([]);
  });
});
