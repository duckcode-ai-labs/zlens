import { createHash } from 'node:crypto';
import {
  analyzeSqlReferences,
  buildSqlOutputExpressionSignature,
  normalizeMetricCapabilityContract,
  type AggregationAdditivity,
  type AggregationSafetyProofV1,
  type MetricCapabilityContract,
  type ResolvedRelationshipProofV1,
  sameTable,
  tableKey,
} from '@zlens/core';
import type { LocalContextPack, MetadataObject } from './metadata/catalog.js';
import { aggregationIntegrityIssuesForSql } from './metadata/grain-ledger.js';
import { resolvedRelationshipProofMatches } from './relationship-proof.js';
import type { SemanticProofAuthorityV1 } from './semantic-proof-authority.js';

/**
 * Builds aggregation authority exclusively from parser and governed metadata
 * facts. It intentionally has no warehouse-result input.
 */
export function buildAggregationSafetyProof(
  sql: string,
  contextPack: LocalContextPack | undefined,
  dialect = 'duckdb',
  planFingerprint?: string,
): AggregationSafetyProofV1 {
  const analysis = analyzeSqlReferences(sql, dialect);
  const objects = contextPack?.objects ?? [];
  const bindings = metricCapabilityBindings(objects);
  const integrityIssues = aggregationIntegrityIssuesForSql(sql, objects, dialect);
  const matchedBindings: MetricCapabilityBinding[] = [];
  const issueCodes = integrityIssues.map((issue) => issue.kind.toUpperCase());
  for (const aggregate of analysis.aggregates) {
    if (!aggregate.relation || !aggregate.column) {
      issueCodes.push('AGGREGATE_BINDING_MISSING');
      continue;
    }
    const matches = bindings.filter((binding) =>
      sameTable(binding.relation, aggregate.relation!, 'object')
      && normalizeIdentifier(binding.column) === normalizeIdentifier(aggregate.column!)
      && normalizeAggregation(binding.capability.aggregation) === normalizeAggregation(aggregate.func));
    if (matches.length === 0) issueCodes.push('AGGREGATE_CAPABILITY_EXACT_MATCH_MISSING');
    else if (matches.length > 1) issueCodes.push('AGGREGATE_CAPABILITY_AMBIGUOUS');
    else matchedBindings.push(matches[0]);
  }
  const capabilities = uniqueCapabilities(matchedBindings.map((binding) => binding.capability));
  const metricIds = capabilities.map((capability) => capability.metricId).sort();
  const metricProvenanceFingerprints = capabilities.map((capability) => hash({
    metricId: capability.metricId,
    sourceFingerprint: capability.sourceFingerprint,
  })).sort();
  const nativeGrain = unique(capabilities.flatMap((capability) => [
    capability.defaultResultGrainId,
    ...capability.resultGrainIds,
  ]));
  const requestedGrain = unique([
    contextPack?.routeDecision?.grainGate?.requestedGrain,
    contextPack?.questionPlan?.requestedShape?.grain,
    ...contextPack?.questionPlan?.requestedShape?.dimensions ?? [],
  ].filter((value): value is string => Boolean(value)));
  const joinFacts = exactRelationshipFacts(analysis.joins, objects, issueCodes);
  const joinCardinalities = unique(joinFacts.map((fact) => fact.cardinality));
  const hasAggregate = analysis.aggregates.length > 0;
  const additivity = combinedAdditivity(capabilities);
  const fanout = analysis.joins.length === 0
    ? 'proven_absent' as const
    : joinFacts.length > 0
      && joinFacts.every((fact) => fact.countsProven)
      && matchedBindings.length > 0
      && matchedBindings.every((binding) => fanoutSafeFromAggregate(binding.relation, joinFacts))
      ? 'proven_absent' as const
      : 'unknown' as const;
  const rounding = integrityIssues.some((issue) => issue.kind === 'premature_rounding')
    ? 'inner' as const
    : hasAggregate ? 'none' as const : 'none' as const;
  const correctionCodes: string[] = [];

  if (!analysis.parsed) issueCodes.push('SQL_PARSE_EVIDENCE_MISSING');
  if (hasAggregate && capabilities.length === 0) issueCodes.push('METRIC_CAPABILITY_MISSING');
  if (hasAggregate && additivity === 'unknown') issueCodes.push('ADDITIVITY_EVIDENCE_MISSING');
  if (hasAggregate && additivity === 'non_additive') issueCodes.push('NON_ADDITIVE_AGGREGATION_UNSUPPORTED');
  if (hasAggregate && additivity === 'semi_additive' && capabilities.some((capability) =>
    !semiAdditiveContractSupportsRequest(capability, requestedGrain))) {
    issueCodes.push('SEMI_ADDITIVE_TIME_GRAIN_PROOF_REQUIRED');
  }
  if (hasAggregate && requestedGrain.length === 0) issueCodes.push('REQUESTED_GRAIN_EVIDENCE_MISSING');
  if (hasAggregate && requestedGrain.length > 0 && capabilities.some((capability) =>
    !requestedGrain.every((grain) => capabilitySupportsGrain(capability, grain)))) {
    issueCodes.push('REQUESTED_GRAIN_CAPABILITY_MISMATCH');
  }
  if (analysis.joins.length > 0 && fanout === 'unknown') {
    issueCodes.push(joinFacts.length > 0 && joinFacts.every((fact) => fact.countsProven)
      ? 'JOIN_FANOUT_DIRECTION_UNSAFE'
      : 'JOIN_FANOUT_EVIDENCE_MISSING');
  }
  if (rounding === 'inner') {
    // The shared SQL analyzer exposes the aggregate/column relationship, but
    // not nested expression nodes or byte spans. An exact same-plan rewrite
    // cannot be proven, so Phase B must remain fail-closed instead of using the
    // text scanner that detects the policy violation as a rewriting authority.
    correctionCodes.push('AST_SAFE_ROUNDING_REWRITE_UNAVAILABLE');
  }

  const status = issueCodes.length === 0 ? 'safe' as const : 'blocked' as const;
  const evidence = {
    metricIds,
    metricProvenanceFingerprints,
    nativeGrain,
    requestedGrain,
    additivity,
    joinCardinalities,
    fanout,
    rounding,
    issueCodes: unique(issueCodes),
    correctionCodes: unique(correctionCodes),
    sqlFingerprint: hash(sql),
    ...(planFingerprint ? { planFingerprint } : {}),
  };
  return {
    version: 1,
    status,
    ...evidence,
    evidenceFingerprint: hash(evidence),
  };
}

/**
 * Proves an exact semantic-adapter compilation without pretending that a
 * derived metric is a stored additive column. A ratio may pass only when the
 * pinned compiler calculates it from multiple aggregates; SUM(ratio_output)
 * remains a blocked non-additive rollup.
 */
export function buildSemanticCompilationAggregationSafetyProof(input: {
  sql: string;
  capability: MetricCapabilityContract;
  /**
   * Compiler-owned metric expression rendered from the immutable semantic
   * snapshot before target SQL execution. The proof compares parser-owned
   * expression trees; prose, warehouse success, or a matching alias is never
   * accepted as authority.
   */
  compilerMetricExpressionSql?: string;
  compilerMetricId?: string;
  compilerMeasureIds?: string[];
  compilerRelation?: string;
  compilerRelationAliases?: string[];
  compilerAuthorityIssueCodes?: string[];
  relationshipProofs?: ResolvedRelationshipProofV1[];
  executionId?: string;
  snapshotId?: string;
  capabilityFingerprint?: string;
  route?: 'semantic';
  adapterId?: string;
  semanticAuthority?: SemanticProofAuthorityV1;
  contextPack?: LocalContextPack;
  dialect?: string;
  planFingerprint: string;
}): AggregationSafetyProofV1 {
  const dialect = input.dialect ?? 'duckdb';
  const analysis = analyzeSqlReferences(input.sql, dialect);
  const capability = input.capability;
  const issueCodes: string[] = [...input.compilerAuthorityIssueCodes ?? []];
  if (!analysis.parsed) issueCodes.push('SQL_PARSE_EVIDENCE_MISSING');
  if (analysis.aggregates.length === 0) issueCodes.push('SEMANTIC_AGGREGATE_EXPRESSION_MISSING');

  const semanticAuthority = input.semanticAuthority;
  const requestedGrain = semanticAuthority
    ? unique([...semanticAuthority.entityGrainIds, ...semanticAuthority.dimensionIds])
    : unique([
        input.contextPack?.routeDecision?.grainGate?.requestedGrain,
        input.contextPack?.questionPlan?.requestedShape?.grain,
        ...input.contextPack?.questionPlan?.requestedShape?.dimensions ?? [],
      ].filter((value): value is string => Boolean(value)));
  const nativeGrain = unique([capability.defaultResultGrainId, ...capability.resultGrainIds]);
  if (semanticAuthority && (
    semanticAuthority.version !== 1
    || semanticAuthority.planFingerprint !== input.planFingerprint
    || semanticAuthority.capabilityFingerprint !== capability.sourceFingerprint
    || semanticAuthority.metricIds.length !== 1
    || semanticAuthority.metricIds[0] !== capability.metricId
    || semanticAuthority.executionId !== input.executionId
    || semanticAuthority.snapshotId !== input.snapshotId
  )) issueCodes.push('SEMANTIC_PROOF_AUTHORITY_MISMATCH');
  if (requestedGrain.length === 0) issueCodes.push('REQUESTED_GRAIN_EVIDENCE_MISSING');
  if (requestedGrain.some((grain) => !capabilitySupportsGrain(capability, grain))) {
    issueCodes.push('REQUESTED_GRAIN_CAPABILITY_MISMATCH');
  }

  const additivity = combinedAdditivity([capability]);
  const metricLocalId = normalizeIdentifier(capability.metricId.split(/[:.]/).at(-1) ?? capability.metricId);
  const aggregatesStoredMetricOutput = analysis.aggregates.some((aggregate) =>
    Boolean(aggregate.column) && normalizeIdentifier(aggregate.column!) === metricLocalId);
  const normalizedAggregation = normalizeAggregation(capability.aggregation);
  const exactRatioCompilerBinding = normalizedAggregation === 'ratio'
    && exactSemanticRatioCompilerBinding(input, analysis);
  const exactNonAdditiveCalculation = !aggregatesStoredMetricOutput && (
    exactRatioCompilerBinding
    || (['avg', 'average', 'median', 'percentile_cont', 'count_distinct'].includes(normalizedAggregation)
      && analysis.aggregates.every((aggregate) => normalizeAggregation(aggregate.func) === normalizedAggregation))
  );
  if (normalizedAggregation === 'ratio' && !exactRatioCompilerBinding) {
    issueCodes.push('SEMANTIC_RATIO_COMPILER_BINDING_REQUIRED');
  }
  if (additivity === 'non_additive' && !exactNonAdditiveCalculation) {
    issueCodes.push('NON_ADDITIVE_AGGREGATION_UNSUPPORTED');
  }
  if (additivity === 'semi_additive' && !semiAdditiveContractSupportsRequest(capability, requestedGrain)) {
    issueCodes.push('SEMI_ADDITIVE_TIME_GRAIN_PROOF_REQUIRED');
  }

  const relationshipProofs = semanticAuthority?.relationshipProofs ?? input.relationshipProofs ?? [];
  const nativeProofs = relationshipProofs.filter((proof) => proof.kind === 'semantic_native_grouping');
  const nativeProofAuthorityComplete = nativeProofs.length > 0
    && input.route === 'semantic'
    && Boolean(input.adapterId && input.executionId && input.snapshotId && input.capabilityFingerprint)
    && input.capabilityFingerprint === capability.sourceFingerprint
    && nativeProofs.every((proof) => resolvedRelationshipProofMatches({
      proof,
      capability,
      route: 'semantic',
      adapterId: input.adapterId,
      executionId: input.executionId!,
      snapshotId: input.snapshotId!,
    }))
    && nativeProofs.every((proof) => requestedGrain.includes(proof.dimensionId)
      || requestedGrain.includes(proof.targetEntityId));
  if (nativeProofs.length > 0 && !nativeProofAuthorityComplete) {
    issueCodes.push('RELATIONSHIP_PROOF_AUTHORITY_MISMATCH');
  }
  const proofObjects = semanticAuthority?.relationshipObjects ?? input.contextPack?.objects ?? [];
  const joinFacts = nativeProofAuthorityComplete
    ? []
    : exactRelationshipFacts(analysis.joins, proofObjects, issueCodes);
  const aggregateRelations = unique(analysis.aggregates
    .map((aggregate) => aggregate.relation)
    .filter((value): value is string => Boolean(value)));
  const fanout = analysis.joins.length === 0 || nativeProofAuthorityComplete
    ? 'proven_absent' as const
    : joinFacts.length > 0
      && aggregateRelations.length > 0
      && aggregateRelations.every((relation) => fanoutSafeFromAggregate(relation, joinFacts))
      ? 'proven_absent' as const
      : 'unknown' as const;
  if (analysis.joins.length > 0 && fanout !== 'proven_absent') issueCodes.push('JOIN_FANOUT_EVIDENCE_MISSING');

  const rounding = aggregationIntegrityIssuesForSql(
    input.sql,
    proofObjects,
    dialect,
  ).some((issue) => issue.kind === 'premature_rounding') ? 'inner' as const : 'none' as const;
  const correctionCodes = rounding === 'inner' ? ['AST_SAFE_ROUNDING_REWRITE_UNAVAILABLE'] : [];
  if (rounding === 'inner') issueCodes.push('PREMATURE_ROUNDING');
  const evidence = {
    metricIds: [capability.metricId],
    metricProvenanceFingerprints: [hash({ metricId: capability.metricId, sourceFingerprint: capability.sourceFingerprint })],
    nativeGrain,
    requestedGrain,
    additivity,
    joinCardinalities: unique(joinFacts.map((fact) => fact.cardinality)),
    fanout,
    rounding,
    issueCodes: unique(issueCodes),
    correctionCodes,
    sqlFingerprint: hash(input.sql),
    planFingerprint: input.planFingerprint,
  };
  return {
    version: 1,
    status: evidence.issueCodes.length === 0 ? 'safe' : 'blocked',
    ...evidence,
    evidenceFingerprint: hash(evidence),
  };
}

function exactSemanticRatioCompilerBinding(
  input: {
    sql: string;
    capability: MetricCapabilityContract;
    compilerMetricExpressionSql?: string;
    compilerMetricId?: string;
    compilerMeasureIds?: string[];
    compilerRelation?: string;
    compilerRelationAliases?: string[];
    dialect?: string;
  },
  analysis: ReturnType<typeof analyzeSqlReferences>,
): boolean {
  const expectedSql = input.compilerMetricExpressionSql?.trim();
  const expectedMetricId = input.compilerMetricId?.trim();
  const expectedMeasureIds = unique(input.compilerMeasureIds ?? []).sort();
  const capabilityMeasureIds = unique(input.capability.measureIds).sort();
  const expectedRelation = input.compilerRelation?.trim();
  if (!expectedSql || expectedMetricId !== input.capability.metricId
    || expectedMeasureIds.length === 0
    || expectedMeasureIds.join('|') !== capabilityMeasureIds.join('|')
    || !expectedRelation) return false;

  const outputAlias = input.capability.declaredOutputIds?.length === 1
    ? input.capability.declaredOutputIds[0]
    : input.capability.metricId.split(/[:.]/).at(-1);
  if (!outputAlias) return false;
  const dialect = input.dialect ?? 'duckdb';
  const actual = buildSqlOutputExpressionSignature(input.sql, outputAlias, dialect);
  const expected = buildSqlOutputExpressionSignature(
    `SELECT ${expectedSql} AS ${quoteProofIdentifier(outputAlias)} FROM ${quoteProofRelation(expectedRelation)}`,
    outputAlias,
    dialect,
  );
  if (!actual || !expected || actual.canonicalExpression !== expected.canonicalExpression) return false;
  if (!actual.operators.includes('/') || actual.aggregateFunctions.length === 0) return false;
  if (analysis.tables.length !== 1 || !sameTable(analysis.tables[0], expectedRelation, 'object')) return false;
  const permittedAggregateRelations = [expectedRelation, ...(input.compilerRelationAliases ?? [])];
  const aggregateRelations = unique(analysis.aggregates
    .map((aggregate) => aggregate.relation)
    .filter((value): value is string => Boolean(value)));
  return aggregateRelations.every((relation) =>
    permittedAggregateRelations.some((permitted) => sameTable(relation, permitted, 'object')));
}

function quoteProofIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteProofRelation(value: string): string {
  return value.split('.')
    .map((part) => part.trim().replace(/^["`\[]|["`\]]$/g, ''))
    .map(quoteProofIdentifier)
    .join('.');
}

interface MetricCapabilityBinding {
  capability: MetricCapabilityContract;
  relation: string;
  column: string;
}

function metricCapabilityBindings(objects: MetadataObject[]): MetricCapabilityBinding[] {
  return objects.flatMap((object) => {
    const candidates = [object.payload?.analyticalCapability, object.payload?.metricCapability];
    for (const candidate of candidates) {
      const normalized = normalizeMetricCapabilityContract(candidate);
      if (!normalized) continue;
      const relationCandidates = unique([
        stringValue(object.payload?.relation),
        stringValue(object.payload?.table),
        stringValue(object.payload?.sourceRelation),
        ...stringArray(object.payload?.tableDependencies),
      ].filter(Boolean));
      const columnCandidates = unique([
        stringValue(object.payload?.measureColumn),
        stringValue(object.payload?.column),
        simpleColumn(stringValue(object.payload?.formula)),
        ...stringArray(object.payload?.backingMeasureNames),
        object.name.split('.').at(-1),
        ...normalized.measureIds.map((id) => id.split(/[:.]/).at(-1)),
      ].filter((value): value is string => Boolean(value)));
      // Multiple physical sources are not interchangeable authority. Each
      // capability must name exactly one relation; columns may name aliases for
      // the same governed measure and are matched exactly below.
      if (relationCandidates.length !== 1 || columnCandidates.length === 0) return [];
      return columnCandidates.map((column) => ({ capability: normalized, relation: relationCandidates[0], column }));
    }
    return [];
  });
}

function combinedAdditivity(capabilities: MetricCapabilityContract[]): AggregationAdditivity {
  if (capabilities.length === 0) return 'unknown';
  const values = capabilities.flatMap((capability) => [capability.additivity.entities, capability.additivity.time]);
  if (values.some((value) => value === 'non_additive')) return 'non_additive';
  if (values.some((value) => value === 'semi_additive')) return 'semi_additive';
  return values.every((value) => value === 'additive') ? 'additive' : 'unknown';
}

function exactRelationshipFacts(
  joins: Array<{ leftRelation?: string; leftColumn: string; rightRelation?: string; rightColumn: string; joinType?: string }>,
  objects: MetadataObject[],
  issues: string[],
): RelationshipFact[] {
  if (joins.length === 0) return [];
  const groups = new Map<string, typeof joins>();
  for (const join of joins) {
    if (!join.leftRelation || !join.rightRelation) {
      issues.push('JOIN_ENDPOINT_BINDING_MISSING');
      continue;
    }
    const endpointKey = [tableKey(join.leftRelation, 'object'), tableKey(join.rightRelation, 'object')].sort().join('|');
    groups.set(endpointKey, [...groups.get(endpointKey) ?? [], join]);
  }
  const facts: RelationshipFact[] = [];
  for (const group of groups.values()) {
    const leftRelation = group[0].leftRelation!;
    const rightRelation = group[0].rightRelation!;
    const matches = objects.flatMap((object) => {
      if (!object.objectType.includes('relationship')) return [];
      const payload = object.payload ?? {};
      const fromRelation = stringValue(payload.fromRelation);
      const toRelation = stringValue(payload.toRelation);
      const cardinality = stringValue(payload.cardinality);
      const keys = relationshipKeys(payload.keys);
      if (!fromRelation || !toRelation || !cardinality || keys.length === 0) return [];
      if (!sameEndpointPair(fromRelation, toRelation, leftRelation, rightRelation)) return [];
      const sqlDirectionalKeys = group.flatMap((join) => directionalSqlJoinKey(join, fromRelation, toRelation));
      const declaredKeys = unique(keys.map((key) => `${normalizeIdentifier(key.from)}=${normalizeIdentifier(key.to)}`));
      if (unique(sqlDirectionalKeys).join('|') !== declaredKeys.join('|')) return [];
      const validation = recordValue(payload.validation);
      const counts = ['fromRows', 'toRows', 'joinedRows', 'fromNullKeys', 'toNullKeys', 'unmatchedFrom', 'maxFromPerKey', 'maxToPerKey']
        .map((key) => validation?.[key]);
      const countsProven = validation?.status === 'passed'
        && counts.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
      return [{
        fromRelation,
        toRelation,
        cardinality: normalizeCardinality(cardinality),
        joinTypes: unique(group.map((join) => join.joinType ?? 'JOIN')),
        countsProven,
        maxFromPerKey: numberValue(validation?.maxFromPerKey),
        maxToPerKey: numberValue(validation?.maxToPerKey),
      }];
    });
    if (matches.length === 0) issues.push('JOIN_RELATIONSHIP_EXACT_MATCH_MISSING');
    else if (matches.length > 1) issues.push('JOIN_RELATIONSHIP_AMBIGUOUS');
    else if (!matches[0].countsProven) issues.push('JOIN_FANOUT_COUNT_EVIDENCE_MISSING');
    if (matches.length === 1) facts.push(matches[0]);
  }
  return facts;
}

interface RelationshipFact {
  fromRelation: string;
  toRelation: string;
  cardinality: string;
  joinTypes: string[];
  countsProven: boolean;
  maxFromPerKey?: number;
  maxToPerKey?: number;
}

/**
 * Prove whether one row at the aggregate-owning relation can be duplicated by
 * traversing the query's complete join graph. A global `fanout: safe` label is
 * deliberately ignored: safety reverses when a one-side measure is joined to
 * its many side, including reversed FROM order and outer joins.
 */
function fanoutSafeFromAggregate(aggregateRelation: string, facts: RelationshipFact[]): boolean {
  const queue = [aggregateRelation];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const relation = queue.shift()!;
    const normalized = tableKey(relation, 'object');
    if (visited.has(normalized)) continue;
    visited.add(normalized);
    for (const fact of facts) {
      const from = tableKey(fact.fromRelation, 'object');
      const to = tableKey(fact.toRelation, 'object');
      if (normalized !== from && normalized !== to) continue;
      const traversesFromTo = normalized === from;
      const next = traversesFromTo ? fact.toRelation : fact.fromRelation;
      if (visited.has(tableKey(next, 'object'))) continue;
      if (!relationshipTraversalPreservesRows(fact, traversesFromTo)) return false;
      if (!visited.has(tableKey(next, 'object'))) queue.push(next);
    }
  }
  return visited.size > 0;
}

function relationshipTraversalPreservesRows(fact: RelationshipFact, fromTo: boolean): boolean {
  if (!fact.countsProven) return false;
  const maximumMatches = fromTo ? fact.maxToPerKey : fact.maxFromPerKey;
  if (maximumMatches === undefined || maximumMatches > 1) return false;
  if (fact.cardinality === 'one_to_one') return true;
  if (fact.cardinality === 'many_to_one') return fromTo;
  if (fact.cardinality === 'one_to_many') return !fromTo;
  return false;
}

function directionalSqlJoinKey(
  join: { leftRelation?: string; leftColumn: string; rightRelation?: string; rightColumn: string },
  fromRelation: string,
  toRelation: string,
): string[] {
  if (join.leftRelation && join.rightRelation
    && sameTable(join.leftRelation, fromRelation, 'object')
    && sameTable(join.rightRelation, toRelation, 'object')) {
    return [`${normalizeIdentifier(join.leftColumn)}=${normalizeIdentifier(join.rightColumn)}`];
  }
  if (join.leftRelation && join.rightRelation
    && sameTable(join.rightRelation, fromRelation, 'object')
    && sameTable(join.leftRelation, toRelation, 'object')) {
    return [`${normalizeIdentifier(join.rightColumn)}=${normalizeIdentifier(join.leftColumn)}`];
  }
  return [];
}

function normalizeCardinality(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function relationshipKeys(value: unknown): Array<{ from: string; to: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = recordValue(entry);
    const from = stringValue(record?.from);
    const to = stringValue(record?.to);
    return from && to ? [{ from, to }] : [];
  });
}

function sameEndpointPair(a: string, b: string, left: string, right: string): boolean {
  return (sameTable(a, left, 'object') && sameTable(b, right, 'object')) || (sameTable(a, right, 'object') && sameTable(b, left, 'object'));
}

function capabilitySupportsGrain(capability: MetricCapabilityContract, grain: string): boolean {
  const accepted = new Set([
    capability.defaultResultGrainId,
    ...capability.resultGrainIds,
    ...capability.dimensions.flatMap((dimension) => [dimension.dimensionId, dimension.entityId]),
    ...capability.timeDimensions.flatMap((dimension) => [dimension.dimensionId, ...dimension.supportedGrains]),
  ].map(normalizeIdentifier));
  return accepted.has(normalizeIdentifier(grain));
}

function semiAdditiveContractSupportsRequest(
  capability: MetricCapabilityContract,
  requestedGrain: string[],
): boolean {
  if (capability.additivity.entities !== 'additive' || capability.additivity.time !== 'semi_additive') return false;
  const protectedDimensions = new Set(
    (capability.additivity.nonAdditiveDimensionIds ?? []).map(normalizeIdentifier),
  );
  if (protectedDimensions.size === 0 || requestedGrain.length === 0) return false;
  const requested = new Set(requestedGrain.map(normalizeIdentifier));
  return capability.timeDimensions.some((dimension) =>
    protectedDimensions.has(normalizeIdentifier(dimension.dimensionId))
    && (requested.has(normalizeIdentifier(dimension.dimensionId))
      || dimension.supportedGrains.some((grain) => requested.has(normalizeIdentifier(grain)))));
}

function uniqueCapabilities(capabilities: MetricCapabilityContract[]): MetricCapabilityContract[] {
  return Array.from(new Map(capabilities.map((capability) => [capability.metricId, capability])).values());
}

function normalizeAggregation(value: string): string {
  return value.trim().toLowerCase().replace(/^count_big$/, 'count');
}

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/["`\[\]]/g, '').toLowerCase();
}

function simpleColumn(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)$/);
  return match?.[1];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
