/**
 * SQL reference extractors for lineage and generated-query validation.
 *
 * `extractTablesFromSql` intentionally stays lightweight for manifest lineage.
 * `analyzeSqlReferences` uses node-sql-parser for the stricter Tier-2 agent
 * validation path, where relation and column references must be checked against
 * an inspected context pack before SQL is executed.
 */

import nodeSqlParserPkg from 'node-sql-parser';

const { Parser } = nodeSqlParserPkg;

export interface SqlParseResult {
  /** External table dependencies (CTEs excluded) */
  tables: string[];
  /** CTE names defined in this query */
  ctes: string[];
  /** ref() calls found in the SQL */
  refs: string[];
  /** @metric() references found in the SQL */
  metricRefs: string[];
  /** @dim() references found in the SQL */
  dimensionRefs: string[];
}

export interface SqlColumnReference {
  column: string;
  tableAlias?: string;
  relation?: string;
  unqualified: boolean;
  /** True when this is a legal reference to a select-list alias. */
  outputAliasReference?: boolean;
}

/** An equality join condition `left.col = right.col`, aliases resolved to relations. */
export interface SqlJoinCondition {
  leftRelation?: string;
  leftColumn: string;
  rightRelation?: string;
  rightColumn: string;
  joinType?: string;
}

/** An aggregate function reference in the SELECT list, e.g. `SUM(o.amount)`. */
export interface SqlAggregateReference {
  func: string;
  distinct: boolean;
  column?: string;
  relation?: string;
}

/**
 * References owned by one SELECT scope. Keeping aliases scoped prevents an
 * inner CTE alias from being treated as a peer of an outer alias during
 * ambiguity validation.
 */
export interface SqlReferenceScope {
  id: string;
  columns: SqlColumnReference[];
  aliasToRelation: Record<string, string>;
  outputAliases: string[];
}

export interface SqlReferenceAnalysis {
  parsed: boolean;
  statementTypes: string[];
  tables: string[];
  ctes: string[];
  /** Query-internal FROM/JOIN subquery aliases, never physical relations. */
  derivedRelations: string[];
  columns: SqlColumnReference[];
  /** Equality join conditions (for grain / fan-out analysis). Empty when unparsed. */
  joins: SqlJoinCondition[];
  /** Aggregate function references in the SELECT list. Empty when unparsed. */
  aggregates: SqlAggregateReference[];
  aliasToRelation: Record<string, string>;
  scopes: SqlReferenceScope[];
  error?: string;
}

export interface SqlAnalyticalSignature {
  version: 1;
  statementType: 'select';
  canonicalAst: string;
  positionalParameters: number[];
}

/** Parser-owned identity for one named SELECT output expression. */
export interface SqlOutputExpressionSignature {
  version: 1;
  outputAlias: string;
  canonicalExpression: string;
  operators: string[];
  columns: string[];
  aggregateFunctions: string[];
}

export interface GeneratedAnalyticalOutputSignature extends SqlOutputExpressionSignature {
  /** Aggregate calls and their parser-resolved physical inputs for this output only. */
  aggregateInputs: SqlAggregateReference[];
  /**
   * Parser-resolved physical column references for this output expression only.
   *
   * Keeping these per projection (rather than using the query-wide reference
   * list) lets a caller prove that `order_id AS order_id` is backed by the
   * frozen order-id source, not merely that some order-id column appeared
   * elsewhere in the statement.  Relation aliases are resolved to their
   * physical relation when the parser can prove them.
   */
  columnReferences: SqlColumnReference[];
}

/** Parser-owned semantic facts for a generated analytical SELECT. */
export interface GeneratedAnalyticalSqlSignatureV1 {
  version: 1;
  canonicalAst: string;
  outputs: GeneratedAnalyticalOutputSignature[];
  groupByColumns: string[];
  filterExpression?: string;
  orderBy: Array<{ expression: string; direction: 'asc' | 'desc' }>;
  limit?: { kind: 'literal'; value: number } | { kind: 'parameter'; value: string };
  sourceRelations: string[];
  joins: SqlJoinCondition[];
  setOperations: string[];
  hasWindow: boolean;
  positionalParameters: number[];
}

const DIALECT_MAP: Record<string, string> = {
  duckdb: 'postgresql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  bigquery: 'bigquery',
  snowflake: 'snowflake',
  redshift: 'redshift',
  databricks: 'hive',
  spark: 'hive',
  spark_sql: 'hive',
  hive: 'hive',
  mssql: 'transactsql',
  sqlserver: 'transactsql',
  azure_sql: 'transactsql',
  sqlite: 'sqlite',
};

/**
 * One part of a relation name: double-quoted (ANSI, `""` escapes a quote),
 * backtick-quoted (MySQL, BigQuery, Databricks), bracketed (SQL Server), or bare.
 */
const SQL_IDENTIFIER_PART = '(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[(?:[^\\]]|\\]\\])+\\]|[a-zA-Z_][a-zA-Z0-9_]*)';

/** A dotted relation name whose parts may each be quoted: `orders`, `"main"."order_lines"`, `db.schema."Orders"`. */
const SQL_RELATION_NAME = `${SQL_IDENTIFIER_PART}(?:\\.${SQL_IDENTIFIER_PART})*`;

/**
 * Extract table references from a SQL string.
 *
 * Identifies tables in FROM and JOIN clauses, filters out CTE definitions,
 * and detects ref("block_name") calls.
 */
export function extractTablesFromSql(sql: string): SqlParseResult {
  const ctes = extractCteNames(sql);

  // Strip comments first (refs inside comments should be ignored)
  const noComments = stripComments(sql);

  // Extract DuckDB reader functions BEFORE stripping string literals
  // (because the file path is inside quotes that would be stripped)
  const readerTables = extractReaderFunctions(noComments);

  // Strip non-ref string literals, then extract refs from the result.
  // This ensures ref("block") and ref('block') are preserved, but
  // 'ref("fake")' (a string literal containing ref) is stripped.
  const withoutStringLiterals = stripStringLiterals(noComments);
  const refs = extractRefs(withoutStringLiterals);

  // For table extraction, use the fully cleaned version. A FROM that belongs
  // to an expression (`EXTRACT(YEAR FROM game_date_est)`, `TRIM(x FROM col)`,
  // `a IS DISTINCT FROM b`) names a column, not a relation.
  const cleaned = maskExpressionFromKeywords(withoutStringLiterals);

  const rawTables = new Set<string>();

  // FROM <table> — handles FROM table, FROM schema.table, FROM "schema"."table"
  const fromPattern = new RegExp(`\\bFROM\\s+(?:LATERAL\\s+)?(${SQL_RELATION_NAME})`, 'gi');
  for (const match of cleaned.matchAll(fromPattern)) {
    addTableRef(rawTables, match[1]);
  }

  // JOIN <table> — all join types
  const joinPattern = new RegExp(`\\bJOIN\\s+(?:LATERAL\\s+)?(${SQL_RELATION_NAME})`, 'gi');
  for (const match of cleaned.matchAll(joinPattern)) {
    addTableRef(rawTables, match[1]);
  }

  // INTO <table> (INSERT INTO, MERGE INTO)
  const intoPattern = new RegExp(`\\bINTO\\s+(${SQL_RELATION_NAME})`, 'gi');
  for (const match of cleaned.matchAll(intoPattern)) {
    addTableRef(rawTables, match[1]);
  }

  // Add DuckDB reader function references (extracted before string stripping)
  for (const rt of readerTables) {
    rawTables.add(rt);
  }

  // Filter out CTEs, SQL keywords that might match, and DuckDB functions
  const sqlKeywords = new Set([
    'select', 'where', 'group', 'order', 'having', 'limit', 'offset',
    'union', 'except', 'intersect', 'values', 'set', 'lateral',
    'unnest', 'generate_series', 'read_csv_auto', 'read_csv', 'read_parquet',
    'read_json', 'read_json_auto', 'range', 'information_schema', 'ref',
  ]);

  const cteNamesLower = new Set(ctes.map((c) => c.toLowerCase()));

  const tables = [...rawTables].filter((t) => {
    const lower = t.toLowerCase();
    return !cteNamesLower.has(lower) && !sqlKeywords.has(lower);
  });

  // Extract @metric() and @dim() semantic references
  const metricRefs = extractSemanticRefs(noComments, 'metric');
  const dimensionRefs = extractSemanticRefs(noComments, 'dim');

  return { tables, ctes, refs, metricRefs, dimensionRefs };
}

export function analyzeSqlReferences(sql: string, dialect = 'duckdb'): SqlReferenceAnalysis {
  const parser = new Parser();
  let astRoot: unknown;
  try {
    astRoot = parser.astify(sql, { database: DIALECT_MAP[dialect.toLowerCase()] ?? 'postgresql' });
  } catch (err) {
    const fallback = extractTablesFromSql(sql);
    return {
      parsed: false,
      statementTypes: [],
      tables: fallback.tables,
      ctes: fallback.ctes,
      derivedRelations: [],
      columns: [],
      joins: [],
      aggregates: [],
      aliasToRelation: {},
      scopes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const statements = Array.isArray(astRoot) ? astRoot : [astRoot];
  const ctes = new Set(extractCteNames(sql).map((name) => normalizeSqlIdentifier(name)));
  const derivedRelations = new Set<string>();
  const tableRefs = new Map<string, string>();
  const aliasToRelation = new Map<string, string>();
  const statementTypes = new Set<string>();

  for (const statement of statements) {
    const type = readStatementType(statement);
    if (type) statementTypes.add(type);
    collectSqlTables(statement, {
      ctes,
      derivedRelations,
      tableRefs,
      aliasToRelation,
    });
  }

  const columns: SqlColumnReference[] = [];
  for (const statement of statements) {
    collectSqlColumns(statement, {
      ctes,
      derivedRelations,
      aliasToRelation,
      singleRelation: tableRefs.size === 1 ? Array.from(tableRefs.values())[0] : undefined,
      columns,
    });
  }

  const singleRelation = tableRefs.size === 1 ? Array.from(tableRefs.values())[0] : undefined;
  const joins: SqlJoinCondition[] = [];
  const aggregates: SqlAggregateReference[] = [];
  for (const statement of statements) {
    collectSqlJoins(statement, { ctes, aliasToRelation, joins });
    collectSqlAggregates(statement, { ctes, derivedRelations, aliasToRelation, singleRelation, aggregates });
  }
  const scopes = statements.flatMap((statement, index) =>
    collectSqlReferenceScopes(statement, `statement_${index + 1}`),
  );

  return {
    parsed: true,
    statementTypes: Array.from(statementTypes),
    tables: Array.from(tableRefs.values()),
    ctes: Array.from(ctes),
    derivedRelations: Array.from(derivedRelations),
    columns: dedupeColumnReferences(columns),
    joins,
    aggregates,
    aliasToRelation: Object.fromEntries(aliasToRelation),
    scopes,
  };
}

/**
 * Parser-owned same-plan authority for bounded SQL repair. The complete SELECT
 * AST is retained (including projections, predicates, grouping, joins,
 * aggregates, ordering, and bounds); only parser locations and identifier
 * quoting/case are normalized. Unsupported or multi-statement SQL has no
 * signature and therefore cannot be automatically repaired.
 */
export function buildSqlAnalyticalSignature(sql: string, dialect = 'duckdb'): SqlAnalyticalSignature | undefined {
  const parser = new Parser();
  let astRoot: unknown;
  try {
    astRoot = parser.astify(sql, { database: DIALECT_MAP[dialect.toLowerCase()] ?? 'postgresql' });
  } catch {
    return undefined;
  }
  const statements = Array.isArray(astRoot) ? astRoot : [astRoot];
  if (statements.length !== 1 || readStatementType(statements[0]) !== 'select') return undefined;
  const canonical = canonicalSqlAst(statements[0]);
  return {
    version: 1,
    statementType: 'select',
    canonicalAst: stableSqlAstJson(canonical),
    positionalParameters: Array.from(sql.matchAll(/\$(\d+)\b/g), (match) => Number(match[1])),
  };
}

/**
 * Return an exact expression-tree signature for one unambiguous named output.
 * Relation aliases are intentionally excluded from the expression identity;
 * callers must bind physical relations separately. Column names, functions,
 * operators, CASE predicates, literals, and nesting remain in the signature.
 */
export function buildSqlOutputExpressionSignature(
  sql: string,
  outputAlias: string,
  dialect = 'duckdb',
): SqlOutputExpressionSignature | undefined {
  const parser = new Parser();
  let astRoot: unknown;
  try {
    astRoot = parser.astify(sql, { database: DIALECT_MAP[dialect.toLowerCase()] ?? 'postgresql' });
  } catch {
    return undefined;
  }
  const normalizedAlias = normalizeSqlIdentifier(outputAlias);
  const expressions: unknown[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (readStatementType(record) === 'select' && Array.isArray(record.columns)) {
      for (const column of record.columns) {
        if (!column || typeof column !== 'object') continue;
        const projection = column as Record<string, unknown>;
        const alias = stringField(projection, 'as');
        if (alias && normalizeSqlIdentifier(alias) === normalizedAlias && projection.expr) {
          expressions.push(projection.expr);
        }
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(astRoot);
  if (expressions.length !== 1) return undefined;

  return buildOutputExpressionSignatureFromAst(expressions[0], normalizedAlias);
}

function buildOutputExpressionSignatureFromAst(
  expression: unknown,
  normalizedAlias: string,
): SqlOutputExpressionSignature {

  const operators = new Set<string>();
  const columns = new Set<string>();
  const aggregateFunctions = new Set<string>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.operator === 'string') operators.add(record.operator.toUpperCase());
    if (record.type === 'column_ref') {
      const column = readColumnRefName(record);
      if (column && column !== '*') columns.add(normalizeSqlIdentifier(column));
    }
    if (record.type === 'aggr_func' && typeof record.name === 'string') {
      aggregateFunctions.add(record.name.toUpperCase());
    }
    for (const child of Object.values(record)) collect(child);
  };
  collect(expression);
  return {
    version: 1,
    outputAlias: normalizedAlias,
    canonicalExpression: stableSqlAstJson(canonicalSqlOutputExpressionAst(expression)),
    operators: Array.from(operators).sort(),
    columns: Array.from(columns).sort(),
    aggregateFunctions: Array.from(aggregateFunctions).sort(),
  };
}

export function buildGeneratedAnalyticalSqlSignature(
  sql: string,
  dialect = 'duckdb',
): GeneratedAnalyticalSqlSignatureV1 | undefined {
  const parser = new Parser();
  let astRoot: unknown;
  try {
    astRoot = parser.astify(sql, { database: DIALECT_MAP[dialect.toLowerCase()] ?? 'postgresql' });
  } catch {
    return undefined;
  }
  const statements = Array.isArray(astRoot) ? astRoot : [astRoot];
  if (statements.length !== 1 || readStatementType(statements[0]) !== 'select') return undefined;
  const statement = statements[0] as Record<string, unknown>;
  if (!Array.isArray(statement.columns)) return undefined;
  const outputAliases: string[] = [];
  for (const column of statement.columns) {
    if (!column || typeof column !== 'object') return undefined;
    const projection = column as Record<string, unknown>;
    const alias = stringField(projection, 'as')
      ?? (projection.expr && typeof projection.expr === 'object'
        ? readColumnRefName(projection.expr as Record<string, unknown>)
        : undefined);
    if (!alias) return undefined;
    outputAliases.push(alias);
  }
  if (new Set(outputAliases.map(normalizeSqlIdentifier)).size !== outputAliases.length) return undefined;
  const analysis = analyzeSqlReferences(sql, dialect);
  if (!analysis.parsed || analysis.statementTypes.some((type) => type !== 'select')) return undefined;
  const aliasToRelation = new Map(Object.entries(analysis.aliasToRelation));
  const singleRelation = analysis.tables.length === 1 ? analysis.tables[0] : undefined;
  const derivedRelations = new Set(analysis.derivedRelations.map(normalizeSqlIdentifier));
  const ctes = new Set(analysis.ctes.map(normalizeSqlIdentifier));
  const outputs = statement.columns.map((column, index) => {
    const expression = (column as Record<string, unknown>).expr;
    const aggregateInputs: SqlAggregateReference[] = [];
    const columnReferences: SqlColumnReference[] = [];
    collectSqlAggregates(expression, {
      ctes,
      derivedRelations,
      aliasToRelation,
      ...(singleRelation ? { singleRelation } : {}),
      aggregates: aggregateInputs,
    });
    collectSqlColumns(expression, {
      ctes,
      derivedRelations,
      aliasToRelation,
      ...(singleRelation ? { singleRelation } : {}),
      columns: columnReferences,
    });
    return {
      ...buildOutputExpressionSignatureFromAst(expression, normalizeSqlIdentifier(outputAliases[index]!)),
      aggregateInputs,
      columnReferences: dedupeColumnReferences(columnReferences),
    };
  });

  const groupBy = statement.groupby && typeof statement.groupby === 'object'
    ? (statement.groupby as Record<string, unknown>).columns
    : undefined;
  const groupByColumns = Array.isArray(groupBy)
    ? groupBy.flatMap((expression) => {
        if (!expression || typeof expression !== 'object') return [];
        const column = readColumnRefName(expression as Record<string, unknown>);
        return column ? [normalizeSqlIdentifier(column)] : [];
      })
    : [];
  if (Array.isArray(groupBy) && groupByColumns.length !== groupBy.length) return undefined;

  const orderBy = Array.isArray(statement.orderby)
    ? statement.orderby.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const order = item as Record<string, unknown>;
        if (!order.expr || typeof order.expr !== 'object') return [];
        const expression = readColumnRefName(order.expr as Record<string, unknown>);
        if (!expression) return [];
        const direction = typeof order.type === 'string' && order.type.toLowerCase() === 'desc' ? 'desc' as const : 'asc' as const;
        return [{ expression: normalizeSqlIdentifier(expression), direction }];
      })
    : [];
  if (Array.isArray(statement.orderby) && orderBy.length !== statement.orderby.length) return undefined;

  const limitValues = statement.limit && typeof statement.limit === 'object'
    ? (statement.limit as Record<string, unknown>).value
    : undefined;
  let limit: GeneratedAnalyticalSqlSignatureV1['limit'];
  if (Array.isArray(limitValues) && limitValues.length > 0) {
    if (limitValues.length !== 1 || !limitValues[0] || typeof limitValues[0] !== 'object') return undefined;
    const value = limitValues[0] as Record<string, unknown>;
    if (value.type === 'number' && typeof value.value === 'number') limit = { kind: 'literal', value: value.value };
    else if (value.type === 'param' || value.type === 'origin') limit = { kind: 'parameter', value: stableSqlAstJson(canonicalSqlAst(value)) };
    else return undefined;
  }

  const setOperations: string[] = [];
  let setCursor: Record<string, unknown> | undefined = statement;
  while (setCursor?._next && typeof setCursor._next === 'object') {
    setOperations.push(typeof setCursor.set_op === 'string' ? setCursor.set_op.toLowerCase() : 'unknown');
    setCursor = setCursor._next as Record<string, unknown>;
  }
  let hasWindow = false;
  const detectWindow = (value: unknown): void => {
    if (!value || typeof value !== 'object' || hasWindow) return;
    if (Array.isArray(value)) {
      for (const child of value) detectWindow(child);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.over || record.window) hasWindow = true;
    for (const child of Object.values(record)) detectWindow(child);
  };
  detectWindow(statement);
  const analytical = buildSqlAnalyticalSignature(sql, dialect);
  if (!analytical) return undefined;
  return {
    version: 1,
    canonicalAst: analytical.canonicalAst,
    outputs,
    groupByColumns: Array.from(new Set(groupByColumns)).sort(),
    ...(statement.where ? { filterExpression: stableSqlAstJson(canonicalSqlOutputExpressionAst(statement.where)) } : {}),
    orderBy,
    ...(limit ? { limit } : {}),
    sourceRelations: [...analysis.tables].sort(),
    joins: analysis.joins,
    setOperations,
    hasWindow,
    positionalParameters: analytical.positionalParameters,
  };
}

function canonicalSqlOutputExpressionAst(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalSqlOutputExpressionAst(item));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && ['column', 'name'].includes(key)) return normalizeSqlIdentifier(value);
    if (typeof value === 'string' && key === 'operator' && value === '!=') return '<>';
    return value;
  }
  const record = value as Record<string, unknown>;
  // MetricFlow preserves ratio meaning while adding numeric transport wrappers.
  // Strip only wrappers whose semantics are provably aggregation-neutral:
  // CAST(expr AS numeric) and NULLIF(expr, 0) on the denominator. Arbitrary
  // functions, fallback values, or operators remain part of the identity.
  if (record.type === 'cast' && record.expr && isAggregationNeutralNumericCast(record)) {
    return canonicalSqlOutputExpressionAst(record.expr);
  }
  const functionName = sqlFunctionName(record);
  const functionArgs = record.args && typeof record.args === 'object' && !Array.isArray(record.args)
    ? (record.args as Record<string, unknown>).value
    : undefined;
  if (functionName === 'nullif' && Array.isArray(functionArgs) && functionArgs.length === 2
    && isSqlNumericZero(functionArgs[1])) {
    return canonicalSqlOutputExpressionAst(functionArgs[0]);
  }
  return Object.fromEntries(Object.entries(record)
    .filter(([entryKey]) => entryKey !== 'loc'
      && entryKey !== 'parentheses'
      && !(record.type === 'column_ref' && entryKey === 'table'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryKey, nested]) => [entryKey, canonicalSqlOutputExpressionAst(nested, entryKey)]));
}

function isAggregationNeutralNumericCast(record: Record<string, unknown>): boolean {
  const target = record.target;
  const targetValue = Array.isArray(target) ? target[0] : target;
  const targetType = targetValue && typeof targetValue === 'object' && !Array.isArray(targetValue)
    ? (targetValue as Record<string, unknown>).dataType ?? (targetValue as Record<string, unknown>).type
    : targetValue;
  if (typeof targetType !== 'string') return false;
  return new Set([
    'bigint', 'decimal', 'double', 'double precision', 'float', 'hugeint',
    'int', 'integer', 'numeric', 'real', 'smallint', 'tinyint',
  ]).has(targetType.trim().toLowerCase());
}

function sqlFunctionName(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'function') return undefined;
  const name = record.name;
  if (typeof name === 'string') return normalizeSqlIdentifier(name);
  if (!name || typeof name !== 'object' || Array.isArray(name)) return undefined;
  const parts = (name as Record<string, unknown>).name;
  if (!Array.isArray(parts) || parts.length !== 1) return undefined;
  const part = parts[0];
  if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const value = (part as Record<string, unknown>).value;
  return typeof value === 'string' ? normalizeSqlIdentifier(value) : undefined;
}

function isSqlNumericZero(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'number' && Number(record.value) === 0;
}

function canonicalSqlAst(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalSqlAst(item));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && ['table', 'column', 'db', 'database', 'schema', 'as', 'name'].includes(key)) {
      return normalizeSqlIdentifier(value);
    }
    if (typeof value === 'string' && key === 'operator' && value === '!=') return '<>';
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([entryKey]) => entryKey !== 'loc')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryKey, nested]) => [entryKey, canonicalSqlAst(nested, entryKey)]));
}

function stableSqlAstJson(value: unknown): string {
  return JSON.stringify(value);
}

function collectSqlReferenceScopes(node: unknown, id: string): SqlReferenceScope[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const statement = node as Record<string, unknown>;
  const scopes: SqlReferenceScope[] = [];

  const withItems = Array.isArray(statement.with) ? statement.with : [];
  for (const [index, item] of withItems.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const cteName = cteNameFromNode(record) ?? `cte_${index + 1}`;
    const stmt = record.stmt;
    const stmtRecord = stmt && typeof stmt === 'object' && !Array.isArray(stmt)
      ? stmt as Record<string, unknown>
      : undefined;
    // node-sql-parser returns the SELECT directly for PostgreSQL/DuckDB and
    // wraps it in `{ ast }` for Snowflake.
    const ast = stmtRecord?.ast ?? stmtRecord;
    scopes.push(...collectSqlReferenceScopes(ast, `${id}:cte:${cteName}`));
  }

  if (readStatementType(statement) === 'select') {
    const aliasToRelation = directScopeAliases(statement);
    const physicalRelations = Array.from(new Set(aliasToRelation.values()));
    const outputAliases = directSelectOutputAliases(statement);
    const columns: SqlColumnReference[] = [];
    collectCurrentScopeColumns(statement, {
      aliasToRelation,
      singleRelation: physicalRelations.length === 1 ? physicalRelations[0] : undefined,
      outputAliases: new Set(outputAliases),
      columns,
    });
    scopes.push({
      id,
      columns: dedupeColumnReferences(columns),
      aliasToRelation: Object.fromEntries(aliasToRelation),
      outputAliases,
    });
  }

  collectNestedSelectScopes(statement, id, scopes);
  return dedupeReferenceScopes(scopes);
}

function cteNameFromNode(node: Record<string, unknown>): string | undefined {
  const raw = node.name;
  if (typeof raw === 'string') return normalizeSqlIdentifier(raw);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = stringField(raw as Record<string, unknown>, 'value');
    if (value) return normalizeSqlIdentifier(value);
  }
  return undefined;
}

function directScopeAliases(statement: Record<string, unknown>): Map<string, string> {
  const aliases = new Map<string, string>();
  const from = Array.isArray(statement.from) ? statement.from : [];
  for (const item of from) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (derivedRelationAlias(record)) continue;
    const relation = relationFromTableNode(record);
    if (!relation || isSqlFunctionRelation(relation)) continue;
    const alias = stringField(record, 'as')
      ?? stringField(record, 'alias')
      ?? relation.split('.').at(-1);
    if (alias) aliases.set(normalizeSqlIdentifier(alias), relation);
  }
  return aliases;
}

function collectCurrentScopeColumns(
  node: unknown,
  state: {
    aliasToRelation: Map<string, string>;
    singleRelation?: string;
    outputAliases: Set<string>;
    columns: SqlColumnReference[];
  },
  root = true,
  clause?: string,
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectCurrentScopeColumns(item, state, false, clause);
    return;
  }
  const record = node as Record<string, unknown>;
  if (!root && readStatementType(record) === 'select') return;
  if (record.type === 'column_ref') {
    const column = readColumnRefName(record);
    if (!column || column === '*') return;
    const rawTable = stringField(record, 'table');
    const tableAlias = rawTable ? normalizeSqlIdentifier(rawTable) : undefined;
    const normalizedClause = clause?.toLowerCase();
    const outputAliasReference = !rawTable
      && state.outputAliases.has(normalizeSqlIdentifier(column))
      && (normalizedClause === 'orderby'
        || normalizedClause === 'order_by'
        || normalizedClause === 'groupby'
        || normalizedClause === 'group_by'
        || normalizedClause === 'having'
        || normalizedClause === 'qualify');
    state.columns.push({
      column,
      tableAlias: rawTable,
      relation: tableAlias
        ? state.aliasToRelation.get(tableAlias) ?? rawTable
        : state.singleRelation,
      unqualified: !rawTable,
      ...(outputAliasReference ? { outputAliasReference: true } : {}),
    });
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'with') continue;
    collectCurrentScopeColumns(value, state, false, root ? key : clause);
  }
}

function directSelectOutputAliases(statement: Record<string, unknown>): string[] {
  const aliases: string[] = [];
  const columns = Array.isArray(statement.columns) ? statement.columns : [];
  for (const column of columns) {
    if (!column || typeof column !== 'object' || Array.isArray(column)) continue;
    const alias = stringField(column as Record<string, unknown>, 'as');
    if (alias) aliases.push(normalizeSqlIdentifier(alias));
  }
  return Array.from(new Set(aliases));
}

function collectNestedSelectScopes(
  node: unknown,
  parentId: string,
  scopes: SqlReferenceScope[],
  counter = { value: 0 },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectNestedSelectScopes(item, parentId, scopes, counter);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'with') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)
      && readStatementType(value as Record<string, unknown>) === 'select') {
      counter.value += 1;
      scopes.push(...collectSqlReferenceScopes(value, `${parentId}:subquery:${counter.value}`));
      continue;
    }
    collectNestedSelectScopes(value, parentId, scopes, counter);
  }
}

function dedupeReferenceScopes(scopes: SqlReferenceScope[]): SqlReferenceScope[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const signature = `${scope.id}|${JSON.stringify(scope.aliasToRelation)}|${scope.columns.map((column) => `${column.tableAlias ?? ''}.${column.column}`).join(',')}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/** Resolve a column_ref node's `table` alias to a relation (or undefined). */
function resolveColumnRefRelation(
  ref: Record<string, unknown>,
  aliasToRelation: Map<string, string>,
  singleRelation?: string,
): string | undefined {
  const rawTable = stringField(ref, 'table');
  if (!rawTable) return singleRelation;
  const alias = normalizeSqlIdentifier(rawTable);
  return aliasToRelation.get(alias) ?? rawTable;
}

/** Walk the AST collecting equality join conditions from ON clauses. */
function collectSqlJoins(
  node: unknown,
  state: { ctes: Set<string>; aliasToRelation: Map<string, string>; joins: SqlJoinCondition[] },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSqlJoins(item, state);
    return;
  }
  const obj = node as Record<string, unknown>;
  // A joined FROM entry carries both `join` (type) and `on` (condition tree).
  if (typeof obj.join === 'string' && obj.on && typeof obj.on === 'object') {
    collectEquiJoinColumns(obj.on, obj.join, state);
  }
  for (const value of Object.values(obj)) collectSqlJoins(value, state);
}

/** Extract every `col = col` equality (recursing through AND/OR) from an ON tree. */
function collectEquiJoinColumns(
  onNode: unknown,
  joinType: string,
  state: { aliasToRelation: Map<string, string>; joins: SqlJoinCondition[] },
): void {
  if (!onNode || typeof onNode !== 'object') return;
  const node = onNode as Record<string, unknown>;
  if (node.type === 'binary_expr') {
    const op = typeof node.operator === 'string' ? node.operator : '';
    const left = node.left as Record<string, unknown> | undefined;
    const right = node.right as Record<string, unknown> | undefined;
    if (op === '=' && left?.type === 'column_ref' && right?.type === 'column_ref') {
      const leftColumn = readColumnRefName(left);
      const rightColumn = readColumnRefName(right);
      if (leftColumn && rightColumn) {
        state.joins.push({
          leftRelation: resolveColumnRefRelation(left, state.aliasToRelation),
          leftColumn,
          rightRelation: resolveColumnRefRelation(right, state.aliasToRelation),
          rightColumn,
          joinType,
        });
      }
      return;
    }
    // AND / OR / other composite conditions: recurse into both sides.
    collectEquiJoinColumns(left, joinType, state);
    collectEquiJoinColumns(right, joinType, state);
  }
}

/** Walk the AST collecting aggregate function references. */
function collectSqlAggregates(
  node: unknown,
  state: {
    ctes: Set<string>;
    derivedRelations: Set<string>;
    aliasToRelation: Map<string, string>;
    singleRelation?: string;
    aggregates: SqlAggregateReference[];
  },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSqlAggregates(item, state);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === 'aggr_func' && typeof obj.name === 'string') {
    const args = obj.args as Record<string, unknown> | undefined;
    const argExpr = args?.expr as Record<string, unknown> | undefined;
    const distinct = typeof args?.distinct === 'string' && args.distinct.toUpperCase() === 'DISTINCT';
    let column: string | undefined;
    let relation: string | undefined;
    if (argExpr?.type === 'column_ref') {
      const name = readColumnRefName(argExpr);
      column = name === '*' ? undefined : name;
      const resolved = resolveColumnRefRelation(argExpr, state.aliasToRelation, state.singleRelation);
      relation = resolved && !state.derivedRelations.has(normalizeSqlIdentifier(resolved)) ? resolved : undefined;
    } else if (argExpr) {
      // Generated analytical SQL commonly wraps the measure before aggregation,
      // for example SUM(ROUND(COALESCE(o.amount, 0), 2)) or
      // SUM(o.unit_price * o.quantity). The old direct-column-only extraction
      // lost the owning relation for those expressions, which made the fan-out
      // guard blind to exactly the wrong-number queries it is meant to stop.
      // Attribute the aggregate when every referenced input belongs to one
      // physical relation; retain a column only when the expression has one
      // distinct input column.
      const refs = collectAggregateArgumentColumnRefs(
        argExpr,
        state.aliasToRelation,
        state.singleRelation,
        state.derivedRelations,
      );
      const relations = Array.from(new Set(refs.map((ref) => ref.relation).filter((value): value is string => Boolean(value))));
      const columns = Array.from(new Set(refs.map((ref) => ref.column).filter((value) => value !== '*')));
      if (relations.length === 1) relation = relations[0];
      if (columns.length === 1) column = columns[0];
    }
    state.aggregates.push({ func: obj.name.toUpperCase(), distinct, column, relation });
  }
  for (const value of Object.values(obj)) collectSqlAggregates(value, state);
}

function collectAggregateArgumentColumnRefs(
  node: unknown,
  aliasToRelation: Map<string, string>,
  singleRelation?: string,
  derivedRelations: Set<string> = new Set(),
): Array<{ column: string; relation?: string }> {
  const refs: Array<{ column: string; relation?: string }> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'column_ref') {
      const column = readColumnRefName(record);
      if (column) {
        const resolved = resolveColumnRefRelation(record, aliasToRelation, singleRelation);
        refs.push({
          column,
          relation: resolved && !derivedRelations.has(normalizeSqlIdentifier(resolved)) ? resolved : undefined,
        });
      }
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(node);
  return refs;
}

/** Extract CTE names from WITH ... AS (...) patterns */
const CTE_IDENTIFIER = '"(?:[^"]|"")+"|`[^`]+`|\\[[^\\]]+\\]|[\\p{L}_][\\p{L}\\p{N}_$]*';
const CTE_HEAD = new RegExp(`\\s*(${CTE_IDENTIFIER})\\s*(?:\\([^()]*\\)\\s*)?AS\\s*(?:(?:NOT\\s+)?MATERIALIZED\\s*)?\\(`, 'iuy');

/** Strings and comments blanked in one pass, so neither can hide the other. */
export function blankStringsAndComments(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    let end = index;
    if (char === "'") {
      end = index + 1;
      while (end < sql.length && (sql[end] !== "'" || sql[end + 1] === "'")) end += sql[end] === "'" ? 2 : 1;
      end += 1;
    } else if (char === '-' && sql[index + 1] === '-') {
      end = sql.indexOf('\n', index);
      if (end < 0) end = sql.length;
    } else if (char === '/' && sql[index + 1] === '*') {
      end = sql.indexOf('*/', index + 2);
      end = end < 0 ? sql.length : end + 2;
    } else if (char === '"' || char === '`') {
      const close = sql.indexOf(char, index + 1);
      const stop = close < 0 ? sql.length : close + 1;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    } else {
      out += char;
      index += 1;
      continue;
    }
    out += ' '.repeat(Math.min(end, sql.length) - index);
    index = Math.min(end, sql.length);
  }
  return out;
}

/**
 * The names a statement's WITH lists define. A name counts only where it heads
 * a list entry: `x AS (` elsewhere (a WINDOW clause, a string) is not a CTE, and
 * a statement must not be able to excuse a real table by spelling one. A dotted
 * name is never a CTE.
 */
function extractCteNames(sql: string): string[] {
  const clean = blankStringsAndComments(sql);
  const ctes: string[] = [];
  for (const withMatch of clean.matchAll(/\bWITH\s+(?:RECURSIVE\s+)?/gi)) {
    let at = withMatch.index + withMatch[0].length;
    for (;;) {
      CTE_HEAD.lastIndex = at;
      const head = CTE_HEAD.exec(clean);
      if (!head) break;
      const name = normalizeSqlIdentifier(head[1]!);
      if (name && !name.includes('.')) ctes.push(name);
      // Past the entry's own parentheses: a comma means another entry.
      let depth = 1;
      at = head.index + head[0].length;
      while (at < clean.length && depth > 0) {
        if (clean[at] === '(') depth += 1;
        else if (clean[at] === ')') depth -= 1;
        at += 1;
      }
      const next = /\s*,/y;
      next.lastIndex = at;
      const comma = next.exec(clean);
      if (!comma) break;
      at = next.lastIndex;
    }
  }
  return ctes;
}

function collectSqlTables(
  node: unknown,
  state: {
    ctes: Set<string>;
    derivedRelations: Set<string>;
    tableRefs: Map<string, string>;
    aliasToRelation: Map<string, string>;
  },
  parentKey?: string,
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSqlTables(item, state, parentKey);
    return;
  }

  const obj = node as Record<string, unknown>;
  if (parentKey === 'with' || parentKey === 'cte') {
    const cteName = stringField(obj, 'name') ?? stringField(obj, 'as');
    if (cteName) state.ctes.add(normalizeSqlIdentifier(cteName));
  }

  const derivedAlias = derivedRelationAlias(obj);
  if (derivedAlias) {
    state.derivedRelations.add(derivedAlias);
    state.aliasToRelation.set(derivedAlias, derivedAlias);
  }

  const relation = relationFromTableNode(obj);
  if (relation && obj.type !== 'column_ref') {
    const normalized = normalizeSqlIdentifier(relation);
    // Some parser dialects expose a quote token as a synthetic table node for
    // a quoted CTE. An empty normalized identifier is never a real relation.
    if (normalized) {
      const alias = stringField(obj, 'as') ?? stringField(obj, 'alias') ?? relation.split('.').at(-1);
      if (alias) {
        const normalizedAlias = normalizeSqlIdentifier(alias);
        if (normalizedAlias) state.aliasToRelation.set(normalizedAlias, relation);
      }
      if (!state.ctes.has(normalized) && !isSqlFunctionRelation(relation)) {
        state.tableRefs.set(normalized, relation);
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    collectSqlTables(value, state, key);
  }
}

function collectSqlColumns(
  node: unknown,
  state: {
    ctes: Set<string>;
    derivedRelations: Set<string>;
    aliasToRelation: Map<string, string>;
    singleRelation?: string;
    columns: SqlColumnReference[];
  },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSqlColumns(item, state);
    return;
  }

  const obj = node as Record<string, unknown>;
  if (obj.type === 'column_ref') {
    const column = readColumnRefName(obj);
    if (column && column !== '*') {
      const rawTable = stringField(obj, 'table');
      const tableAlias = rawTable ? normalizeSqlIdentifier(rawTable) : undefined;
      const relation = tableAlias
        ? state.aliasToRelation.get(tableAlias) ?? rawTable
        : state.singleRelation;
      const normalizedRelation = relation ? normalizeSqlIdentifier(relation) : undefined;
      if (!relation || (!state.ctes.has(normalizedRelation!) && !state.derivedRelations.has(normalizedRelation!))) {
        state.columns.push({
          column,
          tableAlias: rawTable,
          relation,
          unqualified: !rawTable,
        });
      }
    }
    return;
  }

  for (const value of Object.values(obj)) collectSqlColumns(value, state);
}

/** Return the alias for a FROM/JOIN item backed by a nested SELECT AST. */
function derivedRelationAlias(obj: Record<string, unknown>): string | undefined {
  const expression = obj.expr;
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return undefined;
  const ast = (expression as Record<string, unknown>).ast;
  if (!ast || typeof ast !== 'object') return undefined;
  const alias = stringField(obj, 'as') ?? stringField(obj, 'alias');
  return alias ? normalizeSqlIdentifier(alias) : undefined;
}

function relationFromTableNode(obj: Record<string, unknown>): string | undefined {
  const table = stringField(obj, 'table');
  if (!table) return undefined;
  const parts = [
    stringField(obj, 'database'),
    stringField(obj, 'db'),
    stringField(obj, 'schema'),
    table,
  ].filter((part): part is string => Boolean(part));
  return parts.join('.');
}

function readStatementType(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const type = (node as { type?: unknown }).type;
  return typeof type === 'string' ? type.toLowerCase() : undefined;
}

function readColumnRefName(ref: Record<string, unknown>): string {
  const col = ref.column;
  if (typeof col === 'string') return col;
  if (col && typeof col === 'object') {
    const expr = (col as { expr?: Record<string, unknown> }).expr;
    if (expr && typeof expr === 'object') {
      const value = (expr as { value?: unknown }).value;
      if (typeof value === 'string') return value;
    }
  }
  return '';
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeSqlIdentifier(value: string): string {
  return value.replace(/["`\[\]]/g, '').replace(/\s*\.\s*/g, '.').trim().toLowerCase();
}

function isSqlFunctionRelation(relation: string): boolean {
  return /\b(read_csv_auto|read_csv|read_parquet|read_json|read_json_auto|unnest|generate_series|range)\s*\(/i.test(relation);
}

function dedupeColumnReferences(columns: SqlColumnReference[]): SqlColumnReference[] {
  const seen = new Set<string>();
  return columns.filter((column) => {
    const key = [
      column.relation ?? '',
      column.tableAlias ?? '',
      column.column.toLowerCase(),
      column.unqualified ? 'u' : 'q',
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extract DuckDB reader function calls (e.g., read_csv_auto('./data/file.csv')) */
function extractReaderFunctions(sql: string): string[] {
  const results: string[] = [];
  const pattern = /\b(read_csv_auto|read_csv|read_parquet|read_json|read_json_auto)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*[^)]*?)?\)/gi;
  for (const match of sql.matchAll(pattern)) {
    results.push(`${match[1]}('${match[2]}')`);
  }
  return results;
}

/** Extract ref("block_name") calls from SQL */
function extractRefs(sql: string): string[] {
  const refs: string[] = [];
  const refPattern = /\bref\s*\(\s*["']([^"']+)["']\s*\)/gi;
  for (const match of sql.matchAll(refPattern)) {
    refs.push(match[1]);
  }
  return refs;
}

/** Strip comments only */
/**
 * SQL functions whose argument list uses the keyword FROM (or IN) between
 * expressions: `EXTRACT(YEAR FROM d)`, `SUBSTRING(s FROM 2 FOR 3)`,
 * `TRIM(LEADING 'x' FROM s)`, `OVERLAY(s PLACING 'x' FROM 2)`,
 * `POSITION('x' IN s)`. What follows FROM there is a value, never a table.
 */
const FROM_KEYWORD_FUNCTIONS = new Set([
  'EXTRACT', 'SUBSTRING', 'SUBSTR', 'TRIM', 'OVERLAY', 'POSITION',
]);

/**
 * Blank every FROM keyword that is part of an expression rather than a FROM
 * clause, so the relation scanners never read `EXTRACT(YEAR FROM
 * game_date_est)` as `FROM game_date_est`:
 *  - FROM directly inside the parentheses of an EXTRACT/SUBSTRING/TRIM/
 *    OVERLAY/POSITION call (a subquery nested in that call keeps its own
 *    FROM, because the innermost parenthesis is then the subquery's);
 *  - FROM in `IS [NOT] DISTINCT FROM`.
 *
 * The lineage extractor stays a tolerant scanner rather than the full parser
 * because block SQL is templated (`${param}`, `ref()`, `@metric()`), which
 * node-sql-parser rejects. Offsets are preserved (FROM becomes four spaces).
 * Expects comments and string literals to have been stripped already.
 */
export function maskExpressionFromKeywords(sql: string): string {
  const token = /"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*|\(|\)/g;
  const stack: string[] = [];
  const blanks: number[] = [];
  // Recent tokens (uppercased words, or "(" / ")") for look-behind.
  const recent: string[] = [];
  let lastWordEnd = -1;
  let lastWord = '';
  for (const match of sql.matchAll(token)) {
    if (recent.length > 8) recent.splice(0, recent.length - 8);
    const text = match[0];
    const index = match.index ?? 0;
    if (text === '(') {
      // A call is a bare word immediately before "(" (whitespace allowed).
      const opener = lastWordEnd >= 0 && /^\s*$/.test(sql.slice(lastWordEnd, index)) ? lastWord : '';
      stack.push(opener);
      recent.push('(');
    } else if (text === ')') {
      stack.pop();
      recent.push(')');
    } else if (/^[A-Za-z_]/.test(text)) {
      const word = text.toUpperCase();
      if (word === 'FROM') {
        const inCall = stack.length > 0 && FROM_KEYWORD_FUNCTIONS.has(stack[stack.length - 1]!);
        const prev = recent[recent.length - 1];
        const isDistinctFrom = prev === 'DISTINCT'
          && (recent[recent.length - 2] === 'IS' || (recent[recent.length - 2] === 'NOT' && recent[recent.length - 3] === 'IS'));
        if (inCall || isDistinctFrom) blanks.push(index);
      }
      recent.push(word);
      lastWord = word;
      lastWordEnd = index + text.length;
      continue;
    } else {
      recent.push(text);
    }
    lastWordEnd = -1;
    lastWord = '';
  }
  if (blanks.length === 0) return sql;
  let out = '';
  let cursor = 0;
  for (const index of blanks) {
    out += sql.slice(cursor, index) + '    ';
    cursor = index + 4;
  }
  return out + sql.slice(cursor);
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/**
 * Strip single-quoted string literals, but preserve those inside ref() calls.
 * This ensures ref('block_name') works, while 'ref("fake")' is stripped.
 */
function stripStringLiterals(sql: string): string {
  // First, temporarily protect ref() arguments by replacing them with placeholders
  const refArgs: string[] = [];
  const withPlaceholders = sql.replace(
    /\bref\s*\(\s*'([^']*)'\s*\)/gi,
    (_match, arg: string) => {
      refArgs.push(arg);
      return `ref("__REF_PLACEHOLDER_${refArgs.length - 1}__")`;
    },
  );
  // Strip all remaining single-quoted strings
  const stripped = withPlaceholders.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // Restore ref() arguments
  return stripped.replace(
    /ref\("__REF_PLACEHOLDER_(\d+)__"\)/g,
    (_match, idx: string) => `ref('${refArgs[parseInt(idx)]}')`
  );
}

/** Extract @metric() or @dim() references from SQL */
function extractSemanticRefs(sql: string, type: 'metric' | 'dim'): string[] {
  const refs: string[] = [];
  const pattern = new RegExp(`@${type}\\s*\\(\\s*["']?([^"')]+)["']?\\s*\\)`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    refs.push(match[1].trim());
  }
  return [...new Set(refs)];
}

/**
 * Add a table reference as its unquoted, dot-joined name — the same shape
 * `analyzeSqlReferences` reports (`"main"."order_lines"` → `main.order_lines`,
 * `main."Order Lines"` → `main.Order Lines`). Case is kept as written.
 */
function addTableRef(tables: Set<string>, ref: string): void {
  const parts = Array.from(ref.matchAll(new RegExp(SQL_IDENTIFIER_PART, 'g')), (match) =>
    unquoteIdentifierPart(match[0]),
  );
  const name = parts.join('.');
  if (name.length > 0) {
    tables.add(name);
  }
}

/** Strip one identifier part's quotes and undo its doubled-quote escapes. */
function unquoteIdentifierPart(part: string): string {
  switch (part[0]) {
    case '"':
      return part.slice(1, -1).replace(/""/g, '"');
    case '`':
      return part.slice(1, -1).replace(/``/g, '`');
    case '[':
      return part.slice(1, -1).replace(/\]\]/g, ']');
    default:
      return part;
  }
}
