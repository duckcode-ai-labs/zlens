import { createHash } from 'node:crypto';

import {
  datasetAggregateComponentProofCovers,
  datasetAggregateComponentRequirements,
  datasetMeasureField,
  datasetPhysicalField,
  datasetQueryRequiresAggregateComponentEvidence,
  getDialect,
  isTileTimeGrain,
  renderDatasetAggregateExpression,
  tileQueryIsTopNIntent,
  tileQueryHash,
  tileQueryMeasureScope,
  tileQueryValidationRuns,
  validateTileQuery,
  checkTileCalculations,
  datasetJoinsUsed,
  datasetNameIdentity,
  datasetRelatedFieldsUsed,
  type DatasetDescriptor,
  type DatasetJoin,
  type DatasetPhysicalField,
  type DatasetMeasureField,
  type TileCalcExpr,
  type TileCalculation,
  type DatasetAggregateComponentProofV1,
  type DatasetMeasureAggregation,
  type TileFilterOperator,
  type TileQuery,
  type TileQueryFilter,
  type TileQueryValidation,
} from '@zlens/core';
import type { ConnectionConfig, SQLParamSpec } from '@zlens/connectors';

export class TileQueryCompilationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TileQueryCompilationError';
  }
}

export interface CompiledDatasetTileQuery {
  sql: string;
  sqlParams: SQLParamSpec[];
  variables: Record<string, unknown>;
  /** Presentation metadata is derived from the same approved fields that
   * compiled the SQL. Renderers use it instead of guessing a ratio or amount
   * from an output alias. */
  columns: Array<{
    alias: string;
    role: 'dimension' | 'measure';
    ref: string;
    type?: 'string' | 'number' | 'boolean' | 'date' | 'timestamp';
    aggregation?: DatasetMeasureAggregation;
    timeGrain?: string;
    format?: { kind: 'number' | 'currency' | 'percent'; currency?: string; decimals?: number };
    /** A tile calculation: its words for the receipt ("revenue / orders"). */
    calculation?: { kind: 'measure' | 'quick'; description: string };
  }>;
  queryFingerprint: string;
  filterFingerprint: string;
  appliedFilters: Array<{ field: string; op: TileFilterOperator; values: unknown[]; placement: 'where' | 'having' }>;
  /** The Dataset-contract outcome this SQL was compiled under (C8). */
  validation: Pick<TileQueryValidation, 'outcome' | 'adaptations'>;
  /** Joins to related tables the SQL uses (design D2), parents first; empty for the Dataset's own fields. */
  joins: DatasetJoin[];
  /**
   * Names grouped by their key (new-user round 3, problem 4): Customer Name
   * grouped by customer_id, so two customers who share a name stay two rows,
   * told apart as "Maria Lopez (#1043)". Empty when the tile groups by no name.
   */
  nameKeys: Array<{ field: string; key: string; alias: string }>;
  /** A name the tile groups by whose key ZLens does not know: it may merge namesakes. */
  nameWarnings: Array<{ field: string; entity: string; message: string }>;
}

/**
 * Compile a block-backed field tile over the block's complete result set. The
 * source block remains the governed projection; the outer query is the only
 * place that groups, filters, ranks, or limits it. This intentionally never
 * re-aggregates preview rows.
 */
export function compileDatasetTileQuery(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  sourceSql: string;
  sourceSqlParams?: SQLParamSpec[];
  sourceVariables?: Record<string, unknown>;
  filters?: TileQueryFilter[];
  having?: TileQueryFilter[];
  parameters?: Record<string, unknown>;
  /**
   * Server-created, run-owned evidence for an aggregate Dataset rollup. This
   * is intentionally an input only to the local runtime compiler; authoring
   * and browser callers cannot mint it.
   */
  aggregateComponentProof?: DatasetAggregateComponentProofV1;
  /** The run's exact binding; a proof made for any other binding does not cover. */
  aggregateComponentBinding?: { sourceId: string; sourceRevision: string; targetFingerprint: string };
  /**
   * Set only after the server parsed the actual complete source as a known
   * aggregate query. It closes a false `grain.aggregate` declaration from
   * opting an already-aggregated source out of the runtime proof gate.
   */
  aggregateSourceDetected?: boolean;
  /**
   * Group a name by its key (default on). A period comparison turns it off:
   * it matches rows of separate period queries by their labels, and a name
   * told apart in one period but not another would no longer match.
   */
  groupNamesByKey?: boolean;
  driver: ConnectionConfig['driver'] | string;
}): CompiledDatasetTileQuery {
  if (!supportedTileDialect(input.driver)) {
    throw new TileQueryCompilationError('DATASET_DIALECT_UNSUPPORTED', `Dataset tiles do not support the ${input.driver} SQL dialect.`);
  }
  // Dashboard/cross-filter mappings are compiled through the exact same
  // authority as authored filters. They must never bypass field status, type,
  // cardinality, or supported-operation validation merely because the browser
  // supplied them separately from the saved tile query.
  const effectiveQuery: TileQuery = {
    ...input.query,
    filters: [...(input.query.filters ?? []), ...(input.filters ?? [])],
    having: [...(input.query.having ?? []), ...(input.having ?? [])],
  };
  const validation = validateTileQuery(input.descriptor, effectiveQuery);
  if (!tileQueryValidationRuns(validation)) {
    const messages = validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ');
    throw new TileQueryCompilationError(
      validation.outcome === 'needs_review' ? 'DATASET_QUERY_REVIEW_REQUIRED' : 'DATASET_QUERY_REJECTED',
      messages || 'The dataset query is not covered by its approved contract.',
    );
  }
  // Structural declaration checks are deliberately not a substitute for live
  // aggregate-component evidence. Until the runtime has produced a
  // target-bound proof, even a measure labelled additive cannot roll an
  // aggregate Dataset up from its native keys/time bucket.
  const aggregateEvidenceRequired = input.aggregateSourceDetected === true
    || datasetQueryRequiresAggregateComponentEvidence(input.descriptor, effectiveQuery);
  if (aggregateEvidenceRequired) {
    const requirements = datasetAggregateComponentRequirements(input.descriptor, tileQueryMeasureScope(input.descriptor, effectiveQuery));
    if (!requirements.supported || !datasetAggregateComponentProofCovers(input.aggregateComponentProof, requirements.requirements, {
      ...input.aggregateComponentBinding,
      contractFingerprint: input.descriptor.contractRef.fingerprint,
      timeGrain: input.descriptor.grain.timeGrain ?? '',
    })) {
    throw new TileQueryCompilationError(
      'DATASET_AGGREGATE_COMPONENT_EVIDENCE_REQUIRED',
      `Aggregate Dataset ${input.descriptor.label} needs current component evidence before this rollup can run. Validate the source components against the active warehouse target.`,
    );
    }
  }
  const ownSourceSql = stripTerminator(input.sourceSql);
  if (!ownSourceSql) throw new TileQueryCompilationError('DATASET_SOURCE_EMPTY', 'The dataset source has no executable SQL.');
  const dialect = getDialect(input.driver);
  // Fields from related tables (design D2): only the joins this tile reads
  // are added, each a LEFT JOIN on a key the related table holds once, so
  // the Dataset's rows are never multiplied. A tile on the Dataset's own
  // fields compiles exactly as before.
  // A name groups by its key (Customer Name by customer_id), so namesakes are
  // never merged. The key reads the join's own key column, so it adds no join.
  const nameIdentities = input.query.detail || input.query.comparison || input.groupNamesByKey === false
    ? []
    : input.query.dimensions.flatMap((selection) => {
      if (selection.timeGrain) return [];
      const identity = datasetNameIdentity(input.descriptor, selection.field);
      return identity ? [{ selection, identity }] : [];
    });
  const keyedQuery: TileQuery = nameIdentities.some((entry) => entry.identity.key)
    ? { ...effectiveQuery, dimensions: [...effectiveQuery.dimensions, ...nameIdentities.flatMap((entry) => (entry.identity.key ? [{ field: entry.identity.key }] : []))] }
    : effectiveQuery;
  const joins = datasetJoinsUsed(input.descriptor, keyedQuery);
  const sourceSql = joins.length
    ? joinedDatasetSourceSql(ownSourceSql, joins, datasetRelatedFieldsUsed(input.descriptor, keyedQuery), input.driver, dialect.quoteIdentifier.bind(dialect))
    : ownSourceSql;
  const sourceParams = [...(input.sourceSqlParams ?? [])];
  const variables: Record<string, unknown> = { ...(input.sourceVariables ?? {}) };
  let nextPosition = sourceParams.reduce((maximum, parameter) => Math.max(maximum, parameter.position), 0);
  const sqlParams = sourceParams;
  const appliedFilters: CompiledDatasetTileQuery['appliedFilters'] = [];
  const addBoundValue = (value: unknown, prefix: string): string => {
    nextPosition += 1;
    const name = `__dataset_tile_${prefix}_${nextPosition}`;
    sqlParams.push({ name, position: nextPosition });
    variables[name] = value;
    return `$${nextPosition}`;
  };
  const quote = (identifier: string) => dialect.quoteIdentifier(identifier);
  const column = (name: string) => `ds.${sourceColumnReference(name, input.driver, quote)}`;
  const physicalExpression = (name: string): string => {
    const field = datasetPhysicalField(input.descriptor, name);
    if (!field) throw new TileQueryCompilationError('DATASET_FIELD_DRIFT', `Dataset field ${name} no longer resolves.`);
    return column(field.name);
  };

  /**
   * A bar told apart by its key ("Maria Lopez (#1043)") filters to that one
   * customer when clicked (Keep only, Exclude, a cross-filter): the name and
   * the key, never a name no row has. Other values filter by the name.
   */
  const keyedNameFilter = (filter: TileQueryFilter, expression: string): string | undefined => {
    if (!['eq', 'neq', 'in', 'not_in'].includes(filter.op) || input.groupNamesByKey === false) return undefined;
    const identity = datasetNameIdentity(input.descriptor, filter.field);
    if (!identity?.key) return undefined;
    const values = filter.values ?? [];
    const parsed = values.map((value) => (typeof value === 'string' ? /^(.*) \(#([^()]+)\)$/.exec(value) : null));
    if (!parsed.some(Boolean)) return undefined;
    const keyExpression = physicalExpression(identity.key);
    const text = (value: string) => `CAST(${value} AS ${input.driver === 'bigquery' ? 'STRING' : 'VARCHAR'})`;
    const parts = values.map((value, index) => {
      const match = parsed[index];
      if (!match) return `${expression} = ${addBoundValue(value, filter.field)}`;
      return `(${expression} = ${addBoundValue(match[1], filter.field)} AND ${text(keyExpression)} = ${addBoundValue(match[2], filter.field)})`;
    });
    const any = `(${parts.join(' OR ')})`;
    return filter.op === 'neq' || filter.op === 'not_in' ? `NOT ${any}` : any;
  };
  const whereFilters = effectiveQuery.filters ?? [];
  const havingFilters = effectiveQuery.having ?? [];
  const whereClauses = whereFilters.map((filter) => {
    const field = datasetPhysicalField(input.descriptor, filter.field);
    if (!field || field.kind !== 'physical') {
      throw new TileQueryCompilationError('DATASET_FIELD_DRIFT', `Dataset filter field ${filter.field} no longer resolves.`);
    }
    const expression = physicalExpression(filter.field);
    const keyed = keyedNameFilter(filter, expression);
    const clause = keyed ?? compileFilter(filter, expression, dialect.ilike.bind(dialect), addBoundValue, field.type, input.driver);
    appliedFilters.push({ field: filter.field, op: filter.op, values: [...(filter.values ?? [])], placement: 'where' });
    return clause;
  });

  if (input.query.detail) {
    const selectedColumns = input.query.detailColumns;
    const fields = selectedColumns?.length
      ? selectedColumns.map((column) => {
        const field = datasetPhysicalField(input.descriptor, column);
        if (!field || field.status !== 'approved') {
          throw new TileQueryCompilationError('DATASET_DETAIL_FIELD_DRIFT', `Detail column ${column} no longer resolves to an approved physical field.`);
        }
        return field;
      })
      // Rows of the Dataset show its own columns unless related ones are chosen.
      : input.descriptor.fields.filter((field): field is NonNullable<ReturnType<typeof datasetPhysicalField>> => field.kind === 'physical' && field.status === 'approved' && !field.related);
    if (fields.length === 0) throw new TileQueryCompilationError('DATASET_DETAIL_FIELDS_MISSING', 'This dataset has no approved physical fields for detail rows.');
    const limit = resolveLimit(input.query.limit, input.parameters);
    if (!limit) throw new TileQueryCompilationError('DATASET_DETAIL_LIMIT_REQUIRED', 'Detail rows require an explicit bounded row limit.');
    const keyFields = input.descriptor.grain.keyFields.map((key) => {
      const field = datasetPhysicalField(input.descriptor, key);
      if (!field || field.status !== 'approved') {
        throw new TileQueryCompilationError('DATASET_DETAIL_KEY_DRIFT', `Declared detail key ${key} no longer resolves to an approved physical field.`);
      }
      return field;
    });
    if (keyFields.length === 0) {
      throw new TileQueryCompilationError('DATASET_DETAIL_KEY_MISSING', 'Detail rows require a declared, validated dataset key.');
    }
    const selectPrefix = !dialect.limitAtEnd && limit ? `TOP ${limit} ` : '';
    const sql = [
      `WITH ds AS (${sourceSql})`,
      `SELECT ${selectPrefix}${fields.map((field) => `${column(field.name)} AS ${quote(field.name)}`).join(', ')}`,
      'FROM ds',
      ...(whereClauses.length ? [`WHERE ${whereClauses.join(' AND ')}`] : []),
      `ORDER BY ${keyFields.map((field) => `${column(field.name)} ASC`).join(', ')}`,
      ...(dialect.limitAtEnd && limit ? [dialect.limitClause(limit)] : []),
    ].join('\n');
    return compiledResult(sql, sqlParams, variables, fields.map((field) => ({
      alias: field.name,
      role: 'dimension' as const,
      ref: datasetDimensionRef(field.qualifiedId),
      type: field.type,
    })), input.query, appliedFilters, validation, joins);
  }

  const nameKeys: CompiledDatasetTileQuery['nameKeys'] = [];
  const nameWarnings: CompiledDatasetTileQuery['nameWarnings'] = [];
  const dimensions = input.query.dimensions.map((selection) => {
    const field = datasetPhysicalField(input.descriptor, selection.field);
    if (!field) throw new TileQueryCompilationError('DATASET_FIELD_DRIFT', `Dataset field ${selection.field} no longer resolves.`);
    // Validation already refused an unknown grain; this guard keeps the grain
    // out of rendered SQL even if a caller reaches here another way.
    if (selection.timeGrain !== undefined && !isTileTimeGrain(selection.timeGrain)) {
      throw new TileQueryCompilationError('DATASET_TIME_GRAIN_INVALID', `${selection.timeGrain} is not a supported time grain.`);
    }
    const alias = safeAlias(selection.alias ?? (selection.timeGrain ? `${field.name}_${selection.timeGrain}` : field.name));
    const expression = selection.timeGrain
      ? truncateToGrain(selection.timeGrain, column(field.name), field.type, input.driver, dialect)
      : column(field.name);
    const identity = nameIdentities.find((entry) => entry.selection === selection)?.identity;
    if (identity && !identity.key) {
      nameWarnings.push({ field: field.name, entity: identity.entity, message: nameWarning(field.name, identity.entity) });
    }
    if (!identity?.key) return { alias, expression, groupBy: [expression], select: expression, field, timeGrain: selection.timeGrain };
    const keyExpression = physicalExpression(identity.key);
    nameKeys.push({ field: field.name, key: identity.key, alias });
    // Grouped by the key and the name; a name two keys share shows its key.
    // MIN/MAX over the name (not COUNT DISTINCT, which PostgreSQL has no
    // window form of) also holds when the tile groups by another field too.
    const text = (value: string) => `CAST(${value} AS ${input.driver === 'bigquery' ? 'STRING' : 'VARCHAR'})`;
    const shared = `MIN(${keyExpression}) OVER (PARTITION BY ${expression}) <> MAX(${keyExpression}) OVER (PARTITION BY ${expression})`;
    const select = `CASE WHEN ${shared} THEN ${text(expression)} || ' (#' || ${text(keyExpression)} || ')' ELSE ${expression} END`;
    return { alias, expression, groupBy: [expression, keyExpression], select, field, timeGrain: selection.timeGrain };
  });
  const measures = input.query.measures.map((selection) => {
    const measure = datasetMeasureField(input.descriptor, selection.measure);
    if (!measure) throw new TileQueryCompilationError('DATASET_MEASURE_DRIFT', `Dataset measure ${selection.measure} no longer resolves.`);
    const alias = safeAlias(selection.alias ?? measure.name);
    const expression = compileMeasure(measure, physicalExpression);
    return { alias, expression, format: measure.format, logicalMeasure: measure };
  });
  // Calculations (RFC 0009 step 3). Calculated measures are aggregates at the
  // tile's grouping; quick calculations are windows over its grouped rows.
  const calculationOutputs = new Map(checkTileCalculations(input.descriptor, input.query).outputs.map((output) => [output.id.toLowerCase(), output]));
  const calculations = (input.query.calculations ?? []).map((calculation) => {
    const output = calculationOutputs.get(calculation.id.toLowerCase());
    if (!output) throw new TileQueryCompilationError('DATASET_CALCULATION_INVALID', `Calculation ${calculation.id} did not pass its checks.`);
    return { calculation, output, alias: safeAlias(calculation.id) };
  });
  const calculatedMeasures = calculations
    .filter((entry) => entry.calculation.expr)
    .map((entry) => ({
      ...entry,
      expression: compileCalcExpression(entry.calculation.expr!, input.descriptor, physicalExpression, (filter, expression, type) => compileFilter(filter, expression, dialect.ilike.bind(dialect), addBoundValue, type, input.driver)),
    }));
  const quickCalculations = calculations.filter((entry) => entry.calculation.quick);
  const aliasExpressions = new Map<string, string>([
    ...dimensions.map((dimension): [string, string] => [dimension.alias.toLowerCase(), dimension.select]),
    ...measures.map((measure): [string, string] => [measure.alias.toLowerCase(), measure.expression]),
    ...calculations.map((entry): [string, string] => [entry.alias.toLowerCase(), entry.alias]),
  ]);
  // HAVING refers to the approved logical measure identity. Presentation
  // aliases are deliberately excluded: an alias collision must never redirect
  // a measure predicate to a different expression.
  const selectedMeasureExpressions = new Map<string, string>();
  for (const measure of measures) {
    selectedMeasureExpressions.set(measure.logicalMeasure.name.toLowerCase(), measure.expression);
    selectedMeasureExpressions.set(measure.logicalMeasure.qualifiedId.toLowerCase(), measure.expression);
  }
  const havingClauses = havingFilters.map((filter) => {
    const expression = selectedMeasureExpressions.get(filter.field.toLowerCase());
    if (!expression) {
      throw new TileQueryCompilationError('DATASET_HAVING_FIELD_INVALID', `Having filter ${filter.field} does not resolve to a selected measure.`);
    }
    const clause = compileFilter(filter, expression, dialect.ilike.bind(dialect), addBoundValue, 'number', input.driver);
    appliedFilters.push({ field: filter.field, op: filter.op, values: [...(filter.values ?? [])], placement: 'having' });
    return clause;
  });
  const limit = resolveLimit(input.query.limit, input.parameters);
  const selectPrefix = !dialect.limitAtEnd && limit ? `TOP ${limit} ` : '';
  // Totals (RFC 0009 step 4): each level is regrouped by the warehouse, and a
  // flag per dimension says which rows total it, so a total of a distinct
  // count or a rate is recomputed, never summed from cells.
  const rollups = input.query.rollups?.length ? input.query.rollups : undefined;
  const dimensionByAlias = new Map(dimensions.map((dimension) => [dimension.alias.toLowerCase(), dimension]));
  const groupingSets = rollups
    ? [dimensions, ...rollups.map((set) => set.map((alias) => {
      const dimension = dimensionByAlias.get(alias.toLowerCase());
      if (!dimension) throw new TileQueryCompilationError('DATASET_TOTALS_INVALID', `The total level names ${alias}, which is not a dimension on this tile.`);
      return dimension;
    }))]
    : undefined;
  const selectColumns = [
    ...dimensions.map((dimension) => `${dimension.select} AS ${quote(dimension.alias)}`),
    ...measures.map((measure) => `${measure.expression} AS ${quote(measure.alias)}`),
    ...calculatedMeasures.map((entry) => `${entry.expression} AS ${quote(entry.alias)}`),
    ...(rollups ? dimensions.map((dimension) => `GROUPING(${dimension.expression}) AS ${quote(`__total_${dimension.alias}`)}`) : []),
  ];
  const orderBy = (input.query.orderBy ?? []).map((order) => {
    const alias = safeAlias(order.alias);
    if (!aliasExpressions.has(alias.toLowerCase())) {
      throw new TileQueryCompilationError('DATASET_ORDER_FIELD_INVALID', `Order field ${order.alias} is not selected by this tile.`);
    }
    return `${quote(alias)} ${order.direction.toUpperCase()}`;
  });
  // A bounded measure-first entity query is Top-N intent. The primary metric
  // sort expresses business rank; the selected dimensions establish a stable
  // total order for ties. Ordinary chronological/dimension sorting and scalar
  // safety caps deliberately keep their authored ordering untouched.
  if (tileQueryIsTopNIntent(input.query)) {
    const orderedAliases = new Set((input.query.orderBy ?? []).map((order) => order.alias.toLowerCase()));
    for (const dimension of dimensions) {
      if (orderedAliases.has(dimension.alias.toLowerCase())) continue;
      orderBy.push(`${quote(dimension.alias)} ASC`);
      orderedAliases.add(dimension.alias.toLowerCase());
    }
  } else if (!orderBy.length) {
    // With no authored order, a time series reads chronologically. Without
    // this the rows come back in the warehouse's GROUP BY hash order, which
    // DuckDB 1.5 does not keep stable from run to run.
    for (const dimension of dimensions) {
      if (dimension.timeGrain) orderBy.push(`${quote(dimension.alias)} ASC`);
    }
  }
  const grouped = [
    'FROM ds',
    ...(whereClauses.length ? [`WHERE ${whereClauses.join(' AND ')}`] : []),
    ...(groupingSets
      ? [`GROUP BY GROUPING SETS (${groupingSets.map((set) => `(${set.flatMap((dimension) => dimension.groupBy).join(', ')})`).join(', ')})`]
      : dimensions.length ? [`GROUP BY ${dimensions.flatMap((dimension) => dimension.groupBy).join(', ')}`] : []),
    ...(havingClauses.length ? [`HAVING ${havingClauses.join(' AND ')}`] : []),
  ];
  const tail = [
    ...(orderBy.length ? [`ORDER BY ${orderBy.join(', ')}`] : []),
    ...(dialect.limitAtEnd && limit ? [dialect.limitClause(limit)] : []),
  ];
  let sql: string;
  if (quickCalculations.length === 0) {
    sql = [`WITH ds AS (${sourceSql})`, `SELECT ${selectPrefix}${selectColumns.join(', ')}`, ...grouped, ...tail].join('\n');
  } else {
    // Quick calculations run over the grouped rows, before the row limit, so a
    // share of total or a rank covers every group, not only the rows shown.
    const windowed = compileQuickCalculations({
      calculations: quickCalculations,
      dimensions,
      driver: input.driver,
      quote,
    });
    const outputs = [
      ...dimensions.map((dimension) => dimension.alias),
      ...measures.map((measure) => measure.alias),
      ...calculatedMeasures.map((entry) => entry.alias),
    ].map((alias) => `b.${quote(alias)} AS ${quote(alias)}`);
    sql = [
      `WITH ds AS (${sourceSql}),`,
      `__base AS (SELECT ${selectColumns.join(', ')}`,
      ...grouped,
      ')',
      `SELECT ${selectPrefix}${[...outputs, ...windowed.columns].join(', ')}`,
      'FROM __base b',
      ...windowed.joins,
      ...tail,
    ].join('\n');
  }
  return compiledResult(sql, sqlParams, variables, [
    ...dimensions.map((dimension) => ({
      alias: dimension.alias,
      role: 'dimension' as const,
      ref: datasetDimensionRef(dimension.field.qualifiedId),
      type: dimension.field.type,
      ...(dimension.timeGrain ? { timeGrain: dimension.timeGrain } : {}),
    })),
    ...measures.map((measure) => ({
      alias: measure.alias,
      role: 'measure' as const,
      ref: datasetMeasureRef(measure.logicalMeasure.qualifiedId, measure.logicalMeasure.metricId),
      aggregation: measure.logicalMeasure.aggregation,
      ...(measure.format ? { format: measure.format } : {}),
    })),
    ...calculations.map((entry) => ({
      alias: entry.alias,
      role: 'measure' as const,
      ref: `calculation:${entry.alias}`,
      format: entry.output.format,
      calculation: { kind: entry.output.kind, description: entry.output.description },
    })),
    ...(rollups ? dimensions.map((dimension) => ({
      alias: `__total_${dimension.alias}`,
      role: 'dimension' as const,
      ref: `total:${dimension.alias}`,
      type: 'number' as const,
    })) : []),
  ], input.query, appliedFilters, validation, joins, { nameKeys, nameWarnings });
}

/** "Customer Name may not be unique: …" — a name grouped without a key. */
export function nameWarning(field: string, entity: string): string {
  const label = field.replace(/^.*__/, '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const many = entity.endsWith('s') ? entity : entity.endsWith('y') && !/[aeiou]y$/.test(entity) ? `${entity.slice(0, -1)}ies` : `${entity}s`;
  return `${label} may not be unique: different ${many} with the same name are shown as one, and this data has no ${entity} key to tell them apart.`;
}

const SAFE_RELATION = /^(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)){0,2}$/;

/**
 * The Dataset's complete source with the related tables a tile reads joined
 * on: every source row once, plus the related columns it uses under their
 * field names. The joins come from the server's descriptor, never a request.
 */
function joinedDatasetSourceSql(
  sourceSql: string,
  joins: DatasetJoin[],
  fields: DatasetPhysicalField[],
  driver: string,
  quote: (identifier: string) => string,
): string {
  const column = (name: string) => sourceColumnReference(name, driver, quote);
  const alias = (join: DatasetJoin) => `__dql_j_${join.id}`;
  const byId = new Map(joins.map((join) => [join.id, join]));
  for (const join of joins) {
    if (!SAFE_RELATION.test(join.relation.trim())) {
      throw new TileQueryCompilationError('DATASET_JOIN_INVALID', `The related table ${join.table} is not a plain table name.`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(join.id) || join.keys.some((pair) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair.from) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair.to))) {
      throw new TileQueryCompilationError('DATASET_JOIN_INVALID', `The join to ${join.table} does not name plain columns.`);
    }
    if (join.parent && !byId.has(join.parent)) {
      throw new TileQueryCompilationError('DATASET_JOIN_INVALID', `The join to ${join.table} starts from a join this tile does not use.`);
    }
  }
  const selected = fields.map((field) => {
    const join = byId.get(field.related!.join);
    if (!join || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.related!.column)) {
      throw new TileQueryCompilationError('DATASET_FIELD_DRIFT', `Related field ${field.name} no longer resolves to a join.`);
    }
    return `${alias(join)}.${column(field.related!.column)} AS ${column(field.name)}`;
  });
  return [
    `SELECT __dql_base.*${selected.length ? `, ${selected.join(', ')}` : ''}`,
    `FROM (${sourceSql}) AS __dql_base`,
    ...joins.map((join) => {
      const parent = join.parent ? alias(byId.get(join.parent)!) : '__dql_base';
      const on = join.keys.map((pair) => `${parent}.${column(pair.from)} = ${alias(join)}.${column(pair.to)}`).join(' AND ');
      return `LEFT JOIN ${join.relation.trim()} AS ${alias(join)} ON ${on}`;
    }),
  ].join('\n');
}

/**
 * A calculated measure's SQL. Every measure reference is that measure's own
 * governed aggregate; division is a ratio of aggregates with a NULL for a zero
 * denominator; a `where` restricts the aggregate's input rows with a CASE.
 */
function compileCalcExpression(
  expr: TileCalcExpr,
  descriptor: DatasetDescriptor,
  physicalExpression: (name: string) => string,
  condition: (filter: TileQueryFilter, expression: string, type: 'string' | 'number' | 'boolean' | 'date' | 'timestamp') => string,
): string {
  if ('number' in expr) {
    if (!Number.isFinite(expr.number)) throw new TileQueryCompilationError('DATASET_CALCULATION_INVALID', 'A calculation constant must be a finite number.');
    return expr.number < 0 ? `(${String(expr.number)})` : String(expr.number);
  }
  if ('measure' in expr) {
    const measure = datasetMeasureField(descriptor, expr.measure);
    if (!measure) throw new TileQueryCompilationError('DATASET_MEASURE_DRIFT', `Dataset measure ${expr.measure} no longer resolves.`);
    if (!expr.where?.length) return compileMeasure(measure, physicalExpression);
    const when = expr.where.map((filter) => {
      const field = datasetPhysicalField(descriptor, filter.field);
      if (!field) throw new TileQueryCompilationError('DATASET_FIELD_DRIFT', `Dataset field ${filter.field} no longer resolves.`);
      return condition(filter, physicalExpression(field.name), field.type);
    }).join(' AND ');
    return compileRestrictedMeasure(measure, physicalExpression, when);
  }
  const left = compileCalcExpression(expr.left, descriptor, physicalExpression, condition);
  const right = compileCalcExpression(expr.right, descriptor, physicalExpression, condition);
  if (expr.op === '/') return `((1.0 * ${left}) / NULLIF(${right}, 0))`;
  return `(${left} ${expr.op} ${right})`;
}

function compileRestrictedMeasure(
  measure: DatasetMeasureField,
  physicalExpression: (name: string) => string,
  when: string,
): string {
  const only = (column: string) => `CASE WHEN ${when} THEN ${physicalExpression(column)} END`;
  if (measure.expression) {
    throw new TileQueryCompilationError('DATASET_CALCULATION_INVALID', `${measure.name} is a formula measure and cannot be restricted to some rows.`);
  }
  if (measure.aggregation === 'ratio') {
    const numerator = only(requiredMeasureInput(measure.numerator, measure.name));
    const denominator = only(requiredMeasureInput(measure.denominator, measure.name));
    return `((1.0 * SUM(${numerator})) / NULLIF(SUM(${denominator}), 0))`;
  }
  const input = only(requiredMeasureInput(measure.from, measure.name));
  if (measure.aggregation === 'count_distinct') return `COUNT(DISTINCT ${input})`;
  if (measure.aggregation === 'sum' || measure.aggregation === 'count' || measure.aggregation === 'avg' || measure.aggregation === 'min' || measure.aggregation === 'max') {
    return `${measure.aggregation.toUpperCase()}(${input})`;
  }
  throw new TileQueryCompilationError('DATASET_MEASURE_UNSUPPORTED', `Measure ${measure.name} uses an unsupported aggregation.`);
}

/**
 * Window expressions for quick calculations over the grouped rows `b`. A
 * calculation runs along one dimension (ordered) and restarts for each value
 * of the others; percent of total and rank cover the whole table unless
 * `within` names a dimension to restart on. Year over year joins each row to
 * the same period a year earlier rather than counting rows back, so a missing
 * month never shifts the comparison.
 */
function compileQuickCalculations(input: {
  calculations: Array<{ calculation: TileCalculation; alias: string }>;
  dimensions: Array<{ alias: string; timeGrain?: string }>;
  driver: string;
  quote: (identifier: string) => string;
}): { columns: string[]; joins: string[] } {
  const { quote } = input;
  const column = (table: string, alias: string) => `${table}.${quote(alias)}`;
  const find = (alias: string | undefined) => (alias ? input.dimensions.find((dimension) => dimension.alias.toLowerCase() === alias.toLowerCase()) : undefined);
  const columns: string[] = [];
  const joins: string[] = [];
  input.calculations.forEach(({ calculation, alias }, index) => {
    const quick = calculation.quick!;
    const value = column('b', safeAlias(quick.of));
    const within = find(quick.within);
    const along = find(quick.along) ?? input.dimensions.find((dimension) => dimension.timeGrain) ?? input.dimensions[0];
    const partitionOf = (dimensions: Array<{ alias: string }>) => (dimensions.length ? `PARTITION BY ${dimensions.map((dimension) => column('b', dimension.alias)).join(', ')} ` : '');
    let expression: string;
    if (quick.kind === 'percent_of_total') {
      expression = `((1.0 * ${value}) / NULLIF(SUM(${value}) OVER (${partitionOf(within ? [within] : []).trim()}), 0))`;
    } else if (quick.kind === 'rank') {
      expression = `RANK() OVER (${partitionOf(within ? [within] : [])}ORDER BY ${value} DESC NULLS LAST)`;
    } else {
      if (!along) throw new TileQueryCompilationError('DATASET_CALCULATION_INVALID', `${calculation.id} needs a dimension to run along.`);
      const others = input.dimensions.filter((dimension) => dimension !== along);
      const window = `${partitionOf(others)}ORDER BY ${column('b', along.alias)} ASC`;
      if (quick.kind === 'running_total') {
        expression = `SUM(${value}) OVER (${window} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
      } else if (quick.kind === 'difference') {
        expression = `(${value} - LAG(${value}) OVER (${window}))`;
      } else if (quick.kind === 'percent_difference') {
        const previous = `LAG(${value}) OVER (${window})`;
        expression = `((1.0 * (${value} - ${previous})) / NULLIF(ABS(${previous}), 0))`;
      } else if (quick.kind === 'moving_average') {
        expression = `AVG(${value}) OVER (${window} ROWS BETWEEN ${(quick.window ?? 3) - 1} PRECEDING AND CURRENT ROW)`;
      } else {
        const prior = `__yoy_${index + 1}`;
        const grain = along.timeGrain;
        if (grain !== 'month' && grain !== 'quarter' && grain !== 'year') {
          throw new TileQueryCompilationError('DATASET_CALCULATION_INVALID', 'Year over year needs a date by month, quarter or year.');
        }
        const part = (table: string, name: 'YEAR' | 'MONTH' | 'QUARTER') => `EXTRACT(${name} FROM ${column(table, along.alias)})`;
        const matches = [
          `${part(prior, 'YEAR')} = ${part('b', 'YEAR')} - 1`,
          ...(grain === 'month' ? [`${part(prior, 'MONTH')} = ${part('b', 'MONTH')}`] : []),
          ...(grain === 'quarter' ? [`${part(prior, 'QUARTER')} = ${part('b', 'QUARTER')}`] : []),
          ...others.map((dimension) => `(${column(prior, dimension.alias)} = ${column('b', dimension.alias)} OR (${column(prior, dimension.alias)} IS NULL AND ${column('b', dimension.alias)} IS NULL))`),
        ];
        joins.push(`LEFT JOIN __base ${prior} ON ${matches.join(' AND ')}`);
        const before = column(prior, safeAlias(quick.of));
        expression = `((1.0 * (${value} - ${before})) / NULLIF(ABS(${before}), 0))`;
      }
    }
    columns.push(`${expression} AS ${quote(alias)}`);
  });
  return { columns, joins };
}

/**
 * A reference to a column of the source block's result. Snowflake folds an
 * unquoted identifier to upper case, so a block that selects `region` exposes
 * `REGION`; quoting the authored lower-case name would miss it. A plain
 * identifier is therefore left unquoted there (and resolves the same way the
 * block's own SQL did). Output aliases stay quoted so result columns keep the
 * authored spelling.
 */
export function sourceColumnReference(name: string, driver: string, quote: (identifier: string) => string): string {
  return driver === 'snowflake' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : quote(name);
}

/**
 * Dialect time truncation for a validated grain. BigQuery needs
 * TIMESTAMP_TRUNC for timestamps (DATE_TRUNC is the DATE form), and its WEEK
 * starts on Sunday unless told otherwise; the other supported dialects start
 * weeks on Monday, so BigQuery is pinned to WEEK(MONDAY) to agree with them.
 */
function truncateToGrain(
  grain: string,
  columnSql: string,
  fieldType: string,
  driver: string,
  dialect: ReturnType<typeof getDialect>,
): string {
  if (driver === 'bigquery') {
    const part = grain === 'week' ? 'WEEK(MONDAY)' : grain.toUpperCase();
    return fieldType === 'date' ? `DATE_TRUNC(${columnSql}, ${part})` : `TIMESTAMP_TRUNC(${columnSql}, ${part})`;
  }
  return dialect.dateTrunc(grain, columnSql);
}

function compiledResult(
  sql: string,
  sqlParams: SQLParamSpec[],
  variables: Record<string, unknown>,
  columns: CompiledDatasetTileQuery['columns'],
  query: TileQuery,
  appliedFilters: CompiledDatasetTileQuery['appliedFilters'],
  validation: TileQueryValidation,
  joins: DatasetJoin[] = [],
  names: Pick<CompiledDatasetTileQuery, 'nameKeys' | 'nameWarnings'> = { nameKeys: [], nameWarnings: [] },
): CompiledDatasetTileQuery {
  return {
    validation: { outcome: validation.outcome, adaptations: validation.adaptations },
    joins,
    nameKeys: names.nameKeys,
    nameWarnings: names.nameWarnings,
    sql,
    sqlParams,
    variables,
    columns,
    queryFingerprint: tileQueryHash(query),
    filterFingerprint: `sha256:${createHash('sha256').update(JSON.stringify(appliedFilters.map((filter) => ({ ...filter, values: [...filter.values] })))).digest('hex')}`,
    appliedFilters,
  };
}

function compileMeasure(
  measure: NonNullable<ReturnType<typeof datasetMeasureField>>,
  physicalExpression: (name: string) => string,
): string {
  if (measure.expression) {
    if (!measure.expressionFingerprint) {
      throw new TileQueryCompilationError('DATASET_CALCULATED_MEASURE_UNBOUND', `Calculated measure ${measure.name} has no reviewed expression fingerprint.`);
    }
    return renderDatasetAggregateExpression(measure.expression, { physicalField: physicalExpression });
  }
  if (measure.aggregation === 'sum') return `SUM(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'count') return `COUNT(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'count_distinct') return `COUNT(DISTINCT ${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'ratio') {
    const numerator = physicalExpression(requiredMeasureInput(measure.numerator, measure.name));
    const denominator = physicalExpression(requiredMeasureInput(measure.denominator, measure.name));
    // Ratios remain 0..1. `1.0 *` deliberately promotes integer aggregates
    // before division for SQLite, DuckDB, PostgreSQL-family, SQL Server, and
    // the warehouse dialects DQL supports. Without it, SQLite and some
    // PostgreSQL-style integer paths silently truncate 1/4 to 0. The NULLIF
    // is kept on the denominator so zero and all-null denominator groups yield
    // NULL rather than a fabricated zero or an execution error.
    return `((1.0 * SUM(${numerator})) / NULLIF(SUM(${denominator}), 0))`;
  }
  if (measure.aggregation === 'avg') return `AVG(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'min') return `MIN(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'max') return `MAX(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  throw new TileQueryCompilationError('DATASET_MEASURE_UNSUPPORTED', `Measure ${measure.name} uses an unsupported aggregation.`);
}

function datasetDimensionRef(qualifiedId: string): string {
  return qualifiedId.startsWith('dimension:') || qualifiedId.startsWith('entity:')
    ? qualifiedId
    : `dimension:${qualifiedId}`;
}

function datasetMeasureRef(qualifiedId: string, metricId?: string): string {
  if (metricId) return metricId.startsWith('metric:') ? metricId : `metric:${metricId}`;
  return qualifiedId.startsWith('measure:') || qualifiedId.startsWith('metric:')
    ? qualifiedId
    : `measure:${qualifiedId}`;
}

function requiredMeasureInput(value: string | undefined, measure: string): string {
  if (!value?.trim()) throw new TileQueryCompilationError('DATASET_MEASURE_INPUT_MISSING', `Measure ${measure} is missing its approved physical input.`);
  return value;
}

function compileFilter(
  filter: TileQueryFilter,
  expression: string,
  ilike: (column: string, pattern: string) => string,
  addBoundValue: (value: unknown, prefix: string) => string,
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'timestamp',
  driver: string,
): string {
  const values = filter.values ?? [];
  const bind = (value: unknown) => typedFilterParameter(addBoundValue(value, filter.field), fieldType, driver);
  if (filter.op === 'eq') return `${expression} = ${bind(values[0])}`;
  if (filter.op === 'neq') return `${expression} <> ${bind(values[0])}`;
  if (filter.op === 'gt') return `${expression} > ${bind(values[0])}`;
  if (filter.op === 'gte') return `${expression} >= ${bind(values[0])}`;
  if (filter.op === 'lt') return `${expression} < ${bind(values[0])}`;
  if (filter.op === 'lte') return `${expression} <= ${bind(values[0])}`;
  if (filter.op === 'between') return `${expression} BETWEEN ${bind(values[0])} AND ${bind(values[1])}`;
  if (filter.op === 'contains') {
    // Tile filters are literal user search text, never an implicit wildcard
    // language, and the escaped value is bound so quotes remain data. BigQuery
    // has no ESCAPE clause: its LIKE escapes with a backslash. Every other
    // supported dialect takes an explicit escape character.
    if (driver.trim().toLowerCase() === 'bigquery') {
      return ilike(expression, addBoundValue(`%${escapeLikeLiteral(String(values[0]), '\\')}%`, filter.field));
    }
    return `${ilike(expression, addBoundValue(`%${escapeLikeLiteral(String(values[0]), '!')}%`, filter.field))} ESCAPE '!'`;
  }
  const placeholders = values.map(bind);
  return `${expression} ${filter.op === 'in' ? 'IN' : 'NOT IN'} (${placeholders.join(', ')})`;
}

/**
 * Node DuckDB binds ISO instants as VARCHAR values. A raw timestamp comparison
 * therefore fails before the governed predicate can run. Cast only typed
 * temporal Dataset fields; string/number/boolean bindings remain untouched.
 * The rendering is deliberately dialect-specific where a warehouse has no
 * portable TIMESTAMP spelling.
 */
function typedFilterParameter(
  placeholder: string,
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'timestamp',
  driver: string,
): string {
  const normalizedDriver = driver.trim().toLowerCase();
  if (fieldType === 'date') return normalizedDriver === 'sqlite' ? `date(${placeholder})` : `CAST(${placeholder} AS DATE)`;
  if (fieldType !== 'timestamp') return placeholder;
  if (normalizedDriver === 'sqlite') return `datetime(${placeholder})`;
  if (normalizedDriver === 'mysql') return `CAST(${placeholder} AS DATETIME)`;
  if (normalizedDriver === 'mssql' || normalizedDriver === 'fabric') return `CAST(${placeholder} AS DATETIME2)`;
  return `CAST(${placeholder} AS TIMESTAMP)`;
}

function escapeLikeLiteral(value: string, escape: '!' | '\\'): string {
  return value.replaceAll(escape, `${escape}${escape}`).replaceAll('%', `${escape}%`).replaceAll('_', `${escape}_`);
}

function resolveLimit(limit: TileQuery['limit'], parameters: Record<string, unknown> | undefined): number | undefined {
  if (limit === undefined) return undefined;
  const value = typeof limit === 'number' ? limit : parameters?.[limit.param];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TileQueryCompilationError('DATASET_LIMIT_INVALID', 'Tile limit must resolve to an integer from 1 through 10,000.');
  }
  return value;
}

function safeAlias(value: string): string {
  const alias = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new TileQueryCompilationError('DATASET_ALIAS_INVALID', `Tile alias ${value} is not a safe identifier.`);
  }
  return alias;
}

/**
 * Dialects whose rendered tile SQL (DATE_TRUNC, ILIKE/LIKE escaping, typed
 * temporal parameters, LIMIT) is pinned by golden tests in
 * tile-query-compiler.test.ts. Others refuse with a typed error rather than
 * run SQL nobody has checked: ClickHouse rejects `CAST(… AS TIMESTAMP)`,
 * SQL Server and MySQL truncate dates differently, and so on. Widen this list
 * only together with a golden for the dialect.
 */
export const DATASET_TILE_DIALECTS: readonly string[] = ['duckdb', 'file', 'postgresql', 'redshift', 'snowflake', 'bigquery'];

function supportedTileDialect(driver: string): boolean {
  return DATASET_TILE_DIALECTS.includes(driver);
}

function stripTerminator(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}
