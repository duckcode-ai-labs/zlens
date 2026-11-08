import { describe, expect, it } from 'vitest';
import { describeDialectForPrompt, getDialect, listDialectDrivers, orderDirectionSql, sortsNullsFirstDescending, withNullsLastWhenDescending } from './sql-dialect.js';

describe('describeDialectForPrompt (W1.5)', () => {
  it('describes DuckDB conventions (LIMIT at end, ILIKE, double-quote)', () => {
    const text = describeDialectForPrompt('duckdb');
    expect(text).toContain('duckdb');
    expect(text).toContain('LIMIT 100');
    expect(text).toContain('ILIKE');
  });

  it('describes SQL Server conventions (bracket quoting, OFFSET/FETCH, GETDATE)', () => {
    const text = describeDialectForPrompt('mssql');
    expect(text).toContain('[identifier]');
    expect(text).toContain('FETCH NEXT 100 ROWS ONLY');
    expect(text).toContain('GETDATE()');
    // SQL Server has no ILIKE.
    expect(text).not.toContain('ILIKE');
  });

  it('describes BigQuery conventions (backtick quoting, reversed DATE_TRUNC, LOWER LIKE)', () => {
    const text = describeDialectForPrompt('bigquery');
    expect(text).toContain('`identifier`');
    expect(text).toContain('DATE_TRUNC(ts_column, MONTH)');
    expect(text).toContain('LOWER(col) LIKE LOWER');
  });

  it('falls back to the DuckDB dialect for an unknown/blank driver', () => {
    expect(describeDialectForPrompt('')).toContain('duckdb');
    expect(describeDialectForPrompt('nonsense')).toContain('nonsense');
  });
});

describe('quoted names keep their closing quote on every engine', () => {
  it('escapes a backslash where the engine reads backslash escapes in quoted names (BigQuery, ClickHouse)', () => {
    expect(getDialect('bigquery').quoteIdentifier('a\\')).toBe('`a\\\\`');
    expect(getDialect('bigquery').quoteIdentifier('a`b')).toBe('`a\\`b`');
    expect(getDialect('clickhouse').quoteIdentifier('a\\')).toBe('"a\\\\"');
    expect(getDialect('clickhouse').quoteIdentifier('a"b')).toBe('"a""b"');
    // Engines whose quoted names take no backslash escapes double the quote only.
    expect(getDialect('postgresql').quoteIdentifier('a\\"b')).toBe('"a\\""b"');
    expect(getDialect('mysql').quoteIdentifier('a`b')).toBe('`a``b`');
  });

  it('writes text so it cannot end its string, on every database', () => {
    for (const driver of listDialectDrivers()) {
      const literal = getDialect(driver).quoteString("a\\' b");
      // Strip each database's escapes: nothing inside may still be a quote that closes the string.
      const inside = literal.slice(1, -1).replace(/\\\\/g, '').replace(/''/g, '').replace(/\\u0027/g, '');
      expect(inside, driver).not.toContain("'");
    }
  });
});

describe('NULLs in a descending order (Snowflake, live 2026-11-07)', () => {
  it('PostgreSQL, Redshift and Snowflake put NULL first in DESC; the others put it last', () => {
    expect(['snowflake', 'postgresql', 'redshift', 'Snowflake '].map(sortsNullsFirstDescending)).toEqual([true, true, true, true]);
    expect(['duckdb', 'file', 'bigquery', 'databricks', 'mysql', 'mssql', 'sqlite', 'clickhouse', 'trino', undefined].map((driver) => sortsNullsFirstDescending(driver))).toEqual(Array(10).fill(false));
    expect(orderDirectionSql('desc', 'snowflake')).toBe('DESC NULLS LAST');
    expect(orderDirectionSql('asc', 'snowflake')).toBe('ASC');
    expect(orderDirectionSql('desc', 'duckdb')).toBe('DESC');
  });

  it('adds NULLS LAST to every DESC that leaves NULLs\' place to the database', () => {
    const sql = 'SELECT PLAYER_NAME, SUM(POINTS) AS total FROM facts WHERE SEASON = 2017 GROUP BY 1 ORDER BY total desc LIMIT 1';
    expect(withNullsLastWhenDescending(sql, 'snowflake')).toBe('SELECT PLAYER_NAME, SUM(POINTS) AS total FROM facts WHERE SEASON = 2017 GROUP BY 1 ORDER BY total desc NULLS LAST LIMIT 1');
    expect(withNullsLastWhenDescending('SELECT * FROM t QUALIFY RANK() OVER (PARTITION BY s ORDER BY p DESC) = 1', 'snowflake'))
      .toBe('SELECT * FROM t QUALIFY RANK() OVER (PARTITION BY s ORDER BY p DESC NULLS LAST) = 1');
    expect(withNullsLastWhenDescending('SELECT a FROM t ORDER BY a DESC, b ASC, c DESC\nLIMIT 5', 'postgresql')).toBe('SELECT a FROM t ORDER BY a DESC NULLS LAST, b ASC, c DESC NULLS LAST\nLIMIT 5');
  });

  it('leaves strings, quoted names, comments, an explicit NULLS and WITHIN GROUP orders as written', () => {
    const kept = [
      "SELECT a FROM t ORDER BY a DESC NULLS FIRST",
      "SELECT a FROM t ORDER BY a DESC /* biggest */ NULLS FIRST",
      "SELECT 'ORDER BY x DESC' AS note, \"DESC\" FROM t",
      "SELECT a FROM t -- ORDER BY a DESC\n",
      "SELECT LISTAGG(n, ',') WITHIN GROUP (ORDER BY n DESC) FROM t",
      "SELECT $$ order by a desc $$ AS body",
    ];
    for (const sql of kept) expect(withNullsLastWhenDescending(sql, 'snowflake')).toBe(sql);
    expect(withNullsLastWhenDescending("SELECT 'it\\'s' AS s FROM t ORDER BY s DESC", 'snowflake')).toBe("SELECT 'it\\'s' AS s FROM t ORDER BY s DESC NULLS LAST");
    expect(withNullsLastWhenDescending("SELECT 'a''b' AS s, (SELECT max(x) FROM u) m FROM t ORDER BY m DESC", 'postgresql')).toBe("SELECT 'a''b' AS s, (SELECT max(x) FROM u) m FROM t ORDER BY m DESC NULLS LAST");
    expect(withNullsLastWhenDescending('SELECT a FROM t ORDER BY a DESC', 'duckdb')).toBe('SELECT a FROM t ORDER BY a DESC');
    expect(withNullsLastWhenDescending('SELECT a FROM t ORDER BY a DESC', 'bigquery')).toBe('SELECT a FROM t ORDER BY a DESC');
  });
});
