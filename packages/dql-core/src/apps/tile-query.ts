import {
  datasetMeasureField,
  datasetPhysicalField,
  type DatasetDescriptor,
  type DatasetMeasureField,
  type DatasetPhysicalField,
} from '../datasets/descriptor.js';
import { datasetAggregateComponentRequirements } from '../datasets/component-proof.js';
import { savedQueryResultRollup } from '../datasets/result-fields.js';
import { sha256Hex } from './sha256-sync.js';
import { checkTileCalculations, normalizeTileCalculations, tileCalcMeasureReferences } from './tile-calcs.js';

import type {
  TileFilterOperator,
  TileQueryDimension,
  TileQueryMeasure,
  TileQueryFilter,
  TileQueryComparisonPeriod,
  TileQueryComparison,
  TileQuery,
} from './tile-query-types.js';

export type {
  TileCalcExpr,
  TileCalculation,
  TileQuickCalcKind,
  TileFilterOperator,
  TileQueryDimension,
  TileQueryMeasure,
  TileQueryFilter,
  TileQueryComparisonPeriod,
  TileQueryComparison,
  TileQuery,
} from './tile-query-types.js';

/**
 * A Dataset query is executable independently of its presentation, but scalar
 * visualizations cannot faithfully display a field selection with more than
 * one output. Keep this browser-safe contract next to the query shape so
 * Studio, publication, and server execution make the same decision.
 */
export type DatasetTileVisualizationIssueCode =
  | 'SCALAR_MEASURE_COUNT'
  | 'SCALAR_GROUPING_UNSUPPORTED'
  | 'SCALAR_DETAIL_UNSUPPORTED'
  | 'SCALAR_COMPARISON_UNSUPPORTED'
  | 'DETAIL_REQUIRES_TABLE';

export type DatasetTileVisualizationCompatibility = {
  compatible: boolean;
  code?: DatasetTileVisualizationIssueCode;
  message?: string;
  /** Authoring may retain the query and recover to this non-lossy view. */
  recoveryVisualization?: 'table';
};

const SCALAR_DATASET_VISUALIZATIONS = new Set(['single_value', 'kpi', 'gauge']);

/**
 * Field-based Dataset tiles must never silently discard a selected measure or
 * grouped result merely because a scalar visualization was chosen. This is a
 * presentation invariant, deliberately separate from source-operation
 * authority in validateTileQuery().
 */
export function datasetTileVisualizationCompatibility(
  query: TileQuery,
  visualization: string | undefined,
): DatasetTileVisualizationCompatibility {
  const normalizedVisualization = visualization?.trim().toLowerCase() ?? '';
  if (query.detail) {
    if (normalizedVisualization === 'table') return { compatible: true };
    return {
      compatible: false,
      code: normalizedVisualization && SCALAR_DATASET_VISUALIZATIONS.has(normalizedVisualization)
        ? 'SCALAR_DETAIL_UNSUPPORTED'
        : 'DETAIL_REQUIRES_TABLE',
      message: 'Bounded row details require a Table visualization.',
      recoveryVisualization: 'table',
    };
  }
  if (query.comparison && SCALAR_DATASET_VISUALIZATIONS.has(normalizedVisualization)) {
    return {
      compatible: false,
      code: 'SCALAR_COMPARISON_UNSUPPORTED',
      message: 'A period comparison returns current, prior, and change outputs. Use a Table or chart to show them together.',
      recoveryVisualization: 'table',
    };
  }
  if (!SCALAR_DATASET_VISUALIZATIONS.has(normalizedVisualization)) return { compatible: true };
  // One number: one selected measure or one calculated measure.
  const measureOutputs = query.measures.length + (query.calculations?.length ?? 0);
  if (measureOutputs !== 1) {
    return {
      compatible: false,
      code: 'SCALAR_MEASURE_COUNT',
      message: 'A Single Value or KPI Dataset tile requires exactly one selected measure. Use a Table to show all selected measures.',
      recoveryVisualization: 'table',
    };
  }
  // A KPI may carry one date: it shows the latest period, its change and the trend.
  const trend = query.dimensions.length === 1 && Boolean(query.dimensions[0]!.timeGrain);
  if (query.dimensions.length > 0 && !trend) {
    return {
      compatible: false,
      code: 'SCALAR_GROUPING_UNSUPPORTED',
      message: 'A Single Value or KPI Dataset tile can group only by one date, for its trend. Use a Table to show grouped results.',
      recoveryVisualization: 'table',
    };
  }
  return { compatible: true };
}

export type TileQueryValidationOutcome = 'covered' | 'adapted' | 'needs_review' | 'rejected';

export interface TileQueryDiagnostic {
  code:
    | 'UNKNOWN_FIELD'
    | 'UNKNOWN_MEASURE'
    | 'SUGGESTED_FIELD'
    | 'SUGGESTED_MEASURE'
    | 'INVALID_DIMENSION_ROLE'
    | 'INVALID_FILTER_FIELD'
    | 'UNSUPPORTED_OPERATION'
    | 'DETAIL_UNSUPPORTED'
    | 'DETAIL_LIMIT_REQUIRED'
    | 'INVALID_DETAIL_FIELD'
    | 'AGGREGATE_GRAIN_EVIDENCE_REQUIRED'
    | 'AGGREGATE_TIME_BUCKET_REQUIRED'
    | 'NON_ADDITIVE_AGGREGATE_ROLLUP'
    | 'NON_ADDITIVE_RESULT_ROLLUP'
    | 'NON_ADDITIVE_TIME_ROLLUP'
    | 'TIME_GRAIN_BELOW_SOURCE_GRAIN'
    | 'INVALID_TIME_GRAIN'
    | 'INVALID_COMPARISON'
    | 'HIERARCHY_DRILL_UNSUPPORTED'
    | 'INVALID_LIMIT'
    | 'INVALID_CALCULATION'
    | 'INVALID_TOTALS'
    | 'INVALID_QUERY';
  message: string;
  field?: string;
}

/**
 * A permitted adaptation of the Dataset contract (C8 `adapted`). The query is
 * still inside the approved contract, but its result is not a straight read of
 * the Dataset grain: it re-aggregates an already-aggregated source. The kind is
 * recorded on receipts and disclosed next to the result.
 */
export interface TileQueryAdaptation {
  kind: 'aggregate_time_rollup' | 'aggregate_entity_rollup' | 'saved_query_rollup';
  message: string;
}

export interface TileQueryValidation {
  outcome: TileQueryValidationOutcome;
  diagnostics: TileQueryDiagnostic[];
  adaptations: TileQueryAdaptation[];
}

/**
 * Whether a validated tile may execute without a review lane. `covered` and
 * `adapted` both run; `needs_review` and `rejected` never do.
 */
export function tileQueryValidationRuns(validation: Pick<TileQueryValidation, 'outcome'> | undefined): boolean {
  return validation?.outcome === 'covered' || validation?.outcome === 'adapted';
}

export type DatasetHierarchyDrillResult =
  | {
      status: 'ready';
      hierarchyId: string;
      fromField: string;
      toField: string;
      query: TileQuery;
    }
  | {
      status: 'blocked';
      code: 'HIERARCHY_UNKNOWN' | 'HIERARCHY_PATH_AMBIGUOUS' | 'HIERARCHY_LEVEL_UNSUPPORTED' | 'HIERARCHY_SELECTION_INVALID';
      message: string;
    };

const FILTER_OPERATORS = new Set<TileFilterOperator>(['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'contains']);
const TIME_GRAINS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const;

export type TileTimeGrain = typeof TIME_GRAINS[number];

/**
 * The closed time-grain vocabulary. A grain is rendered into dialect SQL
 * (`DATE_TRUNC('<grain>', …)`), and the grain-order checks below compare
 * positions in this list, so an unknown spelling must be refused — never
 * interpolated, and never allowed to disable the finer-than-source and
 * non-additive rollup checks by having no position.
 */
export function isTileTimeGrain(value: unknown): value is TileTimeGrain {
  return typeof value === 'string' && (TIME_GRAINS as readonly string[]).includes(value);
}

/**
 * Presentation aliases name selected output columns. They are deliberately a
 * different namespace from logical field and measure identities: `HAVING`
 * resolves a logical measure, while `ORDER BY` resolves one of these outputs.
 */
export function tileQueryOutputAliases(query: TileQuery): Array<{ alias: string; kind: 'dimension' | 'measure' }> {
  if (query.detail) {
    return (query.detailColumns ?? []).map((column) => ({ alias: column, kind: 'dimension' as const }));
  }
  return [
    ...query.dimensions.map((dimension) => ({
      alias: dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field),
      kind: 'dimension' as const,
    })),
    ...query.measures.map((measure) => ({ alias: measure.alias ?? measure.measure, kind: 'measure' as const })),
    ...(query.calculations ?? []).map((calculation) => ({ alias: calculation.id, kind: 'measure' as const })),
  ];
}

/**
 * A result cap or presentation sort is not automatically a ranking request.
 * Top-N requires all three explicit pieces of intent: a bounded result, an
 * entity grouping, and a selected measure used as the primary sort.
 */
export function tileQueryIsTopNIntent(query: TileQuery): boolean {
  if (query.limit === undefined || !query.dimensions.some((dimension) => !dimension.timeGrain)) return false;
  const measureAliases = new Set(tileQueryOutputAliases(query)
    .filter((output) => output.kind === 'measure')
    .map((output) => output.alias.toLowerCase()));
  return Boolean(query.orderBy?.[0] && measureAliases.has(query.orderBy[0].alias.toLowerCase()));
}

export function normalizeTileQuery(value: unknown): TileQuery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!hasOnlyKeys(raw, ['dimensions', 'measures', 'calculations', 'rollups', 'filters', 'having', 'comparison', 'orderBy', 'limit', 'detail', 'detailColumns', 'respectsGlobalFilters'])) return undefined;
  if (hasOwn(raw, 'filters') && !Array.isArray(raw.filters)) return undefined;
  if (hasOwn(raw, 'having') && !Array.isArray(raw.having)) return undefined;
  if (hasOwn(raw, 'orderBy') && !Array.isArray(raw.orderBy)) return undefined;
  const dimensions = normalizeDimensions(raw.dimensions);
  const measures = normalizeMeasures(raw.measures);
  if (!dimensions || !measures) return undefined;
  const calculations = raw.calculations === undefined ? undefined : normalizeTileCalculations(raw.calculations);
  if (raw.calculations !== undefined && !calculations) return undefined;
  const rollups = raw.rollups === undefined ? undefined : normalizeRollups(raw.rollups);
  if (raw.rollups !== undefined && !rollups) return undefined;
  const filters = normalizeFilters(raw.filters);
  const having = normalizeFilters(raw.having);
  if ((raw.filters !== undefined && !filters) || (raw.having !== undefined && !having)) return undefined;
  const comparison = raw.comparison === undefined ? undefined : normalizeComparison(raw.comparison);
  if (raw.comparison !== undefined && !comparison) return undefined;
  const orderBy = normalizeOrderBy(raw.orderBy);
  if (raw.orderBy !== undefined && !orderBy) return undefined;
  const limit = normalizeLimit(raw.limit);
  if (raw.limit !== undefined && limit === undefined) return undefined;
  if (hasOwn(raw, 'detail') && typeof raw.detail !== 'boolean') return undefined;
  const detailColumns = normalizeDetailColumns(raw.detailColumns);
  if (raw.detailColumns !== undefined && !detailColumns) return undefined;
  if (hasOwn(raw, 'respectsGlobalFilters') && typeof raw.respectsGlobalFilters !== 'boolean') return undefined;
  return {
    dimensions,
    measures,
    ...(calculations?.length ? { calculations } : {}),
    ...(rollups?.length ? { rollups } : {}),
    ...(filters?.length ? { filters } : {}),
    ...(having?.length ? { having } : {}),
    ...(comparison ? { comparison } : {}),
    ...(orderBy?.length ? { orderBy } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(raw.detail === true ? { detail: true } : {}),
    ...(detailColumns?.length ? { detailColumns } : {}),
    ...(raw.respectsGlobalFilters === false ? { respectsGlobalFilters: false } : {}),
  };
}

/**
 * Deterministic contract validation. The caller may layer the full metric
 * capability authority on top of this result; this function never infers a
 * metric or silently changes an aggregation.
 */
export function validateTileQuery(descriptor: DatasetDescriptor, query: TileQuery): TileQueryValidation {
  const diagnostics: TileQueryDiagnostic[] = [];
  const adaptations: TileQueryAdaptation[] = [];
  const needsReview: TileQueryDiagnostic[] = [];
  if (descriptor.grain.timeGrain !== undefined && !isTileTimeGrain(descriptor.grain.timeGrain)) {
    diagnostics.push({ code: 'INVALID_TIME_GRAIN', message: `Dataset ${descriptor.label} declares an unknown time grain ${descriptor.grain.timeGrain}; use one of ${TIME_GRAINS.join(', ')}.` });
    return { outcome: 'rejected', diagnostics, adaptations: [] };
  }
  // Measures a calculation reads are checked exactly like selected ones, so a
  // formula cannot reach a measure the tile could not select directly.
  diagnostics.push(...checkTileCalculations(descriptor, query).diagnostics);
  diagnostics.push(...rollupDiagnostics(descriptor, query));
  const measureQuery = tileQueryMeasureScope(descriptor, query);
  const aggregateSafety = aggregateDatasetQuerySafety(descriptor, measureQuery);
  const aggregateComponents = datasetAggregateComponentRequirements(descriptor, measureQuery);
  diagnostics.push(...aggregateSafety.diagnostics);
  const requiredOperations = new Set<string>();
  if (query.dimensions.length > 0) requiredOperations.add('group');
  if (query.filters?.length) requiredOperations.add('filter');
  if (query.having?.length) requiredOperations.add('having');
  if (query.comparison) requiredOperations.add('compare');
  if (tileQueryIsTopNIntent(query) || query.calculations?.some((calculation) => calculation.quick?.kind === 'rank')) requiredOperations.add('rank');
  if (query.detail) requiredOperations.add('detail');
  if (query.dimensions.some((dimension) => dimension.timeGrain)) requiredOperations.add('trend');
  for (const operation of requiredOperations) {
    if (!descriptor.operations.includes(operation as typeof descriptor.operations[number])) {
      diagnostics.push({ code: operation === 'detail' ? 'DETAIL_UNSUPPORTED' : 'UNSUPPORTED_OPERATION', message: `Dataset ${descriptor.label} does not permit ${operation} queries.` });
    }
  }
  const outputs = tileQueryOutputAliases(query);
  const selectedAliases = new Set(outputs.map((output) => output.alias.toLowerCase()));
  const duplicateAliases = outputs.filter((output, index) => outputs.findIndex((candidate) => candidate.alias.toLowerCase() === output.alias.toLowerCase()) !== index);
  for (const output of duplicateAliases) {
    diagnostics.push({ code: 'INVALID_QUERY', field: output.alias, message: `Output alias ${output.alias} is ambiguous; select a unique presentation alias.` });
  }
  for (const order of query.orderBy ?? []) {
    if (!selectedAliases.has(order.alias.toLowerCase())) {
      diagnostics.push({ code: 'INVALID_QUERY', field: order.alias, message: `Order field ${order.alias} is not selected by this tile.` });
    }
  }
  if (query.detail && (query.measures.length > 0 || query.dimensions.length > 0)) {
    diagnostics.push({ code: 'INVALID_QUERY', message: 'A detail query cannot combine selected measures or grouped dimensions.' });
  }
  if (query.comparison && query.detail) {
    diagnostics.push({ code: 'INVALID_COMPARISON', message: 'A period comparison cannot be combined with bounded row detail.' });
  }
  if (query.comparison) {
    validateTileQueryComparison(descriptor, query.comparison, diagnostics, needsReview);
  }
  if (!query.detail && query.detailColumns !== undefined) {
    diagnostics.push({ code: 'INVALID_QUERY', message: 'Detail columns can only be selected for a detail query.' });
  }
  if (query.detail && typeof query.limit !== 'number') {
    diagnostics.push({ code: 'DETAIL_LIMIT_REQUIRED', message: 'Detail rows require an explicit bounded row limit.' });
  }
  if (query.detail) {
    const selectedColumns = query.detailColumns ?? [];
    const seenColumns = new Set<string>();
    for (const column of selectedColumns) {
      const normalized = column.toLowerCase();
      if (seenColumns.has(normalized)) {
        diagnostics.push({ code: 'INVALID_DETAIL_FIELD', field: column, message: `Detail column ${column} is selected more than once.` });
        continue;
      }
      seenColumns.add(normalized);
      const field = datasetPhysicalField(descriptor, column);
      if (!field) {
        diagnostics.push({ code: 'INVALID_DETAIL_FIELD', field: column, message: `Detail column ${column} is not an approved physical field for this dataset.` });
        continue;
      }
      if (field.status !== 'approved') {
        needsReview.push({ code: 'SUGGESTED_FIELD', field: column, message: `${column} is a suggested field and must be reviewed before it can appear in detail rows.` });
      }
    }
    if (query.detailColumns !== undefined && selectedColumns.length === 0) {
      diagnostics.push({ code: 'INVALID_DETAIL_FIELD', message: 'Choose at least one approved physical column for detail rows.' });
    }
  }
  if (!query.detail && query.measures.length === 0 && !query.calculations?.some((calculation) => calculation.expr)) {
    diagnostics.push({ code: 'INVALID_QUERY', message: 'Select at least one approved measure, or switch to detail rows.' });
  }
  for (const dimension of query.dimensions) {
    const field = datasetPhysicalField(descriptor, dimension.field);
    if (!field) {
      diagnostics.push({ code: 'UNKNOWN_FIELD', field: dimension.field, message: `Unknown dataset field ${dimension.field}.` });
      continue;
    }
    if (!['dimension', 'key', 'time', 'attribute'].includes(field.role)) {
      diagnostics.push({ code: 'INVALID_DIMENSION_ROLE', field: dimension.field, message: `${dimension.field} is not a groupable physical field.` });
      continue;
    }
    if (field.status !== 'approved') {
      needsReview.push({ code: 'SUGGESTED_FIELD', field: dimension.field, message: `${dimension.field} is a suggested field and must be reviewed before it can run.` });
    }
    if (dimension.timeGrain && !isTileTimeGrain(dimension.timeGrain)) {
      diagnostics.push({ code: 'INVALID_TIME_GRAIN', field: dimension.field, message: `${dimension.timeGrain} is not a time grain; use one of ${TIME_GRAINS.join(', ')}.` });
      continue;
    }
    if (dimension.timeGrain) {
      if (field.role !== 'time' || !field.time?.grains.includes(dimension.timeGrain)) {
        diagnostics.push({ code: 'INVALID_DIMENSION_ROLE', field: dimension.field, message: `${dimension.field} does not support the ${dimension.timeGrain} time grain.` });
      }
      const requestedIndex = timeGrainIndex(dimension.timeGrain);
      const sourceIndex = descriptor.grain.timeGrain ? timeGrainIndex(descriptor.grain.timeGrain) : -1;
      if (requestedIndex >= 0 && sourceIndex >= 0 && requestedIndex < sourceIndex) {
        diagnostics.push({ code: 'TIME_GRAIN_BELOW_SOURCE_GRAIN', field: dimension.field, message: `The ${dimension.timeGrain} grain is finer than the dataset's declared ${descriptor.grain.timeGrain} grain.` });
      }
    }
  }
  const timeRollup = query.dimensions.find((dimension) => Boolean(dimension.timeGrain) && descriptor.grain.timeGrain && timeGrainIndex(dimension.timeGrain!) > timeGrainIndex(descriptor.grain.timeGrain!));
  for (const selection of measureQuery.measures) {
    const measure = datasetMeasureField(descriptor, selection.measure);
    if (!measure) {
      diagnostics.push({ code: 'UNKNOWN_MEASURE', field: selection.measure, message: `Unknown approved measure ${selection.measure}.` });
      continue;
    }
    if (measure.status !== 'approved') {
      needsReview.push({ code: 'SUGGESTED_MEASURE', field: selection.measure, message: `${selection.measure} is a suggested measure and must be reviewed before it can run.` });
    }
    if (!measure.allowedAggs.includes(measure.aggregation)) {
      diagnostics.push({ code: 'INVALID_QUERY', field: selection.measure, message: `${selection.measure} does not permit its declared ${measure.aggregation} aggregation.` });
    }
    if (descriptor.grain.aggregate && measure.aggregation === 'count') {
      diagnostics.push({ code: 'NON_ADDITIVE_TIME_ROLLUP', field: selection.measure, message: `${selection.measure} cannot count rows from an already-aggregated dataset without an explicit aggregate-row contract.` });
    }
    if (descriptor.grain.aggregate && measure.aggregation === 'count_distinct'
      && measure.additivity.time === 'additive' && !hasValidMeasureTimeBucket(descriptor, measure)) {
      diagnostics.push({ code: 'AGGREGATE_GRAIN_EVIDENCE_REQUIRED', field: selection.measure, message: `${selection.measure} claims time-additive distinct semantics without an exact declared timeBucketBy contract.` });
    }
    if (descriptor.grain.aggregate && aggregateSafety.reaggregates) {
      const entityUnsafe = aggregateSafety.entityRollup && measure.additivity.entities !== 'additive';
      const timeUnsafe = aggregateSafety.timeRollup && measure.additivity.time !== 'additive';
      // A ratio remains a non-additive output, but a Dataset may safely
      // recompute it from independently proven native SUM components.  The
      // same structural allowance covers an owned SUM formula.  Runtime proof
      // authority remains mandatory and is enforced by the CLI compiler.
      const componentPlan = aggregateComponents.byMeasure.get(measure.name.toLowerCase());
      const componentEligible = componentPlan?.supported === true;
      if (!componentEligible && (entityUnsafe || timeUnsafe || measure.aggregation !== 'sum')) {
        diagnostics.push({
          code: 'NON_ADDITIVE_AGGREGATE_ROLLUP',
          field: selection.measure,
          message: `${selection.measure} cannot be re-aggregated from this Dataset's native grain because it has no complete approved native component definition.`,
        });
      }
    }
    const componentPlan = aggregateComponents.byMeasure.get(measure.name.toLowerCase());
    if (timeRollup && descriptor.grain.aggregate && measure.additivity.time !== 'additive' && componentPlan?.supported !== true) {
      diagnostics.push({ code: 'NON_ADDITIVE_TIME_ROLLUP', field: selection.measure, message: `${selection.measure} cannot be rolled up from ${descriptor.grain.timeGrain} to ${timeRollup.timeGrain}; it is non-additive over time.` });
    }
  }
  for (const filter of [...(query.filters ?? []), ...(query.having ?? [])]) {
    const inHaving = query.having?.includes(filter) ?? false;
    const field = inHaving ? datasetMeasureField(descriptor, filter.field) : datasetPhysicalField(descriptor, filter.field);
    if (!field) {
      diagnostics.push({ code: 'INVALID_FILTER_FIELD', field: filter.field, message: `Filter field ${filter.field} is not declared by this dataset.` });
      continue;
    }
    if (field.status !== 'approved') {
      needsReview.push({ code: field.kind === 'physical' ? 'SUGGESTED_FIELD' : 'SUGGESTED_MEASURE', field: filter.field, message: `${filter.field} is a suggested field and must be reviewed before it can filter a query.` });
    }
    if (!FILTER_OPERATORS.has(filter.op)) diagnostics.push({ code: 'INVALID_FILTER_FIELD', field: filter.field, message: `Filter ${filter.field} has an unsupported operator.` });
    const values = filter.values ?? [];
    if (values.length === 0 || (filter.op === 'between' && values.length !== 2) || (filter.op !== 'in' && filter.op !== 'not_in' && filter.op !== 'between' && values.length > 1)) {
      diagnostics.push({ code: 'INVALID_FILTER_FIELD', field: filter.field, message: `Filter ${filter.field} has invalid value cardinality for ${filter.op}.` });
    } else if (!values.every((value) => filterValueMatchesField(value, field.kind === 'physical' ? field.type : 'number'))) {
      diagnostics.push({ code: 'INVALID_FILTER_FIELD', field: filter.field, message: `Filter ${filter.field} values do not match its declared type.` });
    }
  }
  if (typeof query.limit === 'number' && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 10_000)) {
    diagnostics.push({ code: 'INVALID_LIMIT', message: 'A tile limit must be a positive integer no greater than 10,000.' });
  }
  // A saved query's result (design D1): as it is at its own grouping, rolled
  // up otherwise, and an average or a ratio is never summed.
  const savedQueryRollup = savedQueryResultRollup(descriptor, query, measureQuery.measures.map((selection) => datasetMeasureField(descriptor, selection.measure)?.name ?? selection.measure));
  for (const blocked of savedQueryRollup.blocked) {
    diagnostics.push({ code: 'NON_ADDITIVE_RESULT_ROLLUP', field: blocked.measure, message: blocked.message });
  }
  if (diagnostics.length > 0) return { outcome: 'rejected', diagnostics, adaptations: [] };
  if (needsReview.length > 0) return { outcome: 'needs_review', diagnostics: needsReview, adaptations: [] };
  // Every rollup check above passed, so re-aggregating an aggregate Dataset is
  // permitted — but it is an adaptation of the declared grain, not a read of
  // it, and the result must say so.
  if (descriptor.grain.aggregate && aggregateSafety.timeRollup) {
    const target = query.dimensions.find((dimension) => dimension.timeGrain && descriptor.grain.timeBucketBy
      && normalizeFieldName(dimension.field) === normalizeFieldName(descriptor.grain.timeBucketBy))?.timeGrain;
    adaptations.push({
      kind: 'aggregate_time_rollup',
      message: target
        ? `Rolled up from the Dataset's ${descriptor.grain.timeGrain} grain to ${target}.`
        : `Rolled up across the Dataset's ${descriptor.grain.timeGrain} periods.`,
    });
  }
  if (savedQueryRollup.adaptation) adaptations.push(savedQueryRollup.adaptation);
  if (descriptor.grain.aggregate && aggregateSafety.entityRollup) {
    adaptations.push({
      kind: 'aggregate_entity_rollup',
      message: `Re-aggregated above the Dataset's ${descriptor.grain.keyFields.join(', ')} grain.`,
    });
  }
  return { outcome: adaptations.length > 0 ? 'adapted' : 'covered', diagnostics: [], adaptations };
}

/**
 * Resolve exactly one declared Dataset hierarchy step. This is deliberately
 * browser-safe and does not execute SQL: the server re-resolves the same
 * descriptor before it accepts an interaction request. The returned query is
 * an ephemeral view state, not a source-document mutation.
 */
export function applyDatasetHierarchyDrill(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  hierarchyId: string;
  fromField: string;
  values: unknown[];
}): DatasetHierarchyDrillResult {
  const hierarchyId = input.hierarchyId.trim();
  const fromField = input.fromField.trim();
  if (!hierarchyId || !fromField || !Array.isArray(input.values) || input.values.length === 0 || input.values.length > 200) {
    return {
      status: 'blocked',
      code: 'HIERARCHY_SELECTION_INVALID',
      message: 'Choose one bounded set of values from a declared hierarchy level before drilling.',
    };
  }
  if (input.query.detail) {
    return {
      status: 'blocked',
      code: 'HIERARCHY_LEVEL_UNSUPPORTED',
      message: 'Bounded detail rows cannot be drilled. Return to a grouped Dataset tile first.',
    };
  }
  const levels = hierarchyLevels(input.descriptor, hierarchyId);
  if (levels.length === 0) {
    return {
      status: 'blocked',
      code: 'HIERARCHY_UNKNOWN',
      message: `Dataset ${input.descriptor.label} does not declare hierarchy ${hierarchyId}.`,
    };
  }
  const duplicateLevel = levels.some((field, index) => levels.findIndex((candidate) => candidate.hierarchy?.level === field.hierarchy?.level) !== index);
  if (duplicateLevel) {
    return {
      status: 'blocked',
      code: 'HIERARCHY_PATH_AMBIGUOUS',
      message: `Hierarchy ${hierarchyId} has more than one field at a level and cannot choose a drill path automatically.`,
    };
  }
  const from = levels.find((field) => field.name.toLowerCase() === fromField.toLowerCase());
  if (!from || from.status !== 'approved' || !input.query.dimensions.some((dimension) => dimension.field.toLowerCase() === from.name.toLowerCase())) {
    return {
      status: 'blocked',
      code: 'HIERARCHY_LEVEL_UNSUPPORTED',
      message: `${fromField} is not the active approved grouping level for hierarchy ${hierarchyId}.`,
    };
  }
  if (!input.values.every((value) => filterValueMatchesField(value, from.type))) {
    return {
      status: 'blocked',
      code: 'HIERARCHY_SELECTION_INVALID',
      message: `The selected ${from.name} values do not match its approved ${from.type} type.`,
    };
  }
  const next = levels.find((field) => field.hierarchy!.level === from.hierarchy!.level + 1);
  if (!next || next.status !== 'approved') {
    return {
      status: 'blocked',
      code: 'HIERARCHY_LEVEL_UNSUPPORTED',
      message: `${from.name} is the deepest approved level of hierarchy ${hierarchyId}.`,
    };
  }
  if (input.query.dimensions.some((dimension) => dimension.field.toLowerCase() === next.name.toLowerCase())) {
    return {
      status: 'blocked',
      code: 'HIERARCHY_PATH_AMBIGUOUS',
      message: `${next.name} is already selected, so this drill would produce an ambiguous grouping.`,
    };
  }
  const sourceAlias = tileDimensionAlias(input.query.dimensions.find((dimension) => dimension.field.toLowerCase() === from.name.toLowerCase())!);
  const targetAlias = next.name;
  const query: TileQuery = {
    ...structuredClone(input.query),
    dimensions: input.query.dimensions.map((dimension) =>
      dimension.field.toLowerCase() === from.name.toLowerCase()
        ? { field: next.name }
        : { ...dimension },
    ),
    filters: [
      ...(input.query.filters ?? []),
      { field: from.name, op: input.values.length === 1 ? 'eq' : 'in', values: [...input.values] },
    ],
    ...(input.query.orderBy ? {
      orderBy: input.query.orderBy.map((order) =>
        order.alias.toLowerCase() === sourceAlias.toLowerCase()
          ? { ...order, alias: targetAlias }
          : { ...order },
      ),
    } : {}),
    ...(input.query.rollups ? {
      rollups: input.query.rollups.map((set) => set.map((alias) => (alias.toLowerCase() === sourceAlias.toLowerCase() ? targetAlias : alias))),
    } : {}),
    // Quick calculations that ran along or within the drilled level follow it down.
    ...(input.query.calculations ? {
      calculations: input.query.calculations.map((calculation) => {
        if (!calculation.quick) return structuredClone(calculation);
        const follow = (alias: string | undefined) => (alias && alias.toLowerCase() === sourceAlias.toLowerCase() ? targetAlias : alias);
        const along = follow(calculation.quick.along);
        const within = follow(calculation.quick.within);
        return { ...structuredClone(calculation), quick: { ...calculation.quick, ...(along ? { along } : {}), ...(within ? { within } : {}) } };
      }),
    } : {}),
  };
  return { status: 'ready', hierarchyId, fromField: from.name, toField: next.name, query };
}

export function datasetHierarchyFields(descriptor: DatasetDescriptor, hierarchyId: string): DatasetPhysicalField[] {
  return hierarchyLevels(descriptor, hierarchyId.trim());
}

/**
 * The query with every Dataset measure its calculated measures read added as
 * hidden selections. Contract checks and aggregate-component evidence run on
 * this scope so a formula reaches no measure the tile could not select.
 */
export function tileQueryMeasureScope(descriptor: DatasetDescriptor, query: TileQuery): TileQuery {
  const selected = new Set(query.measures.map((selection) => (datasetMeasureField(descriptor, selection.measure)?.name ?? selection.measure).toLowerCase()));
  const hidden = tileCalcMeasureReferences(query).filter((name) => !selected.has((datasetMeasureField(descriptor, name)?.name ?? name).toLowerCase()));
  return hidden.length
    ? { ...query, measures: [...query.measures, ...hidden.map((measure) => ({ measure, alias: `__calc_${measure.replace(/[^A-Za-z0-9_]/g, '_')}` }))] }
    : query;
}

/**
 * A declaration can establish that a requested aggregate shape is structurally
 * eligible, but it cannot prove that its native aggregate components remain
 * safe to combine on the active warehouse target. The App runtime uses this
 * browser-safe predicate to require a server-produced component proof before
 * executing any aggregate-source rollup. It intentionally does not turn a
 * claimed `additive` flag or a key-uniqueness proof into that authority.
 */
export function datasetQueryRequiresAggregateComponentEvidence(
  descriptor: DatasetDescriptor,
  query: TileQuery,
): boolean {
  return aggregateDatasetQuerySafety(descriptor, tileQueryMeasureScope(descriptor, query)).reaggregates;
}

type AggregateDatasetQuerySafety = {
  diagnostics: TileQueryDiagnostic[];
  reaggregates: boolean;
  timeRollup: boolean;
  entityRollup: boolean;
};

/**
 * An aggregate source's native grain is part of its execution authority. A
 * caller can only retain non-additive values when it selects every native key
 * at the declared time bucket. Any other shape is a re-aggregation and is
 * handled measure-by-measure above. The full-source DatasetGrainProofV1 is
 * checked by the runtime; this browser-safe guard verifies the declaration.
 */
function aggregateDatasetQuerySafety(descriptor: DatasetDescriptor, query: TileQuery): AggregateDatasetQuerySafety {
  if (!descriptor.grain.aggregate) return { diagnostics: [], reaggregates: false, timeRollup: false, entityRollup: false };
  const diagnostics: TileQueryDiagnostic[] = [];
  const bucketName = descriptor.grain.timeBucketBy?.trim();
  const sourceGrain = descriptor.grain.timeGrain?.trim();
  const nativeKeys = descriptor.grain.keyFields.map(normalizeFieldName).filter(Boolean);
  const bucket = bucketName ? datasetPhysicalField(descriptor, bucketName) : undefined;
  const hasExactBucket = Boolean(bucketName
    && sourceGrain
    && descriptor.grain.keyEvidence?.trim()
    && bucket?.role === 'time'
    && bucket.time?.grains.includes(sourceGrain)
    && nativeKeys.includes(normalizeFieldName(bucketName)));
  if (!hasExactBucket) {
    diagnostics.push({
      code: 'AGGREGATE_GRAIN_EVIDENCE_REQUIRED',
      message: `Aggregate Dataset ${descriptor.label} requires a declared keyEvidence, native timeGrain, and exact timeBucketBy key before it can run field queries.`,
    });
  }
  const selected = new Map<string, TileQueryDimension[]>();
  for (const dimension of query.dimensions) {
    const key = normalizeFieldName(dimension.field);
    const entries = selected.get(key) ?? [];
    entries.push(dimension);
    selected.set(key, entries);
    const field = datasetPhysicalField(descriptor, dimension.field);
    if (field?.role === 'time' && bucketName && key !== normalizeFieldName(bucketName)) {
      diagnostics.push({
        code: 'AGGREGATE_TIME_BUCKET_REQUIRED',
        field: dimension.field,
        message: `${dimension.field} is not this aggregate Dataset's declared native timeBucketBy field ${bucketName}.`,
      });
    }
  }
  let entityRollup = false;
  let timeRollup = false;
  for (const key of nativeKeys) {
    const dimensions = selected.get(key) ?? [];
    if (dimensions.length === 0) {
      if (bucketName && key === normalizeFieldName(bucketName)) timeRollup = true;
      else entityRollup = true;
      continue;
    }
    if (bucketName && key === normalizeFieldName(bucketName)) {
      const atNativeBucket = dimensions.some((dimension) => !dimension.timeGrain || normalizeFieldName(dimension.timeGrain) === normalizeFieldName(sourceGrain ?? ''));
      if (!atNativeBucket) timeRollup = true;
    }
  }
  return { diagnostics, reaggregates: entityRollup || timeRollup, timeRollup, entityRollup };
}

function hasValidMeasureTimeBucket(descriptor: DatasetDescriptor, measure: DatasetMeasureField): boolean {
  const bucketName = measure.timeBucketBy?.trim();
  if (!bucketName || !descriptor.grain.keyEvidence?.trim()) return false;
  const bucket = datasetPhysicalField(descriptor, bucketName);
  return bucket?.role === 'time' && Boolean(bucket.time?.grains.length);
}

function validateTileQueryComparison(
  descriptor: DatasetDescriptor,
  comparison: TileQueryComparison,
  diagnostics: TileQueryDiagnostic[],
  needsReview: TileQueryDiagnostic[],
): void {
  const timeField = datasetPhysicalField(descriptor, comparison.timeField);
  if (!timeField) {
    diagnostics.push({
      code: 'INVALID_COMPARISON',
      field: comparison.timeField,
      message: `Comparison time field ${comparison.timeField} is not declared by this Dataset.`,
    });
    return;
  }
  if (timeField.role !== 'time' || !timeField.time?.grains.includes(comparison.grain)) {
    diagnostics.push({
      code: 'INVALID_COMPARISON',
      field: comparison.timeField,
      message: `${comparison.timeField} does not support comparison grain ${comparison.grain}.`,
    });
  }
  if (timeField.status !== 'approved') {
    needsReview.push({
      code: 'SUGGESTED_FIELD',
      field: comparison.timeField,
      message: `${comparison.timeField} is a suggested time field and must be reviewed before it can compare periods.`,
    });
  }
  if (!['gregorian', 'calendar:gregorian'].includes(comparison.calendarId.toLowerCase())) {
    diagnostics.push({
      code: 'INVALID_COMPARISON',
      field: 'calendarId',
      message: `Calendar ${comparison.calendarId} requires a configured calendar adapter.`,
    });
  }
  if (!['day', 'week', 'month', 'quarter', 'year'].includes(comparison.grain.toLowerCase())) {
    diagnostics.push({
      code: 'INVALID_COMPARISON',
      field: 'grain',
      message: `Comparison grain ${comparison.grain} is not supported by the governed period resolver.`,
    });
  }
  const sourceGrain = descriptor.grain.timeGrain ? timeGrainIndex(descriptor.grain.timeGrain) : -1;
  const comparisonGrain = timeGrainIndex(comparison.grain);
  if (sourceGrain >= 0 && comparisonGrain >= 0 && comparisonGrain < sourceGrain) {
    diagnostics.push({
      code: 'TIME_GRAIN_BELOW_SOURCE_GRAIN',
      field: comparison.timeField,
      message: `Comparison grain ${comparison.grain} is finer than the Dataset's declared ${descriptor.grain.timeGrain} grain.`,
    });
  }
}

function hierarchyLevels(descriptor: DatasetDescriptor, hierarchyId: string): DatasetPhysicalField[] {
  return descriptor.fields
    .filter((field): field is DatasetPhysicalField => field.kind === 'physical'
      && field.hierarchy?.id === hierarchyId)
    .sort((left, right) => left.hierarchy!.level - right.hierarchy!.level || left.name.localeCompare(right.name));
}

function tileDimensionAlias(dimension: TileQueryDimension): string {
  return dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field);
}

function normalizeFieldName(value: string): string {
  return value.trim().toLowerCase();
}

export function tileQueryMeasure(descriptor: DatasetDescriptor, selection: TileQueryMeasure): DatasetMeasureField | undefined {
  return datasetMeasureField(descriptor, selection.measure);
}

/**
 * Fixed-size identity of a canonical TileQuery. Browser and server compute it
 * with the same synchronous hash, so a receipt's authored-query fingerprint
 * can be compared on either side without carrying the query itself.
 */
export function tileQueryHash(query: TileQuery): string {
  return `sha256:${sha256Hex(JSON.stringify(canonicalize(query)))}`;
}

function normalizeDimensions(value: unknown): TileQueryDimension[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dimensions: TileQueryDimension[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    if (!hasOnlyKeys(raw, ['field', 'timeGrain', 'alias'])) return undefined;
    if ((hasOwn(raw, 'timeGrain') && typeof raw.timeGrain !== 'string') || (hasOwn(raw, 'alias') && typeof raw.alias !== 'string')) return undefined;
    const field = typeof raw.field === 'string' ? raw.field.trim() : '';
    const timeGrain = hasOwn(raw, 'timeGrain') ? typeof raw.timeGrain === 'string' ? raw.timeGrain.trim() : undefined : undefined;
    const alias = hasOwn(raw, 'alias') ? typeof raw.alias === 'string' ? raw.alias.trim() : undefined : undefined;
    if (!field || (timeGrain !== undefined && !timeGrain) || (alias !== undefined && !safeIdentifier(alias))) return undefined;
    dimensions.push({ field, ...(timeGrain ? { timeGrain } : {}), ...(alias ? { alias } : {}) });
  }
  return dimensions;
}

function normalizeMeasures(value: unknown): TileQueryMeasure[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const measures: TileQueryMeasure[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    if (!hasOnlyKeys(raw, ['measure', 'alias'])) return undefined;
    if (hasOwn(raw, 'alias') && typeof raw.alias !== 'string') return undefined;
    const measure = typeof raw.measure === 'string' ? raw.measure.trim() : '';
    const alias = hasOwn(raw, 'alias') ? typeof raw.alias === 'string' ? raw.alias.trim() : undefined : undefined;
    if (!measure || (alias !== undefined && !safeIdentifier(alias))) return undefined;
    measures.push({ measure, ...(alias ? { alias } : {}) });
  }
  return measures;
}

function normalizeFilters(value: unknown): TileQueryFilter[] | undefined {
  if (!Array.isArray(value)) return value === undefined ? [] : undefined;
  const filters: TileQueryFilter[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    if (!hasOnlyKeys(raw, ['field', 'op', 'values'])) return undefined;
    const field = typeof raw.field === 'string' ? raw.field.trim() : '';
    const op = typeof raw.op === 'string' && FILTER_OPERATORS.has(raw.op as TileFilterOperator) ? raw.op as TileFilterOperator : undefined;
    if (!field || !op || (hasOwn(raw, 'values') && !Array.isArray(raw.values))) return undefined;
    filters.push({ field, op, ...(Array.isArray(raw.values) ? { values: raw.values } : {}) });
  }
  return filters;
}

function normalizeComparison(value: unknown): TileQueryComparison | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!hasOnlyKeys(raw, [
    'version',
    'timeField',
    'timeRole',
    'calendarId',
    'timezone',
    'grain',
    'completenessPolicy',
    'periods',
    'basePeriodId',
    'comparisonPeriodIds',
    'alignment',
    'outputs',
    'zeroDenominatorPolicy',
  ])) return undefined;
  const timeField = cleanRequiredString(raw.timeField);
  const timeRole = cleanRequiredString(raw.timeRole);
  const calendarId = cleanRequiredString(raw.calendarId);
  const timezone = cleanRequiredString(raw.timezone);
  const grain = cleanRequiredString(raw.grain);
  const basePeriodId = cleanRequiredString(raw.basePeriodId);
  const alignment = raw.alignment === 'elapsed_period' || raw.alignment === 'calendar_period' || raw.alignment === 'fiscal_period'
    ? raw.alignment
    : undefined;
  const completenessPolicy = raw.completenessPolicy === 'partial_current'
    || raw.completenessPolicy === 'latest_complete'
    || raw.completenessPolicy === 'closed_period'
    ? raw.completenessPolicy
    : undefined;
  const zeroDenominatorPolicy = raw.zeroDenominatorPolicy === 'null' || raw.zeroDenominatorPolicy === 'not_applicable'
    ? raw.zeroDenominatorPolicy
    : undefined;
  const periods = normalizeComparisonPeriods(raw.periods);
  const comparisonPeriodIds = normalizeIdentifierArray(raw.comparisonPeriodIds);
  const outputs = normalizeComparisonOutputs(raw.outputs);
  if (
    raw.version !== 1
    || !timeField
    || !timeRole
    || !calendarId
    || !timezone
    || !grain
    || !basePeriodId
    || !alignment
    || !completenessPolicy
    || !zeroDenominatorPolicy
    || !periods
    || !comparisonPeriodIds
    || !outputs
  ) return undefined;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return undefined;
  }
  const periodIds = new Set(periods.map((period) => period.id));
  if (
    periods.length < 2
    || periodIds.size !== periods.length
    || !periodIds.has(basePeriodId)
    || comparisonPeriodIds.length === 0
    || new Set(comparisonPeriodIds).size !== comparisonPeriodIds.length
    || comparisonPeriodIds.some((id) => id === basePeriodId || !periodIds.has(id))
    || !outputs.includes('value')
    || !outputs.some((output) => output === 'absolute_delta' || output === 'percent_delta')
  ) return undefined;
  for (const period of periods) {
    if ((period.start === undefined) !== (period.end === undefined)) return undefined;
    if (period.start && period.end) {
      const start = Date.parse(period.start);
      const end = Date.parse(period.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return undefined;
    }
    if (period.kind === 'absolute' && (!period.start || !period.end)) return undefined;
    if ((period.kind === 'previous_period' || period.kind === 'previous_year')
      && !period.alignToPeriodId && !periods.some((candidate) => candidate.id === basePeriodId)) {
      return undefined;
    }
  }
  return {
    version: 1,
    timeField,
    timeRole,
    calendarId,
    timezone,
    grain,
    completenessPolicy,
    periods,
    basePeriodId,
    comparisonPeriodIds,
    alignment,
    outputs,
    zeroDenominatorPolicy,
  };
}

function normalizeComparisonPeriods(value: unknown): TileQueryComparisonPeriod[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const periods: TileQueryComparisonPeriod[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    if (!hasOnlyKeys(raw, ['id', 'kind', 'start', 'end', 'alignToPeriodId'])) return undefined;
    const id = cleanRequiredString(raw.id);
    const kind = raw.kind === 'absolute' || raw.kind === 'current' || raw.kind === 'previous_period' || raw.kind === 'previous_year'
      ? raw.kind
      : undefined;
    const start = raw.start === undefined ? undefined : cleanRequiredString(raw.start);
    const end = raw.end === undefined ? undefined : cleanRequiredString(raw.end);
    const alignToPeriodId = raw.alignToPeriodId === undefined ? undefined : cleanRequiredString(raw.alignToPeriodId);
    if (!id || !safeIdentifier(id) || !kind || (raw.start !== undefined && !start) || (raw.end !== undefined && !end)
      || (raw.alignToPeriodId !== undefined && (!alignToPeriodId || !safeIdentifier(alignToPeriodId)))) return undefined;
    periods.push({ id, kind, ...(start ? { start } : {}), ...(end ? { end } : {}), ...(alignToPeriodId ? { alignToPeriodId } : {}) });
  }
  return periods;
}

function normalizeIdentifierArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(cleanRequiredString);
  if (!values.every((item) => typeof item === 'string' && safeIdentifier(item))) return undefined;
  return values as string[];
}

function normalizeComparisonOutputs(value: unknown): TileQueryComparison['outputs'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const outputs = value.filter((item): item is TileQueryComparison['outputs'][number] =>
    item === 'value' || item === 'absolute_delta' || item === 'percent_delta');
  return outputs.length === value.length && new Set(outputs).size === outputs.length ? outputs : undefined;
}

function cleanRequiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeOrderBy(value: unknown): TileQuery['orderBy'] | undefined {
  if (!Array.isArray(value)) return value === undefined ? [] : undefined;
  const orderBy: NonNullable<TileQuery['orderBy']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    if (!hasOnlyKeys(raw, ['alias', 'direction'])) return undefined;
    const alias = typeof raw.alias === 'string' ? raw.alias.trim() : '';
    const direction = raw.direction === 'asc' || raw.direction === 'desc' ? raw.direction : undefined;
    if (!alias || !safeIdentifier(alias) || !direction) return undefined;
    orderBy.push({ alias, direction });
  }
  return orderBy;
}

function normalizeLimit(value: unknown): TileQuery['limit'] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (!hasOnlyKeys(raw, ['param'])) return undefined;
    const param = raw.param;
    if (typeof param === 'string' && safeIdentifier(param.trim())) return { param: param.trim() };
  }
  return undefined;
}

function normalizeDetailColumns(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const columns: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    const column = item.trim();
    if (!column || !safeIdentifier(column)) return undefined;
    columns.push(column);
  }
  return columns;
}

function normalizeRollups(value: unknown): string[][] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const rollups: string[][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length > 12) return undefined;
    const set: string[] = [];
    for (const alias of entry) {
      if (typeof alias !== 'string' || !safeIdentifier(alias.trim())) return undefined;
      set.push(alias.trim());
    }
    rollups.push(set);
  }
  return rollups;
}

/**
 * Totals are recomputed at each level by the warehouse; they refuse what
 * would make a level wrong or cut: quick calculations (windows would mix
 * levels), a measure filter (it would drop total rows), a row limit (it would
 * cut totals off at random) and an already-aggregated Dataset.
 */
function rollupDiagnostics(descriptor: DatasetDescriptor, query: TileQuery): TileQueryDiagnostic[] {
  if (!query.rollups?.length) return [];
  const refuse = (message: string): TileQueryDiagnostic => ({ code: 'INVALID_TOTALS', message });
  const out: TileQueryDiagnostic[] = [];
  const aliases = new Set(query.dimensions.map((dimension) => tileDimensionAlias(dimension).toLowerCase()));
  if (descriptor.kind === 'semantic' || descriptor.execution.route === 'semantic') out.push(refuse(`${descriptor.label} is defined in a semantic model; its totals come from the model, not from this tile.`));
  if (query.detail || query.comparison) out.push(refuse('Totals need a grouped tile without a period comparison.'));
  if (!query.dimensions.length) out.push(refuse('Totals need at least one dimension to total across.'));
  if (query.calculations?.some((calculation) => calculation.quick)) out.push(refuse('A table with totals cannot also hold quick calculations; each total level would mix them. Use a calculated measure instead.'));
  if (query.having?.length) out.push(refuse('A table with totals cannot filter on a measure; the filter would drop total rows.'));
  if (query.limit !== undefined) out.push(refuse('A table with totals shows every group; remove the row limit.'));
  if (descriptor.grain.aggregate) out.push(refuse(`${descriptor.label} is already aggregated; totals would add up its rows again.`));
  for (const set of query.rollups) {
    const unknown = set.find((alias) => !aliases.has(alias.toLowerCase()));
    if (unknown) out.push(refuse(`The total level names ${unknown}, which is not a dimension on this tile.`));
    if (new Set(set.map((alias) => alias.toLowerCase())).size !== set.length) out.push(refuse('A total level names a dimension twice.'));
  }
  return out;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function timeGrainIndex(value: string): number {
  return TIME_GRAINS.indexOf(value.toLowerCase() as typeof TIME_GRAINS[number]);
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function filterValueMatchesField(value: unknown, type: 'string' | 'number' | 'boolean' | 'date' | 'timestamp'): boolean {
  if (value === null) return false;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'date' || type === 'timestamp') return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  return typeof value === 'string';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}
