import { describe, expect, it } from 'vitest';
import type { LocalContextPack } from './catalog.js';
import { inspectedRelationMatches, validateSqlAgainstLocalContext } from './sql-context-validation.js';

describe('validateSqlAgainstLocalContext', () => {
  it('rejects unresolved internal graph relation identities before warehouse execution', () => {
    const result = validateSqlAgainstLocalContext(
      'SELECT order_id FROM source::analytics.fct_orders',
      pack(),
      { dialect: 'snowflake' },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_relation',
      offending: {
        relation: 'source::analytics.fct_orders',
        relations: ['source::analytics.fct_orders'],
      },
    });
    if (!result.ok) {
      expect(result.error).toContain('only for retrieval and lineage');
      expect(result.error).toContain('physical database.schema.table');
    }
  });

  it('accepts valid aliases, joins, CTEs, aggregates, and qualified columns', () => {
    const result = validateSqlAgainstLocalContext(`
      WITH enterprise AS (
        SELECT o.week, SUM(o.amount) AS revenue
        FROM analytics.fct_orders o
        JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
        WHERE c.segment = 'Enterprise'
        GROUP BY 1
      )
      SELECT week, revenue FROM enterprise
    `, pack());

    expect(result.ok).toBe(true);
  });

  it('validates a frozen relational statement with verified positional values without rewriting the submitted SQL', () => {
    const sql = `
      SELECT DATE_TRUNC('month', p.game_date) AS month,
        COUNT(DISTINCT p.game_id) AS games_played,
        SUM(p.points_scored) AS points_scored
      FROM nba_analysis.TRANSFORMED.local_player_game_facts AS p
      WHERE p.player_name = ? AND p.is_home = ? AND p.participated = ?
        AND p.game_date >= ? AND p.game_date < ?
      GROUP BY 1
      ORDER BY 1
    `;
    const runtimeSchema = [{
      relation: 'nba_analysis.TRANSFORMED.local_player_game_facts',
      columns: [
        { name: 'game_id', type: 'BIGINT' }, { name: 'player_name', type: 'VARCHAR' }, { name: 'is_home', type: 'BOOLEAN' },
        { name: 'participated', type: 'BOOLEAN' }, { name: 'game_date', type: 'DATE' }, { name: 'points_scored', type: 'INTEGER' },
      ],
      source: 'warehouse probe', columnCompleteness: 'complete' as const,
    }];

    const result = validateSqlAgainstLocalContext(sql, undefined, {
      dialect: 'duckdb', runtimeSchema, runtimeSchemaExact: true,
      positionalParameterCount: 5, enforceGenerationReadiness: false,
    });

    expect(result.ok).toBe(true);
    expect(result.referencedRelations).toEqual(['nba_analysis.TRANSFORMED.local_player_game_facts']);
  });

  it('accepts DuckDB compiler quoting for the same exact inspected physical binding', () => {
    const runtimeSchema = [{
      relation: 'nba_analysis.TRANSFORMED.local_player_game_facts',
      columns: [{ name: 'player_name', type: 'VARCHAR' }],
      source: 'warehouse probe', columnCompleteness: 'complete' as const,
    }];

    const result = validateSqlAgainstLocalContext(
      'SELECT "player_name" FROM "nba_analysis"."TRANSFORMED"."local_player_game_facts"',
      undefined,
      { dialect: 'duckdb', runtimeSchema, runtimeSchemaExact: true, enforceGenerationReadiness: false },
    );

    expect(result.ok).toBe(true);
    expect(result.referencedRelations).toEqual(['"nba_analysis"."TRANSFORMED"."local_player_game_facts"']);
  });

  describe('SQL the statement defines itself is never outside the inspected metadata', () => {
    const table = (relation: string, columns: string[]) => ({ relation, columns: columns.map((name) => ({ name, type: 'INTEGER' })), source: 'warehouse probe', columnCompleteness: 'complete' as const });
    const validate = (sql: string, runtimeSchema: ReturnType<typeof table>[], dialect = 'sqlite') => validateSqlAgainstLocalContext(sql, undefined, { dialect, runtimeSchema, runtimeSchemaExact: true, enforceGenerationReadiness: false });

    it('a quoted relation on a case-insensitive engine is the inspected relation', () => {
      const schema = [table('main.Movie', ['MID', 'title'])];
      expect(validate('SELECT m."title" FROM "main"."Movie" AS m', schema).ok).toBe(true);
      expect(validate('SELECT title FROM MAIN.movie', schema).ok).toBe(true);
      // Snowflake keeps quote state in the identity: a different object.
      expect(validate('SELECT "title" FROM "main"."Movie"', [table('MAIN.MOVIE', ['TITLE'])], 'snowflake').ok).toBe(false);
    });

    it('a recursive CTE column list and the aliases of a CTE select list are defined names', () => {
      const schema = [table('main.relations', ['parent_id', 'child_id', 'qty'])];
      const recursive = validate(`WITH RECURSIVE tree(root_id, node_id, qty) AS (
          SELECT r.parent_id, r.child_id, r.qty FROM main.relations AS r
          UNION ALL
          SELECT t.root_id, r.child_id, t.qty * r.qty FROM tree AS t JOIN main.relations AS r ON r.parent_id = t.node_id)
        SELECT root_id, SUM(qty) AS total FROM tree GROUP BY root_id`, schema);
      expect(recursive).toMatchObject({ ok: true });
      const labelled = validate(`WITH classified AS (
          SELECT CASE WHEN EXISTS (SELECT 1 FROM main.relations AS x WHERE x.child_id = r.parent_id) THEN 'nested' ELSE 'top' END AS category
          FROM main.relations AS r)
        SELECT category, COUNT(*) AS n FROM classified GROUP BY category`, schema);
      expect(labelled).toMatchObject({ ok: true });
      // A column no table and no part of the statement defines is still unknown.
      expect(validate('SELECT r.parent_id, colour FROM main.relations AS r', schema)).toMatchObject({ ok: false, code: 'unknown_column' });
    });

    it('a column merged by JOIN … USING is not ambiguous when read unqualified', () => {
      const schema = [table('main.deliveries', ['match_id', 'ball_id', 'bowler']), table('main.scores', ['match_id', 'ball_id', 'runs'])];
      expect(validate('SELECT match_id, bowler, SUM(runs) AS runs FROM main.deliveries LEFT JOIN main.scores USING (match_id, ball_id) GROUP BY match_id, bowler', schema)).toMatchObject({ ok: true });
      expect(validate('SELECT match_id FROM main.deliveries AS d JOIN main.scores AS s ON s.ball_id = d.ball_id', schema)).toMatchObject({ ok: false, code: 'unknown_column' });
    });

    it('casting to REAL before SUM is not a precision loss on SQLite, which stores no DECIMAL', () => {
      const schema = [table('main.stock', ['product_id', 'qty'])];
      expect(validate('SELECT SUM(CAST(s.qty AS REAL)) AS total FROM main.stock AS s', schema)).toMatchObject({ ok: true });
      expect(validate('SELECT SUM(CAST(s.qty AS REAL)) AS total FROM main.stock AS s', schema, 'duckdb')).toMatchObject({ ok: false, code: 'unsafe_aggregation' });
    });
  });

  it('rejects a positional candidate whose bound-value count does not match its SQL', () => {
    const result = validateSqlAgainstLocalContext(
      'SELECT SUM(p.points_scored) FROM nba_analysis.TRANSFORMED.local_player_game_facts p WHERE p.player_name = ?',
      undefined,
      { positionalParameterCount: 0 },
    );

    expect(result).toMatchObject({ ok: false, code: 'unsafe_sql' });
    if (!result.ok) expect(result.error).toContain('1 positional placeholder');
  });

  it('AGT-005 rejects pre-aggregation rounding and preserves final currency rounding', () => {
    const unsafe = validateSqlAgainstLocalContext(
      'SELECT SUM(ROUND(COALESCE(o.amount, 0), 2)) AS amount FROM analytics.fct_orders o',
      pack(),
    );
    const safe = validateSqlAgainstLocalContext(
      'SELECT ROUND(COALESCE(SUM(o.amount), 0), 2) AS amount FROM analytics.fct_orders o',
      pack(),
    );

    expect(unsafe).toMatchObject({ ok: false, code: 'unsafe_aggregation' });
    expect(safe.ok).toBe(true);
  });

  it('AGT-010 rejects a dbt-key-proven fan-out instead of returning an inflated amount', () => {
    const context = pack();
    context.allowedSqlContext.relations.push({
      relation: 'analytics.order_items',
      name: 'order_items',
      source: 'test',
      columns: [{ name: 'order_item_id' }, { name: 'order_id' }],
    });
    context.objects = [
      {
        objectKey: 'dbt:model:fct_orders',
        objectType: 'dbt_model',
        name: 'fct_orders',
        payload: { relation: 'analytics.fct_orders', uniqueColumns: ['order_id'] },
      },
      {
        objectKey: 'dbt:model:order_items',
        objectType: 'dbt_model',
        name: 'order_items',
        payload: { relation: 'analytics.order_items', uniqueColumns: ['order_item_id'] },
      },
    ];

    const result = validateSqlAgainstLocalContext(`
      SELECT SUM(o.amount) AS amount
      FROM analytics.fct_orders o
      JOIN analytics.order_items oi ON oi.order_id = o.order_id
    `, context);

    expect(result).toMatchObject({ ok: false, code: 'unsafe_aggregation' });
    if (!result.ok) expect(result.error).toContain('Possible fan-out');
  });

  it('allows semantic-compiler SQL to retain its governed aggregation contract', () => {
    const result = validateSqlAgainstLocalContext(
      'SELECT SUM(ROUND(COALESCE(o.amount, 0), 2)) AS amount FROM analytics.fct_orders o',
      pack(),
      { enforceAggregationIntegrity: false },
    );
    expect(result.ok).toBe(true);
  });

  it('accepts inspected source columns and output aliases selected from a joined CTE', () => {
    const result = validateSqlAgainstLocalContext(`
      WITH enterprise AS (
        SELECT o.amount AS revenue, c.segment
        FROM analytics.fct_orders o
        JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
      )
      SELECT revenue, segment FROM enterprise
    `, pack());

    expect(result.ok).toBe(true);
  });

  it('accepts implicit output aliases selected from CTEs', () => {
    const result = validateSqlAgainstLocalContext(`
      WITH enterprise AS (
        SELECT c.segment, SUM(o.amount) revenue
        FROM analytics.fct_orders o
        JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
        GROUP BY c.segment
      )
      SELECT segment, revenue FROM enterprise
    `, pack());

    expect(result.ok).toBe(true);
  });

  it('rejects unknown unqualified columns selected from joined CTEs', () => {
    const result = validateSqlAgainstLocalContext(`
      WITH enterprise AS (
        SELECT o.amount AS revenue, c.segment
        FROM analytics.fct_orders o
        JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
      )
      SELECT fake_column FROM enterprise
    `, pack());

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_column',
    });
  });

  it('rejects an unqualified column shared by multiple joined relations', () => {
    const context = pack();
    context.allowedSqlContext.relations = [
      {
        relation: 'jaffle_shop.dev.order_items',
        name: 'order_items',
        source: 'runtime schema context',
        columns: [
          { name: 'product_id' },
          { name: 'product_price' },
          { name: 'is_drink_item' },
        ],
      },
      {
        relation: 'jaffle_shop.dev.products',
        name: 'products',
        source: 'runtime schema context',
        columns: [
          { name: 'product_id' },
          { name: 'product_price' },
          { name: 'is_drink_item' },
        ],
      },
    ];

    const result = validateSqlAgainstLocalContext(`
      SELECT SUM(CASE WHEN is_drink_item THEN product_price ELSE 0 END) AS beverage_revenue
      FROM jaffle_shop.dev.order_items AS oi
      JOIN jaffle_shop.dev.products AS p ON oi.product_id = p.product_id
    `, context);

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_column',
      offending: { column: 'is_drink_item' },
    });
    if (!result.ok) {
      expect(result.error).toContain('oi (jaffle_shop.dev.order_items)');
      expect(result.error).toContain('p (jaffle_shop.dev.products)');
      expect(result.error).toContain('Qualify it with the intended relation alias');
    }
  });

  it('AGT-015 rejects an ambiguous column inside a CTE before warehouse execution', () => {
    const context = pack();
    context.allowedSqlContext.relations = [
      {
        relation: 'analytics.fct_orders',
        name: 'fct_orders',
        source: 'runtime schema context',
        columns: [{ name: 'customer_id' }, { name: 'report_as_of_dt' }, { name: 'amount' }],
      },
      {
        relation: 'analytics.dim_customers',
        name: 'dim_customers',
        source: 'runtime schema context',
        columns: [{ name: 'customer_id' }, { name: 'report_as_of_dt' }, { name: 'segment' }],
      },
    ];

    const result = validateSqlAgainstLocalContext(`
      WITH customer_revenue AS (
        SELECT report_as_of_dt AS report_as_of_dt, c.segment, SUM(o.amount) AS revenue
        FROM analytics.fct_orders AS o
        JOIN analytics.dim_customers AS c ON o.customer_id = c.customer_id
        GROUP BY report_as_of_dt, c.segment
      )
      SELECT report_as_of_dt, segment, revenue FROM customer_revenue
    `, context, { dialect: 'snowflake' });

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_column',
      offending: { column: 'report_as_of_dt' },
    });
    if (!result.ok) {
      expect(result.error).toContain('o (analytics.fct_orders)');
      expect(result.error).toContain('c (analytics.dim_customers)');
    }
  });

  it('accepts shared columns when the intended relation alias is explicit', () => {
    const context = pack();
    context.allowedSqlContext.relations[1]!.columns.push({ name: 'amount' });

    const result = validateSqlAgainstLocalContext(`
      SELECT SUM(o.amount) AS revenue
      FROM analytics.fct_orders AS o
      JOIN analytics.dim_customers AS c ON o.customer_id = c.customer_id
    `, context);

    expect(result.ok).toBe(true);
  });

  it('parses generated SQL with the active Snowflake dialect instead of rejecting valid QUALIFY syntax', () => {
    const context = pack();
    context.allowedSqlContext.relations = [{
      relation: 'analytics.usage_daily',
      name: 'usage_daily',
      source: 'runtime schema context',
      columns: [
        { name: 'account_id' },
        { name: 'report_date' },
      ],
    }];
    const sql = `
      SELECT u.account_id, u.report_date
      FROM analytics.usage_daily AS u
      QUALIFY ROW_NUMBER() OVER (PARTITION BY u.account_id ORDER BY u.report_date DESC) = 1
    `;

    expect(validateSqlAgainstLocalContext(sql, context, { dialect: 'snowflake' }).ok).toBe(true);
    expect(validateSqlAgainstLocalContext(sql, context).ok).toBe(false);
  });

  it('AGT-012 rejects a trusted product member applied to a location column', () => {
    const context = pack();
    context.allowedSqlContext.relations.push(
      {
        relation: 'analytics.products',
        name: 'products',
        source: 'test',
        columns: [{ name: 'product_id' }, { name: 'product_name' }],
      },
      {
        relation: 'analytics.locations',
        name: 'locations',
        source: 'test',
        columns: [{ name: 'location_id' }, { name: 'location_name' }],
      },
    );

    const result = validateSqlAgainstLocalContext(
      "SELECT location_name FROM analytics.locations WHERE location_name = 'Flame Impala'",
      context,
      { memberBindings: [{ dimension: 'product', values: ['Flame Impala'] }] },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'misbound_filter',
      offending: { column: 'location_name' },
    });
    if (!result.ok) expect(result.error).toContain('binding dimension is product');
  });

  it('AGT-012 accepts a trusted member on its typed dimension column', () => {
    const context = pack();
    context.allowedSqlContext.relations.push({
      relation: 'analytics.products',
      name: 'products',
      source: 'test',
      columns: [{ name: 'product_id' }, { name: 'product_name' }],
    });

    expect(validateSqlAgainstLocalContext(
      "SELECT product_name FROM analytics.products WHERE product_name = 'Flame Impala'",
      context,
      { memberBindings: [{ dimension: 'product', values: ['Flame Impala'] }] },
    ).ok).toBe(true);
  });

  it('AGT-012 accepts a typed member applied through LIKE and ILIKE pattern filters (Slice 1b)', () => {
    const context = pack();
    context.allowedSqlContext.relations.push({
      relation: 'analytics.customers',
      name: 'customers',
      source: 'test',
      columns: [{ name: 'customer_id' }, { name: 'customer_name' }],
    });

    for (const sql of [
      "SELECT customer_name FROM analytics.customers AS c WHERE c.customer_name ILIKE '%Capital One%'",
      "SELECT customer_name FROM analytics.customers AS c WHERE c.customer_name LIKE 'Capital One%'",
      "SELECT customer_name FROM analytics.customers AS c WHERE LOWER(c.customer_name) LIKE '%capital one%'",
      "SELECT customer_name FROM analytics.customers AS c WHERE c.customer_name ILIKE '%Capital%'",
    ]) {
      const result = validateSqlAgainstLocalContext(sql, context, {
        memberBindings: [{ dimension: 'customer', values: ['Capital One'] }],
      });
      expect(result.ok, sql).toBe(true);
    }
  });

  it('AGT-012 still rejects NOT LIKE and unrelated pattern filters (Slice 1b)', () => {
    const context = pack();
    context.allowedSqlContext.relations.push({
      relation: 'analytics.customers',
      name: 'customers',
      source: 'test',
      columns: [{ name: 'customer_id' }, { name: 'customer_name' }],
    });

    for (const sql of [
      "SELECT customer_name FROM analytics.customers AS c WHERE c.customer_name NOT LIKE '%Capital One%'",
      "SELECT customer_name FROM analytics.customers AS c WHERE c.customer_name ILIKE '%Chase%'",
    ]) {
      const result = validateSqlAgainstLocalContext(sql, context, {
        memberBindings: [{ dimension: 'customer', values: ['Capital One'] }],
      });
      expect(result.ok, sql).toBe(false);
      if (!result.ok) expect(result.code).toBe('misbound_filter');
    }
  });

  it('AGT-012 validates typed bindings through normalized text predicates', () => {
    const context = pack();
    context.allowedSqlContext.relations.push({
      relation: 'analytics.products',
      name: 'products',
      source: 'test',
      columns: [{ name: 'product_id' }, { name: 'product_name' }],
    });

    expect(validateSqlAgainstLocalContext(
      "SELECT product_name FROM analytics.products AS p WHERE LOWER(p.product_name) = LOWER('Flame Impala')",
      context,
      { memberBindings: [{ dimension: 'product', values: ['Flame Impala'] }] },
    ).ok).toBe(true);
  });

  it('prefers complete live schema over a partial fully-qualified context card', () => {
    const context = pack();
    context.allowedSqlContext.relations = [
      {
        relation: 'jaffle_shop.dev.order_items',
        name: 'order_items',
        source: 'certified source SQL shape',
        columnCompleteness: 'partial',
        columns: [{ name: 'product_id' }, { name: 'product_price' }],
      },
      {
        relation: 'jaffle_shop.dev.products',
        name: 'products',
        source: 'dbt catalog',
        columns: [{ name: 'product_id' }, { name: 'product_price' }, { name: 'is_drink_item' }],
      },
    ];

    const result = validateSqlAgainstLocalContext(`
      SELECT SUM(CASE WHEN is_drink_item THEN product_price ELSE 0 END) AS beverage_revenue
      FROM jaffle_shop.dev.order_items AS oi
      JOIN jaffle_shop.dev.products AS p ON oi.product_id = p.product_id
    `, context, {
      runtimeSchema: [{
        relation: 'dev.order_items',
        name: 'order_items',
        source: 'runtime information_schema',
        columns: [
          { name: 'product_id' },
          { name: 'product_price' },
          { name: 'is_drink_item' },
        ],
      }],
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_column',
      offending: { column: 'is_drink_item' },
    });
    if (!result.ok) expect(result.error).toContain('multiple joined relations');
  });

  it('rejects relations outside the context pack', () => {
    const result = validateSqlAgainstLocalContext(
      'SELECT order_id FROM analytics.secret_orders',
      pack(),
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_relation',
      offending: { relation: 'analytics.secret_orders' },
    });
  });

  it('rejects columns outside the inspected relation columns', () => {
    const result = validateSqlAgainstLocalContext(
      'SELECT o.fake_column FROM analytics.fct_orders o',
      pack(),
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_column',
      offending: { relation: 'analytics.fct_orders', column: 'fake_column' },
    });
  });

  it('validates against the union of metadata context and runtime schema context', () => {
    const context = pack();
    context.allowedSqlContext.relations = [context.allowedSqlContext.relations[0]!];

    const result = validateSqlAgainstLocalContext(`
      SELECT o.order_id, s.supply_name, s.supply_cost
      FROM analytics.fct_orders o
      JOIN analytics.supplies s ON o.order_id = s.order_id
    `, context, {
      runtimeSchema: [{
        relation: 'analytics.supplies',
        name: 'supplies',
        source: 'runtime schema context',
        columns: [
          { name: 'order_id' },
          { name: 'supply_name' },
          { name: 'supply_cost' },
        ],
      }],
    });

    expect(result.ok).toBe(true);
  });

  it('uses certified source SQL shape columns when relation metadata is sparse', () => {
    const context = pack();
    context.allowedSqlContext = {
      relations: [{
        relation: 'analytics.player_stats',
        name: 'player_stats',
        source: 'certified block dependency',
        columns: [],
      }],
      sourceBlockSql: [{
        objectKey: 'dql:block:Top Players',
        name: 'Top Players',
        status: 'certified',
        sql: 'SELECT player_name, season, total_points FROM analytics.player_stats ORDER BY total_points DESC LIMIT 10',
      }],
    };

    expect(validateSqlAgainstLocalContext(
      'SELECT player_name, SUM(total_points) AS total_points FROM analytics.player_stats GROUP BY player_name',
      context,
    ).ok).toBe(true);

    const advisory = validateSqlAgainstLocalContext(
      'SELECT player_name, fake_metric FROM analytics.player_stats',
      context,
    );
    expect(advisory.ok).toBe(true);
    expect(advisory.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('partial')]),
    );
  });

  it('does not let a partial runtime relation erase certified source SQL shape columns', () => {
    const context = pack();
    context.allowedSqlContext = {
      relations: [{
        relation: 'analytics.player_stats',
        name: 'player_stats',
        source: 'certified block dependency',
        columnCompleteness: 'partial',
        columns: [],
      }],
      sourceBlockSql: [{
        objectKey: 'dql:block:Top Players',
        name: 'Top Players',
        status: 'certified',
        sql: 'SELECT player_name, season, total_points FROM analytics.player_stats ORDER BY total_points DESC LIMIT 10',
      }],
    };

    const result = validateSqlAgainstLocalContext(
      'SELECT player_name, SUM(total_points) AS total_points FROM analytics.player_stats GROUP BY player_name',
      context,
      {
        runtimeSchema: [{
          relation: 'analytics.player_stats',
          name: 'player_stats',
          source: 'partial retrieved context',
          columnCompleteness: 'partial',
          columns: [],
        }],
      },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('treats explicitly partial relation columns as advisory', () => {
    const context = pack();
    context.allowedSqlContext.relations[0]!.columnCompleteness = 'partial';
    const result = validateSqlAgainstLocalContext(
      'SELECT o.fake_column FROM analytics.fct_orders o',
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('partial')]),
    );
  });

  it('rejects a constant-only / tableless SELECT that reads no relation', () => {
    // A data answer must read a relation; `SELECT NULL` / `SELECT 1` dodges the
    // question with a grounded-looking non-answer. Holds even without a pack.
    const withPack = validateSqlAgainstLocalContext('SELECT NULL', pack());
    expect(withPack.ok).toBe(false);
    expect(withPack.code).toBe('insufficient_context');
    const bare = validateSqlAgainstLocalContext('SELECT 1 AS x', undefined);
    expect(bare.ok).toBe(false);
    expect(bare.code).toBe('insufficient_context');
  });

  it('accepts output aliases used in ORDER BY when source columns are inspected', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT o.region, SUM(o.amount) AS revenue_total
       FROM analytics.fct_orders o
       GROUP BY o.region
       ORDER BY revenue_total DESC`,
      pack(),
    );

    expect(result.ok).toBe(true);
  });

  it('accepts implicit output aliases used in ORDER BY', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT o.region, COUNT(*) order_count
       FROM analytics.fct_orders o
       GROUP BY o.region
       ORDER BY order_count DESC`,
      pack(),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects change analysis when no baseline column exists', () => {
    const noTime = pack();
    noTime.allowedSqlContext.relations[0]!.columns = noTime.allowedSqlContext.relations[0]!.columns
      .filter((column) => column.name !== 'week');
    const result = validateSqlAgainstLocalContext(
      'SELECT SUM(amount) AS revenue FROM analytics.fct_orders',
      noTime,
      { intent: 'diagnose_change', question: 'why did revenue change?' },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'missing_baseline',
    });
  });

  it('accepts entity drilldown filters on the inspected sample-value column', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT c.segment, SUM(o.amount) AS revenue
       FROM analytics.fct_orders o
       JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
       WHERE c.segment = 'Enterprise'
       GROUP BY 1`,
      pack(),
      { intent: 'entity_drilldown', question: 'Break down Enterprise', filterValues: ['Enterprise'] },
    );

    expect(result.ok).toBe(true);
  });

  it('rejects entity drilldown filters on the wrong inspected column', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT o.region, SUM(o.amount) AS revenue
       FROM analytics.fct_orders o
       WHERE o.region = 'Enterprise'
       GROUP BY 1`,
      pack(),
      { intent: 'entity_drilldown', question: 'Break down Enterprise', filterValues: ['Enterprise'] },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'ambiguous_filter',
    });
    if (!result.ok) {
      expect(result.error).toContain('analytics.dim_customers.segment');
    }
  });

  it('does not hard-fail a generic clarify route when allowed SQL context exists', () => {
    const context = pack();
    context.routeDecision = {
      route: 'clarify',
      intent: 'clarify',
      reason: 'ZLens needs one more business or metadata detail before it can safely generate SQL.',
      trustLabel: 'mixed',
      reviewStatus: 'none',
      selectedEvidence: [],
      missingContext: [{
        kind: 'metadata',
        severity: 'blocking',
        message: 'No certified block, semantic metric, dbt model, or runtime schema matched strongly enough to answer safely.',
      }],
      followUps: [],
    };

    const result = validateSqlAgainstLocalContext(
      'SELECT region, SUM(amount) AS revenue FROM analytics.fct_orders GROUP BY region',
      context,
    );

    expect(result.ok).toBe(true);
  });

  it('keeps explicit blocking clarify gaps terminal', () => {
    const context = pack();
    context.routeDecision = {
      route: 'clarify',
      intent: 'diagnose_change',
      reason: 'Missing baseline context.',
      trustLabel: 'mixed',
      reviewStatus: 'none',
      selectedEvidence: [],
      missingContext: [{
        kind: 'baseline',
        severity: 'blocking',
        message: 'A baseline time period is required before explaining what changed.',
      }],
      followUps: [],
    };

    const result = validateSqlAgainstLocalContext(
      'SELECT region, SUM(amount) AS revenue FROM analytics.fct_orders GROUP BY region',
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'insufficient_context',
    });
  });
});

function pack(): LocalContextPack {
  return {
    id: 'ctx_test',
    question: 'Drill into Enterprise last week',
    focusObjectKey: null,
    mode: 'question',
    trustLabel: 'mixed',
    objects: [],
    edges: [],
    queryRuns: [],
    citations: [],
    evidenceSummaries: [],
    warnings: [],
    routeDecision: {
      route: 'generated_sql',
      intent: 'entity_drilldown',
      reason: 'test',
      trustLabel: 'mixed',
      reviewStatus: 'draft_ready',
      selectedEvidence: [],
      missingContext: [],
      followUps: [],
    },
    evidenceRoles: [],
    allowedSqlContext: {
      relations: [
        {
          relation: 'analytics.fct_orders',
          name: 'fct_orders',
          source: 'test',
          columns: [
            { name: 'order_id' },
            { name: 'customer_id' },
            { name: 'amount' },
            { name: 'week' },
            { name: 'region', sampleValues: ['North'] },
          ],
        },
        {
          relation: 'analytics.dim_customers',
          name: 'dim_customers',
          source: 'test',
          columns: [
            { name: 'customer_id' },
            { name: 'segment', sampleValues: ['Enterprise'] },
          ],
        },
      ],
      sourceBlockSql: [],
    },
    missingContext: [],
    conflicts: [],
    retrievalDiagnostics: {
      strategy: 'sqlite_fts',
      selectedObjects: 0,
      selectedEvidence: [],
      topRejected: [],
      certifiedCandidateFits: [],
      candidateConflicts: [],
    },
    freshness: {
      catalogPath: '.dql/cache/metadata.sqlite',
      builtAt: null,
      fingerprint: null,
    },
  };
}

describe('ambiguity detection on WIDE (truncated) enterprise relations', () => {
  // Reproduces the Snowflake failure: two wide fact tables both carry
  // report_as_of_date. Because each has >120 columns the catalog marks them
  // `partial`, which used to switch the ambiguity guard off entirely — so the
  // unqualified reference sailed through and Snowflake raised the error instead.
  const wide = (relation: string, extra: string[]): LocalContextPack['allowedSqlContext']['relations'][number] => ({
    relation,
    name: relation.split('.').pop()!,
    source: 'test',
    columnCompleteness: 'partial',
    columns: [
      { name: 'report_as_of_date', type: 'date' },
      ...extra.map((name) => ({ name, type: 'text' })),
      ...Array.from({ length: 200 }, (_, index) => ({ name: `filler_${index}`, type: 'text' })),
    ],
  });

  const widePack = (): LocalContextPack => {
    const base = pack();
    base.allowedSqlContext.relations = [
      wide('dw.fct_bcm_hdr', ['bcm_id', 'split_qty']),
      wide('dw.fct_bcm_dtl', ['bcm_id', 'amount']),
    ];
    return base;
  };

  it('detects an unqualified column owned by two truncated relations', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT report_as_of_date, SUM(h.split_qty) AS qty
       FROM dw.fct_bcm_hdr h
       JOIN dw.fct_bcm_dtl d ON h.bcm_id = d.bcm_id
       GROUP BY report_as_of_date`,
      widePack(),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown_column');
    expect(result.offending?.column).toBe('report_as_of_date');
    expect(result.error).toContain('multiple joined relations');
  });

  it('does not report a CTE that shadows a real relation name', () => {
    // Relaxing the completeness rule makes partial relations count as owners,
    // which opens this false positive: the CTE `fct_bcm_dtl` is not the table.
    const result = validateSqlAgainstLocalContext(
      `WITH fct_bcm_dtl AS (SELECT bcm_id FROM dw.fct_bcm_dtl)
       SELECT report_as_of_date FROM dw.fct_bcm_hdr h JOIN fct_bcm_dtl d ON h.bcm_id = d.bcm_id`,
      widePack(),
    );
    expect(result.offending?.column).toBeUndefined();
  });

  it('stays quiet when the column is qualified', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT h.report_as_of_date, SUM(h.split_qty) AS qty
       FROM dw.fct_bcm_hdr h
       JOIN dw.fct_bcm_dtl d ON h.bcm_id = d.bcm_id
       GROUP BY h.report_as_of_date`,
      widePack(),
    );
    expect(result.ok).toBe(true);
  });
});

describe('unknown relations are reported completely', () => {
  it('names every unretrieved relation so one re-ground can resolve them all', () => {
    const contextPack = {
      objects: [],
      missingContext: [],
      allowedSqlContext: {
        relations: [{
          relation: 'dev.orders', name: 'orders', source: 'test',
          columnCompleteness: 'complete' as const,
          columns: [{ name: 'order_id' }, { name: 'customer_id' }],
        }],
        sourceBlockSql: [],
      },
    } as unknown as Parameters<typeof validateSqlAgainstLocalContext>[1];

    const result = validateSqlAgainstLocalContext(
      'SELECT o.order_id FROM dev.orders o JOIN dev.customers c ON c.id = o.customer_id JOIN dev.products p ON p.id = o.product_id',
      contextPack,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown_relation');
    // The first is kept for compatibility...
    expect(result.offending?.relation).toBeTruthy();
    // ...but every unknown relation must be reported, or the single re-ground
    // attempt fixes one and the answer is refused for the next.
    const reported = result.offending?.relations ?? [];
    expect(reported.some((relation) => relation.endsWith('customers'))).toBe(true);
    expect(reported.some((relation) => relation.endsWith('products'))).toBe(true);
    expect(reported.some((relation) => relation.endsWith('orders'))).toBe(false);
  });
});

describe('physical execution bindings', () => {
  it('does not let a same-tail Snowflake relation select a different database', () => {
    const runtimeSchema = [{
      relation: '"Db.With.Dot"."Public"."Events"',
      catalogOrDatabase: 'Db.With.Dot',
      schema: 'Public',
      name: 'Events',
      executionTargetFingerprint: 'target:role-a',
      source: 'warehouse_probe',
      columnCompleteness: 'complete' as const,
      columns: [{ name: 'EventId', type: 'NUMBER' }],
    }];
    const wrongDatabase = validateSqlAgainstLocalContext(
      'SELECT "EventId" FROM "Other.Db"."Public"."Events"',
      undefined,
      { dialect: 'snowflake', runtimeSchema, runtimeSchemaExact: true, executionTargetFingerprint: 'target:role-a' },
    );
    expect(wrongDatabase).toMatchObject({ ok: false, code: 'unknown_relation' });
    if (!wrongDatabase.ok) expect(wrongDatabase.error).toContain('exact bound physical relation');

    const exact = validateSqlAgainstLocalContext(
      'SELECT "EventId" FROM "Db.With.Dot"."Public"."Events"',
      undefined,
      { dialect: 'snowflake', runtimeSchema, runtimeSchemaExact: true, executionTargetFingerprint: 'target:role-a' },
    );
    expect(exact.ok).toBe(true);
  });

  it('requires the submitted unquoted database identity, not a normalized alias', () => {
    const runtimeSchema = [{
      relation: '"Db"."Public"."Events"',
      catalogOrDatabase: 'Db', schema: 'Public', name: 'Events',
      source: 'warehouse_probe', columnCompleteness: 'complete' as const,
      executionTargetFingerprint: 'target:role-a', columns: [{ name: 'EventId', type: 'NUMBER' }],
    }];
    const result = validateSqlAgainstLocalContext(
      'SELECT EventId FROM DB.PUBLIC.EVENTS',
      undefined,
      { dialect: 'snowflake', runtimeSchema, runtimeSchemaExact: true, executionTargetFingerprint: 'target:role-a' },
    );
    expect(result).toMatchObject({ ok: false, code: 'unknown_relation' });
    if (!result.ok) expect(result.error).toContain('exact bound physical relation');
  });

  it('rejects request-local metadata observed under a different role target', () => {
    const result = validateSqlAgainstLocalContext(
      'SELECT order_id FROM analytics.fct_orders',
      pack(),
      {
        runtimeSchema: [{
          relation: 'analytics.fct_orders', name: 'fct_orders', source: 'warehouse_probe', columnCompleteness: 'complete',
          executionTargetFingerprint: 'target:role-a', columns: [{ name: 'order_id' }],
        }],
        runtimeSchemaExact: true,
        executionTargetFingerprint: 'target:role-b',
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'insufficient_context' });
    if (!result.ok) expect(result.error).toContain('different execution target');
  });
});

describe('the default database may be left out where a connection holds one database', () => {
  const table = (relation: string) => ({ relation, columns: [{ name: 'claim_id', type: 'BIGINT' }], source: 'warehouse probe', columnCompleteness: 'complete' as const });
  const validate = (sql: string, relations: string[], dialect: string) => validateSqlAgainstLocalContext(sql, undefined, { dialect, runtimeSchema: relations.map(table), runtimeSchemaExact: true, enforceGenerationReadiness: false });
  it('accepts main.claim for the inspected acme_insurance.main.claim on DuckDB', () => {
    expect(validate('SELECT claim_id FROM main.claim', ['acme_insurance.main.claim', 'acme_insurance.main.policy'], 'duckdb').ok).toBe(true);
    expect(validate('SELECT c.claim_id FROM main.claim c JOIN acme_insurance.main.policy p ON p.claim_id = c.claim_id', ['acme_insurance.main.claim', 'acme_insurance.main.policy'], 'duckdb').ok).toBe(true);
  });
  it('stays exact on an engine whose connection spans databases, when the tail is ambiguous, or when it names another database', () => {
    expect(validate('SELECT claim_id FROM main.claim', ['acme_insurance.main.claim'], 'snowflake').ok).toBe(false);
    expect(validate('SELECT claim_id FROM main.claim', ['acme_insurance.main.claim'], 'sqlite').ok).toBe(false);
    expect(validate('SELECT claim_id FROM main.claim', ['db_a.main.claim', 'db_b.main.claim'], 'duckdb').ok).toBe(false);
    expect(validate('SELECT claim_id FROM other_db.main.claim', ['acme_insurance.main.claim'], 'duckdb').ok).toBe(false);
  });
});

describe('the frozen-SQL check and the drafted-SQL check read inspected relations the same way', () => {
  const schema = (...relations: string[]) => relations.map((relation) => ({ relation }));
  it('accepts main.claim for an inspected acme_insurance.main.claim on DuckDB, quoted or not', () => {
    expect(inspectedRelationMatches('main.claim', schema('acme_insurance.main.claim', 'acme_insurance.main.policy'), 'duckdb')).toBe(true);
    expect(inspectedRelationMatches('main.claim', schema('"acme_insurance"."main"."claim"', '"acme_insurance"."main"."policy"'), 'duckdb')).toBe(true);
    expect(inspectedRelationMatches('"acme_insurance"."main"."claim"', schema('acme_insurance.main.claim'), 'duckdb')).toBe(true);
    // A file connection is DuckDB over a folder of data files: its tables match the same way.
    expect(inspectedRelationMatches('main.orders', schema('memory.main.orders'), 'file')).toBe(true);
    expect(inspectedRelationMatches('"memory"."main"."orders"', schema('memory.main.orders'), 'file')).toBe(true);
  });
  it('stays exact elsewhere: another engine, an ambiguous tail, another database, a table never inspected', () => {
    expect(inspectedRelationMatches('main.claim', schema('acme_insurance.main.claim'), 'snowflake')).toBe(false);
    expect(inspectedRelationMatches('main.claim', schema('db_a.main.claim', 'db_b.main.claim'), 'duckdb')).toBe(false);
    expect(inspectedRelationMatches('other_db.main.claim', schema('acme_insurance.main.claim'), 'duckdb')).toBe(false);
    expect(inspectedRelationMatches('main.expense_reserve', schema('acme_insurance.main.claim'), 'duckdb')).toBe(false);
    // A bare table name resolves through the search path, which need not be the inspected schema.
    expect(inspectedRelationMatches('claim', schema('acme_insurance.main.claim'), 'duckdb')).toBe(false);
  });
});
