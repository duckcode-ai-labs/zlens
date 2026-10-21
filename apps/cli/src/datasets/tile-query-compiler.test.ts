import { describe, expect, it } from 'vitest';
import type { DatasetAggregateComponentProofV1, DatasetDescriptor, TileQuery } from '@zlens/core';
import { DATASET_TILE_DIALECTS, TileQueryCompilationError, compileDatasetTileQuery } from './tile-query-compiler.js';

/**
 * Golden SQL for every dialect Dataset tiles accept. A change to any of these
 * strings changes what runs in a customer's warehouse: review the new SQL on
 * that dialect before updating the expectation, and widen
 * DATASET_TILE_DIALECTS only together with a new golden here.
 */
function orderLines(overrides: Partial<DatasetDescriptor> = {}): DatasetDescriptor {
  return {
    version: 1,
    id: 'app:block:commerce:order-lines',
    kind: 'block',
    sourceRevision: 'sha256:source',
    snapshotId: 'snapshot-1',
    contractRef: { kind: 'block_source', id: 'commerce::block::order_lines', fingerprint: 'sha256:contract' },
    binding: {
      sourceQualifiedId: 'commerce::block::order_lines',
      sourceRevision: 'sha256:source',
      contractFingerprint: 'sha256:contract',
      state: 'valid',
      activeSnapshotId: 'snapshot-1',
      activeTargetFingerprint: 'target-1',
    },
    label: 'Order lines',
    domain: 'commerce',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof.order-lines' },
    fields: [
      { kind: 'physical', name: 'order_line_id', qualifiedId: 'order_lines.order_line_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'ordered_at', qualifiedId: 'order_lines.ordered_at', type: 'timestamp', role: 'time', status: 'approved', time: { grains: ['day', 'week', 'month', 'quarter', 'year'], primary: true } },
      { kind: 'physical', name: 'order_date', qualifiedId: 'order_lines.order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'week', 'month'] } },
      { kind: 'physical', name: 'region', qualifiedId: 'order_lines.region', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'net_amount', qualifiedId: 'order_lines.net_amount', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'margin_amount', qualifiedId: 'order_lines.margin_amount', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'measure', name: 'revenue', qualifiedId: 'order_lines.m.revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      { kind: 'measure', name: 'orders', qualifiedId: 'order_lines.m.orders', aggregation: 'count_distinct', from: 'order_line_id', dependsOn: ['order_line_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
      { kind: 'measure', name: 'margin_rate', qualifiedId: 'order_lines.m.margin_rate', aggregation: 'ratio', numerator: 'margin_amount', denominator: 'net_amount', dependsOn: ['margin_amount', 'net_amount'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['ratio'], status: 'approved' },
    ],
    operations: ['filter', 'group', 'trend', 'rank', 'having', 'detail'],
    execution: { route: 'certified' },
    ...overrides,
  } as DatasetDescriptor;
}

const grouped: TileQuery = {
  dimensions: [{ field: 'region' }, { field: 'ordered_at', timeGrain: 'month' }],
  measures: [{ measure: 'revenue' }, { measure: 'margin_rate' }],
  filters: [
    { field: 'region', op: 'in', values: ['EU', 'US'] },
    { field: 'ordered_at', op: 'gte', values: ['2026-01-01T00:00:00Z'] },
    { field: 'order_date', op: 'lt', values: ['2026-07-01'] },
    { field: 'region', op: 'contains', values: ['50%_a!'] },
  ],
  having: [{ field: 'revenue', op: 'gt', values: [100] }],
  orderBy: [{ alias: 'revenue', direction: 'desc' }],
  limit: 10,
};

function compile(driver: string, query: TileQuery = grouped, descriptor = orderLines()) {
  return compileDatasetTileQuery({ descriptor, query, driver, sourceSql: 'SELECT * FROM order_lines;' });
}

const QUOTED_ANSI = [
  'WITH ds AS (SELECT * FROM order_lines)',
  `SELECT ds."region" AS "region", DATE_TRUNC('month', ds."ordered_at") AS "ordered_at_month", SUM(ds."net_amount") AS "revenue", ((1.0 * SUM(ds."margin_amount")) / NULLIF(SUM(ds."net_amount"), 0)) AS "margin_rate"`,
  'FROM ds',
  `WHERE ds."region" IN ($1, $2) AND ds."ordered_at" >= CAST($3 AS TIMESTAMP) AND ds."order_date" < CAST($4 AS DATE) AND ds."region" ILIKE $5 ESCAPE '!'`,
  `GROUP BY ds."region", DATE_TRUNC('month', ds."ordered_at")`,
  'HAVING SUM(ds."net_amount") > $6',
  'ORDER BY "revenue" DESC, "region" ASC, "ordered_at_month" ASC',
  'LIMIT 10',
].join('\n');

const GOLDEN: Record<string, string> = {
  duckdb: QUOTED_ANSI,
  file: QUOTED_ANSI,
  postgresql: QUOTED_ANSI,
  redshift: QUOTED_ANSI,
  // Snowflake folds unquoted identifiers to upper case: source columns stay
  // unquoted so `region` resolves to the block's REGION, while output aliases
  // stay quoted and keep the authored spelling.
  snowflake: [
    'WITH ds AS (SELECT * FROM order_lines)',
    `SELECT ds.region AS "region", DATE_TRUNC('month', ds.ordered_at) AS "ordered_at_month", SUM(ds.net_amount) AS "revenue", ((1.0 * SUM(ds.margin_amount)) / NULLIF(SUM(ds.net_amount), 0)) AS "margin_rate"`,
    'FROM ds',
    `WHERE ds.region IN ($1, $2) AND ds.ordered_at >= CAST($3 AS TIMESTAMP) AND ds.order_date < CAST($4 AS DATE) AND ds.region ILIKE $5 ESCAPE '!'`,
    `GROUP BY ds.region, DATE_TRUNC('month', ds.ordered_at)`,
    'HAVING SUM(ds.net_amount) > $6',
    'ORDER BY "revenue" DESC, "region" ASC, "ordered_at_month" ASC',
    'LIMIT 10',
  ].join('\n'),
  // BigQuery: TIMESTAMP_TRUNC for timestamps, backtick identifiers, and LIKE
  // with backslash escapes because it has no ESCAPE clause.
  bigquery: [
    'WITH ds AS (SELECT * FROM order_lines)',
    'SELECT ds.`region` AS `region`, TIMESTAMP_TRUNC(ds.`ordered_at`, MONTH) AS `ordered_at_month`, SUM(ds.`net_amount`) AS `revenue`, ((1.0 * SUM(ds.`margin_amount`)) / NULLIF(SUM(ds.`net_amount`), 0)) AS `margin_rate`',
    'FROM ds',
    'WHERE ds.`region` IN ($1, $2) AND ds.`ordered_at` >= CAST($3 AS TIMESTAMP) AND ds.`order_date` < CAST($4 AS DATE) AND LOWER(ds.`region`) LIKE LOWER($5)',
    'GROUP BY ds.`region`, TIMESTAMP_TRUNC(ds.`ordered_at`, MONTH)',
    'HAVING SUM(ds.`net_amount`) > $6',
    'ORDER BY `revenue` DESC, `region` ASC, `ordered_at_month` ASC',
    'LIMIT 10',
  ].join('\n'),
};

describe('dataset tile compiler golden SQL', () => {
  it('has a golden for every accepted dialect and no other', () => {
    expect(Object.keys(GOLDEN).sort()).toEqual([...DATASET_TILE_DIALECTS].sort());
  });

  for (const driver of Object.keys(GOLDEN)) {
    it(`${driver}: WHERE before aggregation, HAVING after, ranked order, bound values`, () => {
      const compiled = compile(driver);
      expect(compiled.sql).toBe(GOLDEN[driver]);
      expect(compiled.sqlParams.map((parameter) => parameter.position)).toEqual([1, 2, 3, 4, 5, 6]);
      const values = compiled.sqlParams.map((parameter) => compiled.variables[parameter.name]);
      expect(values).toEqual([
        'EU',
        'US',
        '2026-01-01T00:00:00Z',
        '2026-07-01',
        driver === 'bigquery' ? '%50\\%\\_a!%' : '%50!%!_a!!%',
        100,
      ]);
      expect(compiled.appliedFilters.map((filter) => filter.placement)).toEqual(['where', 'where', 'where', 'where', 'having']);
      expect(compiled.validation).toEqual({ outcome: 'covered', adaptations: [] });
    });
  }

  it('truncates every grain per dialect, with BigQuery weeks starting Monday', () => {
    const grains = ['day', 'week', 'month', 'quarter', 'year'] as const;
    const select = (driver: string, field: 'ordered_at' | 'order_date', grain: string) => compile(driver, {
      dimensions: [{ field, timeGrain: grain }],
      measures: [{ measure: 'revenue' }],
    }).sql.split('\n')[1];
    for (const grain of grains) {
      expect(select('duckdb', 'ordered_at', grain)).toBe(`SELECT DATE_TRUNC('${grain}', ds."ordered_at") AS "ordered_at_${grain}", SUM(ds."net_amount") AS "revenue"`);
      expect(select('snowflake', 'ordered_at', grain)).toBe(`SELECT DATE_TRUNC('${grain}', ds.ordered_at) AS "ordered_at_${grain}", SUM(ds.net_amount) AS "revenue"`);
      const part = grain === 'week' ? 'WEEK(MONDAY)' : grain.toUpperCase();
      expect(select('bigquery', 'ordered_at', grain)).toBe(`SELECT TIMESTAMP_TRUNC(ds.\`ordered_at\`, ${part}) AS \`ordered_at_${grain}\`, SUM(ds.\`net_amount\`) AS \`revenue\``);
    }
    expect(select('bigquery', 'order_date', 'week')).toBe('SELECT DATE_TRUNC(ds.`order_date`, WEEK(MONDAY)) AS `order_date_week`, SUM(ds.`net_amount`) AS `revenue`');
  });

  it('bounds detail rows by the declared key and an explicit limit', () => {
    const detail: TileQuery = { dimensions: [], measures: [], detail: true, detailColumns: ['order_line_id', 'region', 'net_amount'], limit: 50, filters: [{ field: 'region', op: 'eq', values: ['EU'] }] };
    expect(compile('duckdb', detail).sql).toBe([
      'WITH ds AS (SELECT * FROM order_lines)',
      'SELECT ds."order_line_id" AS "order_line_id", ds."region" AS "region", ds."net_amount" AS "net_amount"',
      'FROM ds',
      'WHERE ds."region" = $1',
      'ORDER BY ds."order_line_id" ASC',
      'LIMIT 50',
    ].join('\n'));
    expect(() => compile('duckdb', { ...detail, limit: undefined })).toThrow(TileQueryCompilationError);
  });

  it('resolves a parameter limit and refuses one outside 1..10,000', () => {
    const query: TileQuery = { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], orderBy: [{ alias: 'revenue', direction: 'desc' }], limit: { param: 'top_n' } };
    const compiled = compileDatasetTileQuery({ descriptor: orderLines(), query, driver: 'duckdb', sourceSql: 'SELECT * FROM order_lines', parameters: { top_n: 5 } });
    expect(compiled.sql.endsWith('\nLIMIT 5')).toBe(true);
    expect(() => compileDatasetTileQuery({ descriptor: orderLines(), query, driver: 'duckdb', sourceSql: 'SELECT * FROM order_lines', parameters: { top_n: 50_000 } }))
      .toThrowError(expect.objectContaining({ code: 'DATASET_LIMIT_INVALID' }));
  });

  it('refuses dialects without a golden instead of running unchecked SQL', () => {
    for (const driver of ['mysql', 'mssql', 'fabric', 'sqlite', 'clickhouse', 'databricks', 'trino', 'athena']) {
      expect(() => compile(driver)).toThrowError(expect.objectContaining({ code: 'DATASET_DIALECT_UNSUPPORTED' }));
    }
  });

  it('never renders an unknown time grain', () => {
    const injected: TileQuery = { dimensions: [{ field: 'ordered_at', timeGrain: "month', x) --" }], measures: [{ measure: 'revenue' }] };
    expect(() => compile('duckdb', injected)).toThrowError(expect.objectContaining({ code: 'DATASET_QUERY_REJECTED' }));
  });

  it('fingerprints the applied filters with sha256 and changes when a value changes', () => {
    const first = compile('duckdb').filterFingerprint;
    const second = compile('duckdb', { ...grouped, filters: [{ field: 'region', op: 'eq', values: ['APAC'] }] }).filterFingerprint;
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });
});

describe('aggregate Dataset rollups', () => {
  const daily = orderLines({
    grain: { entityIds: ['region_day'], keyFields: ['region', 'order_date'], keyEvidence: 'proof.region-day', timeGrain: 'day', timeBucketBy: 'order_date', aggregate: true },
    operations: ['filter', 'group', 'trend'],
  });
  const monthly: TileQuery = { dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'region' }], measures: [{ measure: 'revenue' }] };
  const proof = (binding: Partial<DatasetAggregateComponentProofV1['binding']> = {}): DatasetAggregateComponentProofV1 => ({
    version: 1,
    status: 'passed',
    binding: {
      sourceId: 'app:block:commerce:order-lines',
      sourceRevision: 'sha256:source',
      contractFingerprint: 'sha256:contract',
      sourceSqlFingerprint: 'sha256:sql',
      parameterFingerprint: 'sha256:params',
      targetFingerprint: 'target-1',
      snapshotId: 'snapshot-1',
      snapshotFingerprint: 'sha256:snapshot',
      groupingFingerprint: 'sha256:grouping',
      timeBucketFingerprint: 'sha256:bucket',
      timeGrain: 'day',
      ...binding,
    },
    components: [{ alias: 'net_amount', targetOperation: 'sum', sourceAggregate: 'sum', sourceExpressionFingerprint: 'sha256:expr' }],
    evidence: { checkedAt: '2026-09-17T00:00:00.000Z', probeFingerprint: 'sha256:probe', method: 'direct_sum_mapping', checkedDistinctComponents: [] },
    fingerprint: 'sha256:proof',
  });
  const run = (aggregateComponentProof?: DatasetAggregateComponentProofV1) => compileDatasetTileQuery({
    descriptor: daily,
    query: monthly,
    driver: 'duckdb',
    sourceSql: 'SELECT * FROM region_daily',
    aggregateComponentProof,
    aggregateComponentBinding: { sourceId: 'app:block:commerce:order-lines', sourceRevision: 'sha256:source', targetFingerprint: 'target-1' },
  });

  it('runs a proven monthly rollup of a daily aggregate and reports it as adapted', () => {
    const compiled = run(proof());
    expect(compiled.validation.outcome).toBe('adapted');
    expect(compiled.validation.adaptations.map((adaptation) => adaptation.kind)).toEqual(['aggregate_time_rollup']);
    expect(compiled.sql).toContain(`DATE_TRUNC('month', ds."order_date")`);
  });

  it('refuses a rollup without a proof, or with a proof made for another binding', () => {
    expect(() => run(undefined)).toThrowError(expect.objectContaining({ code: 'DATASET_AGGREGATE_COMPONENT_EVIDENCE_REQUIRED' }));
    for (const stale of [
      { sourceRevision: 'sha256:older' },
      { targetFingerprint: 'target-2' },
      { contractFingerprint: 'sha256:other-contract' },
      { timeGrain: 'hour' },
      { sourceId: 'app:block:commerce:other' },
    ]) {
      expect(() => run(proof(stale))).toThrowError(expect.objectContaining({ code: 'DATASET_AGGREGATE_COMPONENT_EVIDENCE_REQUIRED' }));
    }
  });
});

describe('tile calculations (RFC 0009 step 3)', () => {
  const byMonth: TileQuery = {
    dimensions: [{ field: 'region' }, { field: 'ordered_at', timeGrain: 'month' }],
    measures: [{ measure: 'revenue' }],
    calculations: [
      { id: 'per_order', expr: { op: '/', left: { measure: 'revenue' }, right: { measure: 'orders' } } },
      { id: 'us_revenue', expr: { measure: 'revenue', where: [{ field: 'region', op: 'eq', values: ['US'] }] } },
      { id: 'share', quick: { kind: 'percent_of_total', of: 'revenue' } },
      { id: 'running', quick: { kind: 'running_total', of: 'revenue' } },
      { id: 'yoy', quick: { kind: 'year_over_year', of: 'revenue' } },
    ],
    orderBy: [{ alias: 'share', direction: 'desc' }],
    limit: 5,
  };

  it('compiles calculated measures into the grouping and quick calculations into windows over it', () => {
    const compiled = compile('duckdb', byMonth);
    expect(compiled.sql).toBe([
      'WITH ds AS (SELECT * FROM order_lines),',
      `__base AS (SELECT ds."region" AS "region", DATE_TRUNC('month', ds."ordered_at") AS "ordered_at_month", SUM(ds."net_amount") AS "revenue", ((1.0 * SUM(ds."net_amount")) / NULLIF(COUNT(DISTINCT ds."order_line_id"), 0)) AS "per_order", SUM(CASE WHEN ds."region" = $1 THEN ds."net_amount" END) AS "us_revenue"`,
      'FROM ds',
      `GROUP BY ds."region", DATE_TRUNC('month', ds."ordered_at")`,
      ')',
      'SELECT b."region" AS "region", b."ordered_at_month" AS "ordered_at_month", b."revenue" AS "revenue", b."per_order" AS "per_order", b."us_revenue" AS "us_revenue", '
        + '((1.0 * b."revenue") / NULLIF(SUM(b."revenue") OVER (), 0)) AS "share", '
        + 'SUM(b."revenue") OVER (PARTITION BY b."region" ORDER BY b."ordered_at_month" ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "running", '
        + '((1.0 * (b."revenue" - __yoy_3."revenue")) / NULLIF(ABS(__yoy_3."revenue"), 0)) AS "yoy"',
      'FROM __base b',
      'LEFT JOIN __base __yoy_3 ON EXTRACT(YEAR FROM __yoy_3."ordered_at_month") = EXTRACT(YEAR FROM b."ordered_at_month") - 1 AND EXTRACT(MONTH FROM __yoy_3."ordered_at_month") = EXTRACT(MONTH FROM b."ordered_at_month") AND (__yoy_3."region" = b."region" OR (__yoy_3."region" IS NULL AND b."region" IS NULL))',
      'ORDER BY "share" DESC, "region" ASC, "ordered_at_month" ASC',
      'LIMIT 5',
    ].join('\n'));
    expect(compiled.variables).toMatchObject({ __dataset_tile_region_1: 'US' });
    expect(compiled.columns.slice(3).map((column) => [column.alias, column.format?.kind, column.calculation?.description])).toEqual([
      ['per_order', 'number', 'revenue / orders'],
      ['us_revenue', 'number', "revenue where region = 'US'"],
      ['share', 'percent', 'Percent of total of revenue'],
      ['running', 'number', 'Running total of revenue along ordered_at_month'],
      ['yoy', 'percent', 'Year over year change of revenue along ordered_at_month'],
    ]);
  });

  it('keeps one SELECT when there are only calculated measures', () => {
    const compiled = compile('duckdb', { dimensions: [{ field: 'region' }], measures: [], calculations: [{ id: 'rate', expr: { op: '/', left: { measure: 'revenue' }, right: { measure: 'margin_rate' } } }] });
    expect(compiled.sql).toBe([
      'WITH ds AS (SELECT * FROM order_lines)',
      'SELECT ds."region" AS "region", ((1.0 * SUM(ds."net_amount")) / NULLIF(((1.0 * SUM(ds."margin_amount")) / NULLIF(SUM(ds."net_amount"), 0)), 0)) AS "rate"',
      'FROM ds',
      'GROUP BY ds."region"',
    ].join('\n'));
  });

  it('draws the same windows in every supported dialect', () => {
    const query: TileQuery = { dimensions: [{ field: 'ordered_at', timeGrain: 'month' }], measures: [{ measure: 'revenue' }], calculations: [{ id: 'avg3', quick: { kind: 'moving_average', of: 'revenue' } }, { id: 'pos', quick: { kind: 'rank', of: 'revenue' } }] };
    expect(compile('snowflake', query).sql).toContain('AVG(b."revenue") OVER (ORDER BY b."ordered_at_month" ASC ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS "avg3", RANK() OVER (ORDER BY b."revenue" DESC NULLS LAST) AS "pos"');
    expect(compile('bigquery', query).sql).toContain('AVG(b.`revenue`) OVER (ORDER BY b.`ordered_at_month` ASC ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS `avg3`');
  });

  it('refuses a calculation the checker refuses, with its rule', () => {
    expect(() => compile('duckdb', { ...grouped, having: undefined, filters: undefined, calculations: [{ id: 'share', quick: { kind: 'percent_of_total', of: 'margin_rate' } }] }))
      .toThrowError(expect.objectContaining({ code: 'DATASET_QUERY_REJECTED', message: expect.stringContaining('margin_rate is a ratio or average') }));
  });

  it('fingerprints the calculations with the query', () => {
    expect(compile('duckdb', byMonth).queryFingerprint).not.toBe(compile('duckdb', { ...byMonth, orderBy: undefined, calculations: byMonth.calculations!.slice(0, 1) }).queryFingerprint);
  });
});

describe('pivot totals (RFC 0009 step 4)', () => {
  it('asks the warehouse for each total level with GROUPING SETS and flags totalled dimensions', () => {
    const compiled = compile('duckdb', { dimensions: [{ field: 'region' }, { field: 'ordered_at', timeGrain: 'month' }], measures: [{ measure: 'orders' }], rollups: [['region'], []] });
    expect(compiled.sql).toBe([
      'WITH ds AS (SELECT * FROM order_lines)',
      `SELECT ds."region" AS "region", DATE_TRUNC('month', ds."ordered_at") AS "ordered_at_month", COUNT(DISTINCT ds."order_line_id") AS "orders", GROUPING(ds."region") AS "__total_region", GROUPING(DATE_TRUNC('month', ds."ordered_at")) AS "__total_ordered_at_month"`,
      'FROM ds',
      `GROUP BY GROUPING SETS ((ds."region", DATE_TRUNC('month', ds."ordered_at")), (ds."region"), ())`,
    ].join('\n'));
    expect(compile('bigquery', { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], rollups: [[]] }).sql)
      .toContain('GROUP BY GROUPING SETS ((ds.`region`), ())');
  });

  it('refuses totals with a row limit', () => {
    expect(() => compile('duckdb', { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], rollups: [[]], limit: 5 }))
      .toThrowError(expect.objectContaining({ message: expect.stringContaining('remove the row limit') }));
  });
});

describe('fields from related tables (design D2)', () => {
  const joined = (): DatasetDescriptor => {
    const base = orderLines();
    return {
      ...base,
      fields: [
        ...base.fields,
        { kind: 'physical', name: 'customer_id', qualifiedId: 'order_lines.customer_id', type: 'string', role: 'dimension', status: 'approved' },
        { kind: 'physical', name: 'customer__customer_name', qualifiedId: 'related::customer::customer_name', type: 'string', role: 'dimension', status: 'approved', related: { join: 'customer', column: 'customer_name' } },
        { kind: 'physical', name: 'customer__region__region_name', qualifiedId: 'related::customer__region::region_name', type: 'string', role: 'dimension', status: 'approved', related: { join: 'customer__region', column: 'region_name' } },
      ],
      joins: [
        { id: 'customer', label: 'Customer', table: 'customers', relation: '"main"."customers"', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', trust: 'certified', origin: 'model', relationshipId: 'shop::relationship::orders_customers', uniqueness: 'current', sentence: 'each order line has one customer' },
        { id: 'customer__region', parent: 'customer', label: 'Region', table: 'regions', relation: '"main"."regions"', keys: [{ from: 'region_id', to: 'id' }], cardinality: 'many_to_one', trust: 'review_required', origin: 'drafted', relationshipId: 'p1:op', uniqueness: 'recheck', sentence: 'each customer has one region' },
      ],
    } as DatasetDescriptor;
  };

  it('compiles a tile on its own fields exactly as before', () => {
    expect(compile('duckdb', grouped, joined()).sql).toBe(QUOTED_ANSI);
    expect(compile('duckdb', grouped, joined()).joins).toEqual([]);
  });

  it('LEFT JOINs the related table on the relationship keys and selects only the related fields used', () => {
    const compiled = compile('duckdb', { dimensions: [{ field: 'customer__customer_name' }], measures: [{ measure: 'revenue' }] }, joined());
    expect(compiled.sql).toBe([
      'WITH ds AS (SELECT __dql_base.*, __dql_j_customer."customer_name" AS "customer__customer_name"',
      'FROM (SELECT * FROM order_lines) AS __dql_base',
      'LEFT JOIN "main"."customers" AS __dql_j_customer ON __dql_base."customer_id" = __dql_j_customer."customer_id")',
      'SELECT ds."customer__customer_name" AS "customer__customer_name", SUM(ds."net_amount") AS "revenue"',
      'FROM ds',
      'GROUP BY ds."customer__customer_name"',
    ].join('\n'));
    expect(compiled.joins.map((join) => join.id)).toEqual(['customer']);
  });

  it('follows a second hop through its parent, and a page filter on a related field adds the join', () => {
    const compiled = compileDatasetTileQuery({
      descriptor: joined(),
      query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] },
      filters: [{ field: 'customer__region__region_name', op: 'in', values: ['West'] }],
      driver: 'duckdb',
      sourceSql: 'SELECT * FROM order_lines',
    });
    expect(compiled.sql).toContain('LEFT JOIN "main"."customers" AS __dql_j_customer ON __dql_base."customer_id" = __dql_j_customer."customer_id"\nLEFT JOIN "main"."regions" AS __dql_j_customer__region ON __dql_j_customer."region_id" = __dql_j_customer__region."id"');
    expect(compiled.sql).toContain('__dql_j_customer__region."region_name" AS "customer__region__region_name"');
    expect(compiled.sql).toContain('WHERE ds."customer__region__region_name" IN ($1)');
    expect(compiled.joins.map((join) => join.id)).toEqual(['customer', 'customer__region']);
  });

  it('keeps Snowflake references unquoted so upper-cased names resolve, and detail rows default to own columns', () => {
    const snowflake = compile('snowflake', { dimensions: [{ field: 'customer__customer_name' }], measures: [{ measure: 'revenue' }] }, joined());
    expect(snowflake.sql).toContain('__dql_j_customer.customer_name AS customer__customer_name');
    expect(snowflake.sql).toContain('ON __dql_base.customer_id = __dql_j_customer.customer_id');
    const detail = compile('duckdb', { dimensions: [], measures: [], detail: true, limit: 5 }, joined());
    expect(detail.joins).toEqual([]);
    expect(detail.sql).not.toContain('customer__customer_name');
  });

  it('refuses a join whose relation is not a plain table name', () => {
    const descriptor = joined();
    descriptor.joins![0] = { ...descriptor.joins![0]!, relation: 'customers; DROP TABLE x' };
    expect(() => compile('duckdb', { dimensions: [{ field: 'customer__customer_name' }], measures: [{ measure: 'revenue' }] }, descriptor))
      .toThrowError(expect.objectContaining({ code: 'DATASET_JOIN_INVALID' }));
  });
});
