import { describe, expect, it } from 'vitest';
import { describeDialectForPrompt, getDialect, listDialectDrivers } from './sql-dialect.js';

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
