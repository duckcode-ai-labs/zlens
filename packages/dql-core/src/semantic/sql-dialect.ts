/**
 * SQL Dialect abstraction for cross-database semantic query generation.
 *
 * Each database has different syntax for date truncation, identifier quoting,
 * type casting, etc. This module provides a uniform interface so that
 * SemanticLayer.composeQuery() generates portable SQL.
 */

export interface SQLDialect {
  /** Driver name(s) this dialect covers. */
  readonly name: string;

  /** Truncate a date/timestamp column to a given granularity. */
  dateTrunc(granularity: string, columnSql: string): string;

  /** Quote an identifier (table/column name). */
  quoteIdentifier(name: string): string;

  /**
   * A text value as this database reads it. A value can come from a person, an
   * agent or a BI file, so it must never be able to end the string.
   */
  quoteString(value: string): string;

  /** CURRENT_TIMESTAMP expression. */
  currentTimestamp(): string;

  /** Cast an expression to DATE type. */
  castToDate(expr: string): string;

  /** LIMIT N clause (some dialects use TOP N instead). */
  limitClause(n: number): string;

  /** Whether LIMIT goes at the end (true) or must use TOP (false). */
  readonly limitAtEnd: boolean;

  /** String concatenation for two expressions. */
  concat(a: string, b: string): string;

  /** ILIKE or case-insensitive LIKE equivalent. */
  ilike(column: string, pattern: string): string;
}

/** Standard SQL: a quote doubles, and a backslash is an ordinary character. */
function standardString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Databases that read a backslash as an escape: left alone, `\'` would end the string. */
function backslashString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * BigQuery and Databricks, where `''` does not mean a quote. It is written as
 * \u0027 rather than `\'`, so nothing that scans the SQL later (for parentheses
 * or column names) has to know the escape does not end the string.
 */
function escapedString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\u0027').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

// ── PostgreSQL / Redshift ────────────────────────────────────────────────────

class PostgreSQLDialect implements SQLDialect {
  readonly name = 'postgresql';
  readonly limitAtEnd = true;

  dateTrunc(granularity: string, columnSql: string): string {
    return `DATE_TRUNC('${granularity}', ${columnSql})`;
  }

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  quoteString(value: string): string {
    return standardString(value);
  }

  currentTimestamp(): string {
    return 'CURRENT_TIMESTAMP';
  }

  castToDate(expr: string): string {
    return `(${expr})::DATE`;
  }

  limitClause(n: number): string {
    return `LIMIT ${n}`;
  }

  concat(a: string, b: string): string {
    return `${a} || ${b}`;
  }

  ilike(column: string, pattern: string): string {
    return `${column} ILIKE ${pattern}`;
  }
}

// ── DuckDB / File ────────────────────────────────────────────────────────────

class DuckDBDialect implements SQLDialect {
  readonly name = 'duckdb';
  readonly limitAtEnd = true;

  dateTrunc(granularity: string, columnSql: string): string {
    return `DATE_TRUNC('${granularity}', ${columnSql})`;
  }

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  quoteString(value: string): string {
    return standardString(value);
  }

  currentTimestamp(): string {
    return 'CURRENT_TIMESTAMP';
  }

  castToDate(expr: string): string {
    return `CAST(${expr} AS DATE)`;
  }

  limitClause(n: number): string {
    return `LIMIT ${n}`;
  }

  concat(a: string, b: string): string {
    return `${a} || ${b}`;
  }

  ilike(column: string, pattern: string): string {
    return `${column} ILIKE ${pattern}`;
  }
}

// ── Snowflake ────────────────────────────────────────────────────────────────

class SnowflakeDialect implements SQLDialect {
  readonly name = 'snowflake';
  readonly limitAtEnd = true;

  dateTrunc(granularity: string, columnSql: string): string {
    return `DATE_TRUNC('${granularity}', ${columnSql})`;
  }

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  quoteString(value: string): string {
    return backslashString(value);
  }

  currentTimestamp(): string {
    return 'CURRENT_TIMESTAMP()';
  }

  castToDate(expr: string): string {
    return `TO_DATE(${expr})`;
  }

  limitClause(n: number): string {
    return `LIMIT ${n}`;
  }

  concat(a: string, b: string): string {
    return `${a} || ${b}`;
  }

  ilike(column: string, pattern: string): string {
    return `${column} ILIKE ${pattern}`;
  }
}

// ── BigQuery ─────────────────────────────────────────────────────────────────

class BigQueryDialect implements SQLDialect {
  readonly name = 'bigquery';
  readonly limitAtEnd = true;

  dateTrunc(granularity: string, columnSql: string): string {
    // BigQuery: DATE_TRUNC(column, MONTH) — note reversed arg order, granularity is keyword not string
    const grain = granularity.toUpperCase();
    return `DATE_TRUNC(${columnSql}, ${grain})`;
  }

  quoteIdentifier(name: string): string {
    // BigQuery reads backslash escapes inside backticks: a backslash is escaped too, or it would escape the closing one.
    return `\`${name.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
  }

  quoteString(value: string): string {
    return escapedString(value);
  }

  currentTimestamp(): string {
    return 'CURRENT_TIMESTAMP()';
  }

  castToDate(expr: string): string {
    return `DATE(${expr})`;
  }

  limitClause(n: number): string {
    return `LIMIT ${n}`;
  }

  concat(a: string, b: string): string {
    return `CONCAT(${a}, ${b})`;
  }

  ilike(column: string, pattern: string): string {
    return `LOWER(${column}) LIKE LOWER(${pattern})`;
  }
}

// ── MySQL ────────────────────────────────────────────────────────────────────

class MySQLDialect implements SQLDialect {
  readonly name = 'mysql';
  readonly limitAtEnd = true;

  dateTrunc(granularity: string, columnSql: string): string {
    // MySQL doesn't have DATE_TRUNC — use DATE_FORMAT or equivalent
    switch (granularity) {
      case 'day':
        return `DATE(${columnSql})`;
      case 'week':
        return `DATE(DATE_SUB(${columnSql}, INTERVAL WEEKDAY(${columnSql}) DAY))`;
      case 'month':
        return `DATE_FORMAT(${columnSql}, '%Y-%m-01')`;
      case 'quarter':
        return `MAKEDATE(YEAR(${columnSql}), 1) + INTERVAL (QUARTER(${columnSql}) - 1) QUARTER`;
      case 'year':
        return `DATE_FORMAT(${columnSql}, '%Y-01-01')`;
      default:
        return `DATE(${columnSql})`;
    }
  }

  quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  quoteString(value: string): string {
    return backslashString(value);
  }

  currentTimestamp(): string {
    return 'NOW()';
  }

  castToDate(expr: string): string {
    return `DATE(${expr})`;
  }

  limitClause(n: number): string {
    return `LIMIT ${n}`;
  }

  concat(a: string, b: string): string {
    return `CONCAT(${a}, ${b})`;
  }

  ilike(column: string, pattern: string): string {
    // MySQL LIKE is case-insensitive by default with utf8 collation
    return `${column} LIKE ${pattern}`;
  }
}

// ── SQLite ───────────────────────────────────────────────────────────────────

class SQLiteDialect implements SQLDialect {
  readonly name = 'sqlite';
  readonly limitAtEnd = true;

  dateTrunc(granularity: string, columnSql: string): string {
    switch (granularity) {
      case 'day':
        return `DATE(${columnSql})`;
      case 'week':
        return `DATE(${columnSql}, 'weekday 0', '-6 days')`;
      case 'month':
        return `STRFTIME('%Y-%m-01', ${columnSql})`;
      case 'quarter':
        return `STRFTIME('%Y-', ${columnSql}) || CASE ((CAST(STRFTIME('%m', ${columnSql}) AS INTEGER) - 1) / 3) WHEN 0 THEN '01-01' WHEN 1 THEN '04-01' WHEN 2 THEN '07-01' ELSE '10-01' END`;
      case 'year':
        return `STRFTIME('%Y-01-01', ${columnSql})`;
      default:
        return `DATE(${columnSql})`;
    }
  }

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  quoteString(value: string): string {
    return standardString(value);
  }

  currentTimestamp(): string {
    return "DATETIME('now')";
  }

  castToDate(expr: string): string {
    return `DATE(${expr})`;
  }

  limitClause(n: number): string {
    return `LIMIT ${n}`;
  }

  concat(a: string, b: string): string {
    return `${a} || ${b}`;
  }

  ilike(column: string, pattern: string): string {
    return `${column} LIKE ${pattern}`;
  }
}

// ── MSSQL / Fabric ───────────────────────────────────────────────────────────

class MSSQLDialect implements SQLDialect {
  readonly name = 'mssql';
  readonly limitAtEnd = false;

  dateTrunc(granularity: string, columnSql: string): string {
    // SQL Server 2022+ supports DATETRUNC, older versions need DATEADD/DATEDIFF
    // Using DATETRUNC for modern compat (Azure SQL, Fabric always support it)
    const grain = granularity.toLowerCase();
    return `DATETRUNC(${grain}, ${columnSql})`;
  }

  quoteIdentifier(name: string): string {
    return `[${name.replace(/\]/g, ']]')}]`;
  }

  quoteString(value: string): string {
    return standardString(value);
  }

  currentTimestamp(): string {
    return 'GETDATE()';
  }

  castToDate(expr: string): string {
    return `CAST(${expr} AS DATE)`;
  }

  limitClause(n: number): string {
    // MSSQL uses TOP N in SELECT, but for composed queries OFFSET/FETCH is cleaner
    return `OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
  }

  concat(a: string, b: string): string {
    return `CONCAT(${a}, ${b})`;
  }

  ilike(column: string, pattern: string): string {
    // MSSQL LIKE is case-insensitive by default
    return `${column} LIKE ${pattern}`;
  }
}

// ── ClickHouse ───────────────────────────────────────────────────────────────

class ClickHouseDialect implements SQLDialect {
  readonly name = 'clickhouse';
  readonly limitAtEnd = true;

  dateTrunc(granularity: string, columnSql: string): string {
    switch (granularity) {
      case 'day':
        return `toDate(${columnSql})`;
      case 'week':
        return `toMonday(${columnSql})`;
      case 'month':
        return `toStartOfMonth(${columnSql})`;
      case 'quarter':
        return `toStartOfQuarter(${columnSql})`;
      case 'year':
        return `toStartOfYear(${columnSql})`;
      default:
        return `toDate(${columnSql})`;
    }
  }

  quoteIdentifier(name: string): string {
    // ClickHouse reads backslash escapes inside quoted names: a backslash is escaped too, or it could escape the closing quote.
    return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '""')}"`;
  }

  quoteString(value: string): string {
    return backslashString(value);
  }

  currentTimestamp(): string {
    return 'now()';
  }

  castToDate(expr: string): string {
    return `toDate(${expr})`;
  }

  limitClause(n: number): string {
    return `LIMIT ${n}`;
  }

  concat(a: string, b: string): string {
    return `concat(${a}, ${b})`;
  }

  ilike(column: string, pattern: string): string {
    return `${column} ILIKE ${pattern}`;
  }
}

// ── Databricks ───────────────────────────────────────────────────────────────

class DatabricksDialect implements SQLDialect {
  readonly name = 'databricks';
  readonly limitAtEnd = true;

  dateTrunc(granularity: string, columnSql: string): string {
    return `DATE_TRUNC('${granularity}', ${columnSql})`;
  }

  quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  quoteString(value: string): string {
    return escapedString(value);
  }

  currentTimestamp(): string {
    return 'CURRENT_TIMESTAMP()';
  }

  castToDate(expr: string): string {
    return `CAST(${expr} AS DATE)`;
  }

  limitClause(n: number): string {
    return `LIMIT ${n}`;
  }

  concat(a: string, b: string): string {
    return `CONCAT(${a}, ${b})`;
  }

  ilike(column: string, pattern: string): string {
    return `${column} ILIKE ${pattern}`;
  }
}

// ── Trino / Athena (Presto family) ───────────────────────────────────────────

class TrinoDialect implements SQLDialect {
  readonly name = 'trino';
  readonly limitAtEnd = true;

  dateTrunc(granularity: string, columnSql: string): string {
    return `DATE_TRUNC('${granularity}', ${columnSql})`;
  }

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  quoteString(value: string): string {
    return standardString(value);
  }

  currentTimestamp(): string {
    return 'CURRENT_TIMESTAMP';
  }

  castToDate(expr: string): string {
    return `CAST(${expr} AS DATE)`;
  }

  limitClause(n: number): string {
    return `LIMIT ${n}`;
  }

  concat(a: string, b: string): string {
    return `${a} || ${b}`;
  }

  ilike(column: string, pattern: string): string {
    return `LOWER(${column}) LIKE LOWER(${pattern})`;
  }
}

// ── Dialect Registry ─────────────────────────────────────────────────────────

/** Redshift reads Postgres's SQL, from before a backslash in a string became an ordinary character. */
class RedshiftDialect extends PostgreSQLDialect {
  override quoteString(value: string): string {
    return backslashString(value);
  }
}

const DIALECT_MAP: Record<string, SQLDialect> = {
  postgresql: new PostgreSQLDialect(),
  redshift: new RedshiftDialect(),
  duckdb: new DuckDBDialect(),
  file: new DuckDBDialect(),
  snowflake: new SnowflakeDialect(),
  bigquery: new BigQueryDialect(),
  mysql: new MySQLDialect(),
  sqlite: new SQLiteDialect(),
  mssql: new MSSQLDialect(),
  fabric: new MSSQLDialect(),
  clickhouse: new ClickHouseDialect(),
  databricks: new DatabricksDialect(),
  trino: new TrinoDialect(),
  athena: new TrinoDialect(),
};

/** Default dialect (DuckDB) used when no driver is specified. */
const DEFAULT_DIALECT = DIALECT_MAP['duckdb'];

/**
 * Get the SQL dialect for a given driver name.
 * Falls back to DuckDB dialect if the driver is unknown.
 */
export function getDialect(driver?: string): SQLDialect {
  if (!driver) return DEFAULT_DIALECT;
  return DIALECT_MAP[driver] ?? DEFAULT_DIALECT;
}

/**
 * List all supported dialect driver names.
 */
export function listDialectDrivers(): string[] {
  return Object.keys(DIALECT_MAP);
}

/**
 * A concise, human-readable SQL-conventions block for the generation prompt, so
 * the model writes dialect-correct SQL (quoting, row-limiting, date functions)
 * instead of a DuckDB/Postgres default that then fails on Snowflake/BigQuery/etc.
 * Every example is derived from the real dialect object, so it can never drift
 * from what the semantic composer emits.
 */
export function describeDialectForPrompt(driver?: string): string {
  const dialect = getDialect(driver);
  // A file connection is DuckDB reading data files: its SQL is DuckDB's.
  const name = driver?.trim() === 'file' ? 'duckdb' : driver?.trim() || 'duckdb';
  const limitGuidance = dialect.limitAtEnd
    ? `row-limit with \`${dialect.limitClause(100)}\` at the END of the query`
    : `row-limit with \`${dialect.limitClause(100)}\` (goes right after SELECT, not at the end)`;
  return [
    `Target warehouse dialect: ${name} (${dialect.name}). Write ${dialect.name}-compatible SQL only.`,
    `- Quote identifiers when needed as ${dialect.quoteIdentifier('identifier')}.`,
    `- ${limitGuidance}.`,
    `- Truncate a timestamp to a grain with ${dialect.dateTrunc('month', 'ts_column')}.`,
    `- Cast to date with ${dialect.castToDate('expr')}; current timestamp is ${dialect.currentTimestamp()}.`,
    `- Case-insensitive text match: ${dialect.ilike('col', "'%value%'")}.`,
  ].join('\n');
}
