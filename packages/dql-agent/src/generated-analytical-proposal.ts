import {
  buildGeneratedAnalyticalSqlSignature,
  buildSqlOutputExpressionSignature,
  type MetricCapabilityContract,
  tableKey,
} from '@zlens/core';
import type { ExploratoryRequiredOutputBindingProofV1 } from './analytical-orchestration.js';
import type { ResolvedAnalyticalPlan, ResolvedPlanMemberBinding } from './resolved-analytical-plan.js';
import type { LocalContextPack, MetadataObject } from './metadata/catalog.js';

export const GENERATED_ANALYTICAL_TUPLE_DRIFT_MESSAGE =
  'Generated query changed the resolved analytical plan and was not executed';

export type GeneratedAnalyticalTupleDriftCode =
  | 'PLAN_AUTHORITY_MISMATCH'
  | 'EXECUTION_AUTHORITY_MISMATCH'
  | 'CAPABILITY_AUTHORITY_MISMATCH'
  | 'SNAPSHOT_AUTHORITY_MISMATCH'
  | 'TARGET_AUTHORITY_MISMATCH'
  | 'METRIC_TUPLE_DRIFT'
  | 'DIMENSION_TUPLE_DRIFT'
  | 'FILTER_TUPLE_DRIFT'
  | 'ORDER_TUPLE_DRIFT'
  | 'LIMIT_TUPLE_DRIFT'
  | 'OUTPUT_TUPLE_DRIFT'
  | 'OUTPUT_BINDING_TUPLE_DRIFT'
  | 'GRAIN_TUPLE_DRIFT'
  | 'RELATIONSHIP_TUPLE_DRIFT'
  | 'RELATION_TUPLE_DRIFT'
  | 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'
  | 'GROUPING_TUPLE_DRIFT'
  | 'JOIN_PREDICATE_TUPLE_DRIFT'
  | 'SET_OPERATION_TUPLE_DRIFT'
  | 'WINDOW_TUPLE_DRIFT'
  | 'SQL_PARSE_EVIDENCE_MISSING';

export interface GeneratedAnalyticalProposalV1 {
  version: 1;
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  executionId: string;
  capabilityFingerprint: string;
  targetFingerprint: string;
  sql: string;
}

export type GeneratedAnalyticalProposalValidation =
  | { ok: true }
  | {
      ok: false;
      code: 'GENERATED_ANALYTICAL_TUPLE_DRIFT';
      message: typeof GENERATED_ANALYTICAL_TUPLE_DRIFT_MESSAGE;
      driftCodes: GeneratedAnalyticalTupleDriftCode[];
    };

/** Result of checking the host-owned explicit output projection. */
export type FrozenRequiredOutputProjectionValidation =
  | {
      ok: true;
      expectedOutputs: string[];
      /** Exact source bindings that the host must retain on the execution receipt. */
      bindingProofs: ExploratoryRequiredOutputBindingProofV1[];
    }
  | {
      ok: false;
      expectedOutputs: string[];
      missingOutputs: string[];
      /** Present when an alias exists but it came from the wrong or unproven source. */
      bindingMismatches: string[];
    };

/**
 * Return only aliases bound by the immutable resolved plan. These are not
 * phrase matches and are never derived from model-provided `outputs` text.
 */
export function frozenRequiredOutputAliasesForPlan(plan: ResolvedAnalyticalPlan): string[] {
  return [...new Set((plan.outputContract?.requiredOutputs ?? [])
    .map((binding) => binding.outputName ?? outputLeaf(binding.qualifiedId))
    .filter((value): value is string => Boolean(value && parserIdentifier(value)))
    .map(normalizeOutputAlias))];
}

/**
 * Return the source binding each new exploratory authorization must prove.
 * A binding that lacks a physical dbt/runtime column is intentionally absent:
 * `validateFrozenRequiredOutputProjection` treats that as a terminal proof
 * gap rather than guessing a source from an output alias.
 */
export function frozenRequiredOutputBindingProofsForPlan(
  plan: ResolvedAnalyticalPlan,
): ExploratoryRequiredOutputBindingProofV1[] {
  return (plan.outputContract?.requiredOutputs ?? []).flatMap((binding) => {
    const outputName = frozenOutputAlias(binding);
    const source = frozenPhysicalOutputSource(binding.qualifiedId);
    return outputName && source && binding.qualifiedId
      ? [{
          version: 1 as const,
          outputName,
          qualifiedId: binding.qualifiedId,
          relation: source.relation,
          column: source.column,
        }]
      : [];
  });
}

/**
 * Enforce every explicit host output at the SQL authorization boundary. The
 * caller may still apply stricter capability/closure checks; this helper never
 * accepts an unbound term or model-supplied alias.
 */
export function validateFrozenRequiredOutputProjection(input: {
  plan: ResolvedAnalyticalPlan;
  sql: string;
  dialect?: string;
}): FrozenRequiredOutputProjectionValidation {
  const expectedOutputs = frozenRequiredOutputAliasesForPlan(input.plan);
  if (expectedOutputs.length === 0) return { ok: true, expectedOutputs, bindingProofs: [] };
  const signature = buildGeneratedAnalyticalSqlSignature(input.sql, input.dialect);
  const actual = new Set((signature?.outputs ?? []).map((output) => normalizeOutputAlias(output.outputAlias)));
  const missingOutputs = expectedOutputs.filter((output) => !actual.has(output));
  const bindingMismatches: string[] = [];
  const bindingProofs: ExploratoryRequiredOutputBindingProofV1[] = [];
  const expectedBindingProofs = frozenRequiredOutputBindingProofsForPlan(input.plan);
  for (const binding of input.plan.outputContract?.requiredOutputs ?? []) {
    const outputName = frozenOutputAlias(binding);
    const expectedProof = outputName
      ? expectedBindingProofs.find((proof) => normalizeOutputAlias(proof.outputName) === normalizeOutputAlias(outputName))
      : undefined;
    if (!outputName || !expectedProof) {
      bindingMismatches.push(outputName ?? binding.requested);
      continue;
    }
    const output = signature?.outputs.find((candidate) =>
      normalizeOutputAlias(candidate.outputAlias) === normalizeOutputAlias(outputName));
    if (!output) continue;
    // A named alias by itself is never proof.  This output expression must
    // contain exactly one parser-resolved physical column and that source must
    // be the one selected before the plan froze.  In particular,
    // `product_id AS order_id` has the expected alias but fails here.
    const references = output.columnReferences;
    const exactSource = references.length === 1
      && tableKey(references[0]!.column, 'object') === expectedProof.column
      && relationMatchesFrozenPhysicalSource(
        input.plan,
        references[0]!.relation ?? '',
        expectedProof.relation,
      );
    if (!exactSource) {
      bindingMismatches.push(outputName);
      continue;
    }
    bindingProofs.push(expectedProof);
  }
  return missingOutputs.length === 0 && bindingMismatches.length === 0
    ? { ok: true, expectedOutputs, bindingProofs }
    : {
        ok: false,
        expectedOutputs,
        missingOutputs,
        bindingMismatches: [...new Set(bindingMismatches)],
      };
}

/**
 * Structural gate for the one optional generated-SQL proposal downstream of a
 * frozen RAP. The proposal carries identifiers, not prose. Both the declared
 * parser-owned SQL semantics are checked before a warehouse executor can be
 * called. The proposal cannot self-report tuple fields or spoof a metric by
 * assigning its output alias to a different expression.
 */
export function validateGeneratedAnalyticalProposal(input: {
  plan: ResolvedAnalyticalPlan;
  proposal: GeneratedAnalyticalProposalV1;
  expectedTargetFingerprint: string;
  contextPack?: LocalContextPack;
  dialect?: string;
}): GeneratedAnalyticalProposalValidation {
  const { plan, proposal } = input;
  const frame = plan.analyticalFrame;
  const driftCodes: GeneratedAnalyticalTupleDriftCode[] = [];
  if (plan.mode !== 'authoritative' || proposal.planId !== plan.planId || proposal.planFingerprint !== plan.fingerprint) {
    driftCodes.push('PLAN_AUTHORITY_MISMATCH');
  }
  if (!plan.executionId || proposal.executionId !== plan.executionId) driftCodes.push('EXECUTION_AUTHORITY_MISMATCH');
  if (!plan.selectedCapabilityFingerprint || proposal.capabilityFingerprint !== plan.selectedCapabilityFingerprint) {
    driftCodes.push('CAPABILITY_AUTHORITY_MISMATCH');
  }
  if (proposal.snapshotId !== plan.snapshotId) driftCodes.push('SNAPSHOT_AUTHORITY_MISMATCH');
  if (proposal.targetFingerprint !== input.expectedTargetFingerprint) driftCodes.push('TARGET_AUTHORITY_MISMATCH');

  const expectedMetricIds = frame?.metricConceptIds ?? plan.query.measures.flatMap((binding) => binding.qualifiedId ? [binding.qualifiedId] : []);
  const expectedDimensionIds = frame?.dimensions.map((dimension) => dimension.dimensionId) ?? plan.query.dimensions.flatMap((binding) => binding.qualifiedId ? [binding.qualifiedId] : []);
  const expectedOrder = frame?.ranking
    ? { metricId: frame.ranking.byMetricId, direction: frame.ranking.direction }
    : plan.query.order && expectedMetricIds.length === 1
      ? { metricId: expectedMetricIds[0]!, direction: plan.query.order }
      : undefined;
  const expectedLimit = frame?.ranking?.limit ?? plan.query.limit;
  const expectedOutputs = [...new Set([
    ...(frame?.requestedOutputs.map((output) => output.id)
      ?? plan.outputContract.fields
      ?? [...plan.outputContract.dimensions, ...plan.outputContract.measures]),
    ...frozenRequiredOutputAliasesForPlan(plan),
  ])];
  const signature = buildGeneratedAnalyticalSqlSignature(proposal.sql, input.dialect);
  if (!signature) {
    driftCodes.push('SQL_PARSE_EVIDENCE_MISSING');
  } else {
    const sqlOutputs = signature.outputs.map((output) => output.outputAlias);
    if (!sameSet(sqlOutputs, expectedOutputs)) driftCodes.push('OUTPUT_TUPLE_DRIFT');
    // An output alias is not enough authority: the expression must be backed
    // by the exact qualified physical source that the frozen plan selected.
    // This is deliberately evaluated from the parser-owned projection facts,
    // not query-wide lexical references or model output labels.
    if (!validateFrozenRequiredOutputProjection({
      plan,
      sql: proposal.sql,
      ...(input.dialect ? { dialect: input.dialect } : {}),
    }).ok) {
      driftCodes.push('OUTPUT_BINDING_TUPLE_DRIFT');
    }
    const capability = plan.selectedCapability;
    if (!capability || expectedMetricIds.length !== 1) {
      driftCodes.push('METRIC_TUPLE_DRIFT');
    } else {
      const metricOutput = frame?.requestedOutputs.find((output) => output.kind === 'metric_value' && output.metricId === expectedMetricIds[0]);
      const actualMetric = metricOutput ? signature.outputs.find((output) => normalizeId(output.outputAlias) === normalizeId(metricOutput.id)) : undefined;
      if (!actualMetric || !metricExpressionMatchesCapability(actualMetric, metricOutput!.id, capability, input.dialect)) {
        driftCodes.push('AGGREGATE_EXPRESSION_TUPLE_DRIFT');
      }
    }
    const expectedDimensionLeaves = expectedDimensionIds.map(normalizeId);
    const dimensionOutputs = frame?.requestedOutputs.filter((output) => output.kind === 'dimension') ?? [];
    for (const output of dimensionOutputs) {
      const signatureOutput = signature.outputs.find((candidate) => normalizeId(candidate.outputAlias) === normalizeId(output.id));
      if (!signatureOutput || signatureOutput.aggregateFunctions.length > 0 || signatureOutput.columns.length !== 1
        || !expectedDimensionLeaves.includes(normalizeId(signatureOutput.columns[0]!))) {
        driftCodes.push('DIMENSION_TUPLE_DRIFT');
      }
    }
    const expectedGroups = [...new Set(dimensionOutputs.map((output) => normalizeId(output.id)))].sort();
    if (expectedGroups.join('|') !== signature.groupByColumns.map(normalizeId).sort().join('|')) driftCodes.push('GROUPING_TUPLE_DRIFT');
    const expectedFilterExpression = expectedFilterSignature(plan, input.dialect);
    if (expectedFilterExpression !== signature.filterExpression) driftCodes.push('FILTER_TUPLE_DRIFT');
    if (expectedOrder) {
      const expectedOrderOutput = frame?.requestedOutputs.find((output) => output.kind === 'metric_value' && output.metricId === expectedOrder.metricId)?.id
        ?? expectedOrder.metricId.split(/[:.]/).at(-1)!;
      if (signature.orderBy.length !== 1
        || normalizeId(signature.orderBy[0]!.expression) !== normalizeId(expectedOrderOutput)
        || signature.orderBy[0]!.direction !== expectedOrder.direction) driftCodes.push('ORDER_TUPLE_DRIFT');
    } else if (signature.orderBy.length > 0) driftCodes.push('ORDER_TUPLE_DRIFT');
    const actualLimit = signature.limit?.kind === 'literal' ? signature.limit.value : undefined;
    if (actualLimit !== expectedLimit) driftCodes.push('LIMIT_TUPLE_DRIFT');
    compareSet(plan.sourceRelationIds.map(normalizeId), signature.sourceRelations.map(normalizeId), 'RELATION_TUPLE_DRIFT', driftCodes);
    if (!joinsMatchFrozenRelationships(signature.joins, plan.relationshipPathIds, input.contextPack?.objects ?? [])) {
      driftCodes.push('JOIN_PREDICATE_TUPLE_DRIFT');
    }
    if (signature.setOperations.length > 0) driftCodes.push('SET_OPERATION_TUPLE_DRIFT');
    if (signature.hasWindow) driftCodes.push('WINDOW_TUPLE_DRIFT');
  }

  const uniqueCodes = [...new Set(driftCodes)];
  return uniqueCodes.length === 0
    ? { ok: true }
    : {
        ok: false,
        code: 'GENERATED_ANALYTICAL_TUPLE_DRIFT',
        message: GENERATED_ANALYTICAL_TUPLE_DRIFT_MESSAGE,
        driftCodes: uniqueCodes,
      };
}

function metricExpressionMatchesCapability(
  actual: {
    canonicalExpression: string;
    aggregateInputs: Array<{ func: string; distinct: boolean; column?: string; relation?: string }>;
  },
  outputId: string,
  capability: MetricCapabilityContract,
  dialect?: string,
): boolean {
  const measureLeaves = [...new Set(capability.measureIds.map(normalizeId))];
  if (measureLeaves.length !== 1) return false;
  const column = parserIdentifier(measureLeaves[0]!);
  const alias = parserIdentifier(normalizeId(outputId));
  if (!column || !alias) return false;
  const aggregation = capability.aggregation.toLowerCase();
  const expression = aggregation === 'count_distinct'
    ? `COUNT(DISTINCT ${column})`
    : ['sum', 'count', 'avg', 'average', 'min', 'max'].includes(aggregation)
      ? `${aggregation === 'average' ? 'AVG' : aggregation.toUpperCase()}(${column})`
      : undefined;
  if (!expression) return false;
  const expected = buildSqlOutputExpressionSignature(`SELECT ${expression} AS ${alias} FROM generated_authority`, alias, dialect);
  const expectedOperator = aggregation === 'count_distinct'
    ? 'COUNT'
    : aggregation === 'average' ? 'AVG' : aggregation.toUpperCase();
  const expectedRelation = capability.semanticModelId ? normalizeId(capability.semanticModelId) : undefined;
  const aggregateInput = actual.aggregateInputs.length === 1 ? actual.aggregateInputs[0] : undefined;
  return expected?.canonicalExpression === actual.canonicalExpression
    && aggregateInput?.func === expectedOperator
    && aggregateInput.distinct === (aggregation === 'count_distinct')
    && normalizeId(aggregateInput.column ?? '') === measureLeaves[0]
    && Boolean(expectedRelation)
    && normalizeId(aggregateInput.relation ?? '') === expectedRelation;
}

function expectedFilterSignature(plan: ResolvedAnalyticalPlan, dialect?: string): string | undefined {
  const bindings = plan.analyticalFrame?.memberBindings ?? [];
  if (bindings.length === 0) return undefined;
  const predicates = bindings.flatMap((binding) => {
    const identifier = parserIdentifier(normalizeId(binding.dimensionId));
    return identifier ? binding.canonicalValues.map((value) => `${identifier} = ${sqlLiteral(value)}`) : [];
  });
  const expectedPredicateCount = bindings.reduce((count, binding) => count + binding.canonicalValues.length, 0);
  if (predicates.length !== expectedPredicateCount || predicates.length === 0) return '__invalid_frozen_filter__';
  return buildGeneratedAnalyticalSqlSignature(`SELECT 1 AS proof FROM generated_authority WHERE ${predicates.join(' AND ')}`, dialect)?.filterExpression;
}

function joinsMatchFrozenRelationships(
  joins: Array<{ leftRelation?: string; leftColumn: string; rightRelation?: string; rightColumn: string; joinType?: string }>,
  relationshipIds: string[],
  objects: MetadataObject[],
): boolean {
  if (joins.length === 0) return relationshipIds.length === 0;
  const relationships = relationshipIds.flatMap((id) => {
    const matches = objects.filter((object) => [object.objectKey, object.fullName, object.name, object.payload?.qualifiedId].includes(id));
    return matches.length === 1 ? matches : [];
  });
  if (relationships.length !== relationshipIds.length) return false;
  const expected = relationships.flatMap(relationshipJoinSignatures);
  const actual = joins.map(joinSignature);
  return expected.length > 0 && expected.length === actual.length && sameSet(expected, actual);
}

function relationshipJoinSignatures(object: MetadataObject): string[] {
  const payload = object.payload ?? {};
  const fromRelation = stringValue(payload.fromRelation);
  const toRelation = stringValue(payload.toRelation);
  const cardinality = stringValue(payload.cardinality);
  const fanout = stringValue(payload.fanout);
  const authorizedJoinType = normalizeJoinType(stringValue(payload.joinType) ?? 'INNER JOIN');
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  if (!fromRelation || !toRelation || !cardinality || fanout !== 'safe' || keys.length === 0) return [];
  return keys.flatMap((key) => {
    if (!key || typeof key !== 'object') return [];
    const from = stringValue((key as Record<string, unknown>).from);
    const to = stringValue((key as Record<string, unknown>).to);
    return from && to
      ? [canonicalJoinSignature(fromRelation, from, toRelation, to, authorizedJoinType)]
      : [];
  });
}

function joinSignature(join: {
  leftRelation?: string;
  leftColumn: string;
  rightRelation?: string;
  rightColumn: string;
  joinType?: string;
}): string {
  if (!join.leftRelation || !join.rightRelation) return '__unresolved_join__';
  return canonicalJoinSignature(
    join.leftRelation,
    join.leftColumn,
    join.rightRelation,
    join.rightColumn,
    normalizeJoinType(join.joinType),
  );
}

function canonicalJoinSignature(
  leftRelation: string,
  leftColumn: string,
  rightRelation: string,
  rightColumn: string,
  joinType: string,
): string {
  const endpoints = [
    `${normalizeId(leftRelation)}.${normalizeId(leftColumn)}`,
    `${normalizeId(rightRelation)}.${normalizeId(rightColumn)}`,
  ].sort();
  return `${joinType}:${endpoints.join('=')}`;
}

function normalizeJoinType(value: string | undefined): string {
  const normalized = value?.trim().replace(/\s+/g, ' ').toUpperCase() ?? '';
  return normalized === 'JOIN' ? 'INNER JOIN' : normalized;
}

function sqlLiteral(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parserIdentifier(value: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compareSet(
  expected: string[],
  actual: string[],
  code: GeneratedAnalyticalTupleDriftCode,
  codes: GeneratedAnalyticalTupleDriftCode[],
): void {
  if (!sameSet(expected, actual)) codes.push(code);
}

function sameSet(expected: string[], actual: string[]): boolean {
  return [...new Set(expected)].sort().join('|') === [...new Set(actual)].sort().join('|');
}

function normalizeId(value: string): string {
  return value.replace(/["`]/g, '').split(/[:.]/).at(-1)!.toLowerCase();
}

function outputLeaf(value: string | undefined): string | undefined {
  const leaf = value?.replace(/["`]/g, '').split(/[:.]/).at(-1)?.trim();
  return leaf && parserIdentifier(leaf) ? leaf : undefined;
}

function frozenOutputAlias(binding: ResolvedPlanMemberBinding): string | undefined {
  const alias = binding.outputName ?? outputLeaf(binding.qualifiedId);
  return alias && parserIdentifier(alias) ? alias : undefined;
}

/**
 * A frozen exploratory projection must identify a physical dbt/runtime column.
 * Semantic/certified members can still use output contracts on their own
 * execution lanes, but they are not sufficient proof for raw SQL.  Do not
 * guess a relation from an alias or from another SELECT expression.
 */
function frozenPhysicalOutputSource(qualifiedId: string | undefined): {
  relation: string;
  column: string;
} | undefined {
  if (!qualifiedId) return undefined;
  const rawId = qualifiedId.trim();
  const encodedColumn = /(?:^|:)column:([^:]+)$/i.exec(rawId)?.[1];
  // The local metadata bridge has two canonical physical-column shapes:
  // `dbt:column:relation.column` and the compact runtime/dbt identity
  // `relation.column`. The latter is not a model-supplied alias: it is only
  // admitted after the host has resolved a qualified candidate into the
  // frozen physical closure. Keep the grammar deliberately narrow so semantic
  // IDs, block fields, and arbitrary dotted prose cannot become SQL proof.
  const compactPhysicalColumn = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)+$/
    .test(rawId)
    ? rawId
    : undefined;
  const physicalColumn = encodedColumn ?? compactPhysicalColumn;
  if (!physicalColumn) return undefined;
  const parts = physicalColumn
    .split('.')
    .map((part) => tableKey(part, 'object'))
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  const column = parts.pop()!;
  const relation = parts.join('.');
  return relation && column ? { relation, column } : undefined;
}

/**
 * The first projection check sees provider SQL as authored (`order_items`),
 * while the final authorization check sees the same statement after the host
 * has target-qualified its FROM/JOIN leaf (`jaffle_shop.dev.order_items`).
 * Treat those forms as one source only when the qualified form is itself in
 * the frozen physical closure. This is deliberately not a generic leaf-name
 * match: a different catalog/schema with the same table leaf is rejected.
 */
function relationMatchesFrozenPhysicalSource(
  plan: ResolvedAnalyticalPlan,
  actualRelation: string,
  expectedRelation: string,
): boolean {
  const actual = tableKey(actualRelation, 'object');
  const expected = tableKey(expectedRelation, 'object');
  if (!actual || !expected) return false;

  const frozenRelations = [...new Set((plan.sourceRelationIds ?? [])
    .map((id) => tableKey(id, 'object'))
    .filter(Boolean))];
  const expectedLeaf = physicalIdentifierLeaf(expected);
  const actualLeaf = physicalIdentifierLeaf(actual);
  if (!expectedLeaf || actualLeaf !== expectedLeaf) return false;

  const leafSources = frozenRelations.filter((source) => physicalIdentifierLeaf(source) === expectedLeaf);
  // A frozen local plan may retain both the compact metadata identity
  // (`order_items`) and the target-bound physical identity
  // (`jaffle_shop.dev.order_items`) for the *same* selected source.  Those
  // two representations are not two candidate relations.  Keep the compact
  // form usable only when there is exactly one non-compact physical source
  // with that leaf.  Two target-qualified sources with the same leaf remain
  // ambiguous and therefore cannot be selected by a compact output proof.
  const qualifiedLeafSources = leafSources.filter((source) => source !== expectedLeaf);
  const expectedIsCompactLeaf = expected === expectedLeaf;
  if (expectedIsCompactLeaf) {
    if (qualifiedLeafSources.length > 1) {
      // A local dbt project can surface the selected model once through its
      // manifest relation (`catalog.main.table`) and once through the active
      // runtime target (`catalog.dev.table`).  They are only aliases when the
      // frozen authority also carries the exact qualified dbt model identity.
      // Do not generalize this to arbitrary same-leaf tables: without that
      // immutable model identity, two qualified sources remain ambiguous.
      if (!isFrozenLocalDbtRuntimeAliasPair(plan, qualifiedLeafSources, expectedLeaf)) return false;
      return actual === expectedLeaf || qualifiedLeafSources.includes(actual);
    }
    if (qualifiedLeafSources.length === 1) {
      // The parser may see either the provider's compact FROM spelling or
      // the target-qualified form that the host authorizes later. Both must
      // resolve to this one frozen physical source; a different catalog or
      // schema with the same leaf is not accepted.
      return actual === expectedLeaf || actual === qualifiedLeafSources[0];
    }
    // A legacy compact-only closure has no target-qualified relation to
    // compare, so it authorizes only the exact compact parser relation.
    return frozenRelations.includes(expectedLeaf) && actual === expectedLeaf;
  }

  // Persisted qualified sources are authoritative only when the exact
  // relation remains selected in this frozen closure. A copied output binding
  // must not authorize a relation that the RAP did not select.
  if (!frozenRelations.includes(expected)) return false;
  if (actual === expected) return true;

  // The provider may use the compact table spelling before target
  // qualification. It is safe only when this exact persisted relation is the
  // sole target-qualified source for that leaf.
  return actual === actualLeaf
    && qualifiedLeafSources.length === 1
    && qualifiedLeafSources[0] === expected;
}

/**
 * Recognize the one local dbt/runtime alias shape that can be proven without
 * reopening a frozen physical closure.  The model ID is server-issued during
 * snapshot binding; provider SQL and public request fields cannot create it.
 *
 * This remains intentionally narrower than a generic `main`/`dev` rule:
 * the two relations must share one catalog and table leaf, use exactly those
 * two schemas, and have the exact qualified dbt model in the frozen plan.
 */
function isFrozenLocalDbtRuntimeAliasPair(
  plan: ResolvedAnalyticalPlan,
  qualifiedLeafSources: string[],
  expectedLeaf: string,
): boolean {
  if (qualifiedLeafSources.length !== 2) return false;
  const parsed = qualifiedLeafSources.map((source) => source.split('.').filter(Boolean));
  if (!parsed.every((parts) => parts.length === 3 && parts[2] === expectedLeaf)) return false;

  const [first, second] = parsed as [[string, string, string], [string, string, string]];
  if (first[0] !== second[0]) return false;
  if (new Set([first[1], second[1]]).size !== 2) return false;
  if (!new Set([first[1], second[1]]).has('main') || !new Set([first[1], second[1]]).has('dev')) {
    return false;
  }

  const qualifiedModelId = `dbt::model.${first[0]}.${expectedLeaf}`;
  return plan.selectedConceptIds.some((id) => tableKey(id, 'object') === qualifiedModelId);
}

function physicalIdentifierLeaf(value: string): string | undefined {
  return value.split('.').filter(Boolean).at(-1);
}

function normalizeOutputAlias(value: string): string {
  return normalizeId(value).replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
