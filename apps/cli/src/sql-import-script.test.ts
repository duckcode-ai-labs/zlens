import { describe, expect, it } from 'vitest';
import {
  foldSqlScript,
  humanizeObjectName,
  splitAtStatementStarts,
  sqlLogicFingerprint,
  statementStartOffsets,
  unwrapStoredProcedures,
} from './sql-import-script.js';

describe('splitting statements that have no semicolons', () => {
  it('splits a T-SQL batch at DECLARE, SET and SELECT lines', () => {
    const parts = splitAtStatementStarts(`DECLARE @since date = '2024-01-01'
SET @since = '2024-02-01'
SELECT COUNT(*) AS orders FROM dev.orders WHERE ordered_at >= @since`);
    expect(parts).toHaveLength(3);
    expect(parts[2]).toMatch(/^SELECT COUNT/);
  });

  it('splits queries a blank line apart and keeps each comment with the query under it', () => {
    const parts = splitAtStatementStarts(`-- Store opening dates
select location_name, opened_date from dev.locations order by opened_date

-- Top 10 customers by spend
select customer_name, lifetime_spend from dev.customers order by lifetime_spend desc limit 10`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^-- Store opening dates\nselect/);
    expect(parts[1]).toMatch(/^-- Top 10 customers by spend\nselect/);
  });

  it('keeps one statement together across UNION, a WITH list, table hints, UPDATE … SET, INSERT … SELECT and CASE … END', () => {
    for (const sql of [
      'select a from x\n\nunion all\n\nselect a from y',
      'with a as (\n  select 1 as n\n)\n\nselect * from a',
      'select * from dev.orders\nwith (nolock)',
      'update t\nset a = 1\nwhere b = 2',
      'insert into t (a)\nselect a from s',
      'create temp table t as\nselect 1 as a',
      'select case\n  when a > 1 then 1\n  else 0\nend as flag\nfrom t',
      'select a from t\ngroup by a\nwith rollup',
      'merge into t using s on t.id = s.id\nwhen matched then\n  update set a = s.a\nwhen not matched then\n  insert (a) values (s.a)',
    ]) {
      expect(splitAtStatementStarts(sql), sql).toHaveLength(1);
    }
  });

  it('counts a restart in the middle of a line only when asked, for the warning', () => {
    const sql = 'select * from raw.events select * from raw.accounts';
    expect(statementStartOffsets(sql)).toEqual([]);
    expect(statementStartOffsets(sql, { lineStartOnly: false })).toHaveLength(1);
    expect(statementStartOffsets('with a as (select 1) select * from a', { lineStartOnly: false })).toEqual([]);
  });

  it('ignores keywords inside strings and comments', () => {
    expect(splitAtStatementStarts("select 'a\nselect b' as label\n-- select c\nfrom t")).toHaveLength(1);
  });
});

describe('stored procedures', () => {
  it('turns a procedure into its body, with its parameters as DECLARE lines and its name as a header', () => {
    const out = unwrapStoredProcedures(`CREATE PROCEDURE dbo.usp_store_revenue
  @StartDate date = '2024-01-01',
  @Region varchar(20)
AS
BEGIN
  SET NOCOUNT ON;
  SELECT location_id, SUM(order_total) AS revenue FROM dev.orders WHERE ordered_at >= @StartDate GROUP BY location_id;
END
GO
select 1 as after_the_procedure`);
    expect(out).toContain('-- name: Store revenue');
    expect(out).toContain("DECLARE @StartDate date = '2024-01-01';");
    expect(out).toContain('DECLARE @Region varchar(20);');
    expect(out).not.toMatch(/CREATE PROCEDURE|BEGIN|\bEND\b/);
    expect(out).toContain('GO\nselect 1 as after_the_procedure');
  });

  it('names objects the way people read them', () => {
    expect(humanizeObjectName('[dbo].[usp_StoreRevenue]')).toBe('Store revenue');
    expect(humanizeObjectName('reporting.vw_monthly_sales')).toBe('Monthly sales');
  });
});

describe('folding a script into the queries it holds', () => {
  it('turns a temp table into a WITH clause and moves the name header to the query', () => {
    const folded = foldSqlScript([
      '-- name: Big customer orders\ncreate temp table big_customers as\nselect customer_id from dev.customers where lifetime_spend > 500',
      'select o.ordered_at::date as order_date, count(*) as orders\nfrom dev.orders o\njoin big_customers b on b.customer_id = o.customer_id\ngroup by 1\norder by 1',
    ]);
    expect(folded.skipped).toEqual([]);
    expect(folded.queries).toHaveLength(1);
    const query = folded.queries[0];
    expect(query.sql).toMatch(/^-- name: Big customer orders\nWITH big_customers AS \(\nselect customer_id from dev\.customers where lifetime_spend > 500\n\)\nselect o\.ordered_at::date/);
    expect(query.notes.join(' ')).toMatch(/big_customers became a WITH clause/);
  });

  it('turns SELECT … INTO #t and CREATE TABLE #t + INSERT … SELECT into WITH clauses', () => {
    const folded = foldSqlScript([
      'SELECT customer_id, lifetime_spend INTO #spend FROM dev.customers',
      'CREATE TABLE #types (customer_type varchar(20), n int)',
      "INSERT INTO #types SELECT customer_type, COUNT(*) FROM dev.customers WHERE customer_type = 'new' GROUP BY 1",
      "INSERT INTO #types SELECT customer_type, COUNT(*) FROM dev.customers WHERE customer_type = 'returning' GROUP BY 1",
      'SELECT t.customer_type, t.n, MAX(s.lifetime_spend) AS top_spend FROM #types t JOIN #spend s ON 1 = 1 GROUP BY 1, 2',
      'DROP TABLE #spend',
      'DROP TABLE #types',
    ]);
    expect(folded.skipped).toEqual([]);
    expect(folded.queries).toHaveLength(1);
    const sql = folded.queries[0].sql;
    expect(sql).toContain('spend AS (\nSELECT customer_id, lifetime_spend\nFROM dev.customers\n)');
    expect(sql).toContain('types (customer_type, n) AS (');
    expect(sql).toContain('\nUNION ALL\n');
    expect(sql).toContain('FROM types t JOIN spend s');
    expect(sql).not.toContain('#');
  });

  it('makes DECLARE values parameter defaults and writes expressions into the query', () => {
    const folded = foldSqlScript([
      "DECLARE @since date = '2024-01-01'",
      'DECLARE @cutoff datetime = DATEADD(month, -3, GETDATE())',
      'SELECT COUNT(*) AS orders FROM dev.orders WHERE ordered_at >= @since AND ordered_at < @cutoff',
    ]);
    const query = folded.queries[0];
    expect(query.sql).toBe('SELECT COUNT(*) AS orders FROM dev.orders WHERE ordered_at >= ${since} AND ordered_at < (DATEADD(month, -3, GETDATE()))');
    expect(query.parameters).toEqual([{ name: 'since', written: '@since', valueType: 'date', default: '2024-01-01' }]);
    expect(query.notes.join(' ')).toMatch(/@cutoff is set to DATEADD/);
  });

  it('turns report parameters written the tool\'s way into saved query parameters', () => {
    const folded = foldSqlScript([
      `select l.location_name, sum(o.order_total) as revenue
from dev.orders o
join dev.locations l on l.location_id = o.location_id
where o.ordered_at >= <Parameters.Start Date>
  and o.ordered_at < :end_date
  and l.location_name = {{ store }}
  and o.customer_id <> @ExcludedCustomer
  and o.ordered_at::date is not null
group by 1`,
    ]);
    const query = folded.queries[0];
    expect(query.sql).toContain('o.ordered_at >= ${start_date}');
    expect(query.sql).toContain('o.ordered_at < ${end_date}');
    expect(query.sql).toContain('l.location_name = ${store}');
    expect(query.sql).toContain('o.customer_id <> ${excluded_customer}');
    expect(query.sql).toContain('o.ordered_at::date is not null');
    expect(query.parameters.map((parameter) => [parameter.name, parameter.valueType, parameter.default])).toEqual([
      ['start_date', 'date', undefined],
      ['store', 'string', undefined],
      ['excluded_customer', 'string', undefined],
      ['end_date', 'date', undefined],
    ]);
    expect(query.notes.join(' ')).toMatch(/Give it a default value/);
  });

  it('leaves out statements that change data and says why, and drops temp cleanup and session settings quietly', () => {
    const folded = foldSqlScript([
      'SET NOCOUNT ON',
      "select date_trunc('week', ordered_at) as week, count(*) as orders from dev.orders group by 1",
      '-- cleanup step from the old nightly job\ndrop table dev.zz_import_probe',
      "delete from dev.orders where ordered_at < '2020-01-01'",
      'EXEC dbo.usp_refresh_marts',
      'create table marts.order_snapshot as select * from dev.orders',
      'DROP TABLE IF EXISTS #scratch',
    ]);
    expect(folded.queries).toHaveLength(1);
    expect(folded.skipped.map((item) => [item.kind, item.reason])).toEqual([
      ['writes', 'Changes data (DROP). ZLens imports only queries that read.'],
      ['writes', 'Changes data (DELETE). ZLens imports only queries that read.'],
      ['runs-procedure', "Runs a procedure (EXEC dbo.usp_refresh_marts). ZLens imports the queries themselves; import the procedure's SQL instead."],
      ['writes', 'Creates table marts.order_snapshot. ZLens imports queries that read; if this is a report, import its SELECT.'],
    ]);
  });

  it('imports what a view selects when nothing else in the file reads the view', () => {
    const folded = foldSqlScript(['create or replace view reporting.vw_monthly_sales as\nselect date_trunc(\'month\', ordered_at) as month, sum(order_total) as revenue from dev.orders group by 1']);
    expect(folded.queries).toHaveLength(1);
    expect(folded.queries[0].sql).toMatch(/^-- name: Monthly sales\nselect date_trunc/);
    expect(folded.queries[0].notes).toContain('Taken from view reporting.vw_monthly_sales.');
  });

  it('does not fold a temp table the script changes after creating it, and says why', () => {
    const folded = foldSqlScript([
      'select customer_id, lifetime_spend into #spend from dev.customers',
      'update #spend set lifetime_spend = 0 where lifetime_spend < 0',
      'select count(*) as customers from #spend',
    ]);
    expect(folded.queries[0].sql).toBe('select count(*) as customers from #spend');
    expect(folded.queries[0].notes.join(' ')).toMatch(/reads #spend, but the script changes #spend after creating it \(UPDATE\)/);
  });

  it('reads SELECT @x = … as setting a variable, and Snowflake SET variables as parameters', () => {
    const tsql = foldSqlScript([
      'DECLARE @total money',
      'SELECT @total = SUM(order_total) FROM dev.orders',
      'SELECT location_id, SUM(order_total) / @total AS share FROM dev.orders GROUP BY location_id',
    ]);
    expect(tsql.queries).toHaveLength(1);
    expect(tsql.queries[0].sql).toBe('SELECT location_id, SUM(order_total) / (SELECT SUM(order_total) FROM dev.orders) AS share FROM dev.orders GROUP BY location_id');

    const snowflake = foldSqlScript([
      "set start_date = '2024-01-01'",
      'select count(*) as orders from dev.orders where ordered_at >= $start_date',
    ]);
    expect(snowflake.queries[0].sql).toBe('select count(*) as orders from dev.orders where ordered_at >= ${start_date}');
    expect(snowflake.queries[0].parameters[0]).toMatchObject({ name: 'start_date', default: '2024-01-01', valueType: 'date' });
  });
});

describe('the same query twice', () => {
  it('has one fingerprint whatever its formatting, case or comments; a different string value is a different query', () => {
    const a = "-- name: Monthly revenue\nselect date_trunc('month', ordered_at) as order_month,\n       sum(order_total) as revenue\nfrom dev.orders\ngroup by 1\norder by 1";
    const b = "SELECT DATE_TRUNC('month', ordered_at) AS order_month,\n       SUM(order_total)                AS revenue\nFROM dev.orders\nGROUP BY 1\nORDER BY 1;";
    expect(sqlLogicFingerprint(a)).toBe(sqlLogicFingerprint(b));
    expect(sqlLogicFingerprint(b.replace("'month'", "'MONTH'"))).not.toBe(sqlLogicFingerprint(b));
  });
});
