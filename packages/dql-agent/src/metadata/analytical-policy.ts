/** Deterministic manifest-v3 analytical path planning and SQL validation. */
import { createHash } from 'node:crypto';
import {
  analyzeSqlReferences,
  relationshipValidationProofFingerprint,
  type DQLManifest,
  type ManifestModelEntity,
  type ManifestModelRelationship,
  tableKey,
} from '@zlens/core';
import type { DomainContextEnvelope } from '../domain-context.js';

export type AnalyticalPolicyCode =
  | 'attribution_policy_required'
  | 'stale_certification'
  | 'relationship_not_certified'
  | 'relationship_evidence_missing'
  | 'relationship_evidence_expired'
  | 'relationship_proof_invalid'
  | 'relationship_not_exported'
  | 'unsafe_relationship'
  | 'unbound_relation'
  | 'unplanned_join'
  | 'join_key_mismatch'
  | 'relationship_ambiguous'
  | 'purpose_not_allowed';

/**
 * The planner's authoritative decision:
 * - `governed`: a fully certified path exists; generated SQL may join along it.
 * - `exploratory_candidate`: no certified path, but the manifest DECLARES a
 *   structurally safe draft/review path. Consumers may hand the declared keys
 *   to the bounded exploratory lane; the result is always analyst-review-required.
 * - `blocked`: an explicit governance/safety boundary (attribution, cross-domain,
 *   invalid proof, ambiguity, unmodeled join). Never falls through to exploration.
 */
export type AnalyticalPathDisposition = 'governed' | 'exploratory_candidate' | 'blocked';

export type AnalyticalEdgeLifecycle = 'certified' | 'draft' | 'review';

export interface AnalyticalJoinPlanEdge {
  relationshipId: string;
  fromEntity: string;
  toEntity: string;
  fromRelation?: string;
  toRelation?: string;
  keys: Array<{ from: string; to: string }>;
  cardinality: string;
  fanout: string;
  importRefs: string[];
  /**
   * CTX-008: the authored business meaning of the join. Keys tell a model *how*
   * to join; these tell it *what the join means*, which is what stops a
   * technically valid join from answering the wrong question.
   */
  verb?: string;
  description?: string;
  rationale?: string;
}

export interface AnalyticalExploratoryEdge extends AnalyticalJoinPlanEdge {
  lifecycle: AnalyticalEdgeLifecycle;
  /** Where the join hypothesis comes from. Declared relationships only, for now. */
  evidenceSource: 'declared_relationship';
}

export interface AnalyticalExploratoryPath {
  /** Complete join plan spanning the requested entities; may mix certified and draft edges. */
  edges: AnalyticalExploratoryEdge[];
  /** Stable fingerprint of the ordered edge set, for structural binding downstream. */
  fingerprint: string;
}

export interface AnalyticalPathPlan {
  /** Authoritative decision. `safe`/`code`/`message`/`relationshipIds` are deprecated projections of it. */
  disposition: AnalyticalPathDisposition;
  reasonCode?: AnalyticalPolicyCode;
  /** Business-language explanation, safe to show a stakeholder verbatim. */
  userFacingReason?: string;
  /** Machine/policy detail (qualified ids, codes) for Inspect surfaces — never the chat answer. */
  technicalDetail?: string;
  /** Present only when disposition === 'exploratory_candidate'. Suggestion-only, never join authorization. */
  exploratoryPath?: AnalyticalExploratoryPath;
  /** @deprecated projection: disposition === 'governed'. */
  safe: boolean;
  /** @deprecated projection of reasonCode. */
  code?: AnalyticalPolicyCode;
  /** @deprecated projection of technicalDetail. */
  message?: string;
  entities: string[];
  relationshipIds: string[];
  edges: AnalyticalJoinPlanEdge[];
}

export interface AnalyticalPathRequest {
  entityIds: string[];
  ownerDomain?: string;
  purpose?: string;
  /** Server-resolved authorization boundary. Raw client domain hints are insufficient. */
  domainContext?: DomainContextEnvelope;
  measureEntities?: string[];
  dimensionEntities?: string[];
}

export interface AnalyticalRelationshipDecision {
  executable: boolean;
  code?: AnalyticalPolicyCode;
  message: string;
}

/**
 * Re-check the complete executable-join invariant at the point of use.
 *
 * `automaticJoinAllowed` is the compiler's summary bit and remains mandatory,
 * but consumers also validate its source proof so stale/corrupt hand-authored
 * manifests cannot turn a review-only relationship into SQL authorization.
 */
export function assessAnalyticalRelationship(
  relationship: ManifestModelRelationship,
  manifest?: DQLManifest,
  now = new Date(),
): AnalyticalRelationshipDecision {
  if (relationship.status !== 'certified') {
    return denied('relationship_not_certified', `Relationship "${relationship.id}" is ${relationship.status}, not certified.`);
  }
  if (relationship.staleCertification) {
    return denied('stale_certification', `Relationship "${relationship.id}" is stale and cannot authorize generated SQL.`);
  }
  if (!relationship.certificationFingerprint?.trim()) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has no valid certification fingerprint.`);
  }
  const validation = relationship.validation;
  if (!validation) {
    return denied('relationship_evidence_missing', `Relationship "${relationship.id}" has no warehouse validation evidence.`);
  }
  if (validation.status !== 'passed') {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" warehouse validation is ${validation.status}, not passed.`);
  }
  if (!validDate(validation.checkedAt) || !validation.queryFingerprint?.trim() || !validValidationCounts(validation)) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has invalid warehouse validation proof.`);
  }
  const modeling = manifest?.modeling;
  const fromEntity = modeling?.entities[relationship.from];
  const toEntity = modeling?.entities[relationship.to];
  const fromRelation = manifest?.dbtProvenance?.nodes[fromEntity?.dbtUniqueId ?? '']?.relation;
  const toRelation = manifest?.dbtProvenance?.nodes[toEntity?.dbtUniqueId ?? '']?.relation;
  if (!validation.proofFingerprint?.trim()) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has legacy or unbound warehouse evidence; run relationship validation again.`);
  }
  if (!manifest || !fromEntity || !toEntity) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" validation proof cannot be bound to its manifest-v3 entities.`);
  }
  const expectedProof = relationshipValidationProofFingerprint({
    fromRelation,
    toRelation,
    keys: relationship.keys,
    cardinality: relationship.cardinality,
    fanout: relationship.fanout,
    queryFingerprint: validation.queryFingerprint,
    ...(relationship.keyTypes ? { keyTypes: relationship.keyTypes } : {}),
  });
  if (validation.proofFingerprint !== expectedProof) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" validation proof no longer matches its query, relations, keys, cardinality, or fanout policy.`);
  }
  if (relationship.evidenceExpiresAt) {
    const expiresAt = Date.parse(relationship.evidenceExpiresAt);
    if (!Number.isFinite(expiresAt)) {
      return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has an invalid evidence expiry timestamp.`);
    }
    if (expiresAt <= now.getTime()) {
      return denied('relationship_evidence_expired', `Relationship "${relationship.id}" warehouse validation evidence expired at ${relationship.evidenceExpiresAt}.`);
    }
  }
  if (relationship.keys.length === 0 || relationship.keys.some((key) => !key.from.trim() || !key.to.trim())) {
    return denied('relationship_proof_invalid', `Relationship "${relationship.id}" has no valid physical join-key proof.`);
  }
  if (relationship.fanout !== 'safe'
    || !['one_to_one', 'one_to_many', 'many_to_one'].includes(relationship.cardinality)) {
    return denied('unsafe_relationship', `Relationship "${relationship.id}" is not fanout-safe for automatic joins.`);
  }
  if (!relationship.automaticJoinAllowed) {
    return denied('unsafe_relationship', `Relationship "${relationship.id}" is not authorized for automatic joins.`);
  }
  return { executable: true, message: `Relationship "${relationship.id}" is certified for automatic joins.` };
}

export function planAnalyticalPath(manifest: DQLManifest, request: AnalyticalPathRequest): AnalyticalPathPlan {
  const modeling = manifest.modeling;
  if (manifest.manifestVersion !== 3 || !modeling) return allowed([], []);
  const requested = [...new Set(request.entityIds)];
  const resolvedEntities = requested.map((id) => {
    if (modeling.entities[id]) return id;
    const ownerDomain = request.domainContext?.activeDomain ?? request.ownerDomain;
    const matches = Object.entries(modeling.entities).filter(([, entity]) =>
      entity.qualifiedId === id
      || (Boolean(ownerDomain) && entity.domain === ownerDomain && entity.localId === id));
    return matches.length === 1 ? matches[0]![0] : undefined;
  });
  const unresolved = requested.filter((_id, index) => !resolvedEntities[index]);
  if (unresolved.length > 0) {
    return blocked('unbound_relation', [], [], `Unknown or ambiguous qualified analytical entity id(s): ${unresolved.join(', ')}.`);
  }
  const entities = resolvedEntities.filter((id): id is string => Boolean(id)).sort();
  if (entities.length < 2) return allowed(entities, []);

  const relationships = Object.values(modeling.relationships);
  const directlyRelevant = relationships.filter((relationship) => entities.includes(relationship.from) || entities.includes(relationship.to));
  const attribution = directlyRelevant.find((relationship) => relationship.fanout === 'attribution_required'
    && entities.includes(relationship.from) && entities.includes(relationship.to));
  if (attribution) return blocked('attribution_policy_required', entities, [attribution], `Relationship "${attribution.id}" requires an attribution policy or allocation policy before ZLens can join these entities.`);

  const tierOf = relationshipTierResolver(manifest);

  const spanWith = (allowedTiers: ReadonlyArray<'governed' | 'exploratory'>): Map<string, ManifestModelRelationship> | undefined => {
    const adjacency = new Map<string, Array<{ next: string; relationship: ManifestModelRelationship }>>();
    for (const entity of Object.keys(modeling.entities)) adjacency.set(entity, []);
    for (const relationship of relationships.filter((value) => allowedTiers.includes(tierOf(value) as 'governed' | 'exploratory'))) {
      adjacency.get(relationship.from)?.push({ next: relationship.to, relationship });
      adjacency.get(relationship.to)?.push({ next: relationship.from, relationship });
    }
    const selected = new Map<string, ManifestModelRelationship>();
    const connected = new Set<string>([entities[0]!]);
    for (const target of entities.slice(1)) {
      const path = cheapestPath([...connected], target, adjacency, (relationship) => tierOf(relationship) === 'exploratory');
      if (!path) return undefined;
      for (const relationship of path) {
        selected.set(relationship.qualifiedId ?? relationship.id, relationship);
        connected.add(relationship.from);
        connected.add(relationship.to);
      }
    }
    return selected;
  };

  const enforceSelectedEdgePolicies = (selected: Map<string, ManifestModelRelationship>): AnalyticalPathPlan | undefined => {
    for (const relationship of selected.values()) {
      if (relationship.crossDomain) {
        const authorization = authorizeCrossDomainRelationship(manifest, relationship, request.domainContext, request.purpose);
        if (!authorization.safe) return blocked(authorization.code!, entities, [relationship], authorization.message!);
      }
      if (relationship.aggregation) {
        const missingMeasure = request.measureEntities?.find((entity) => !relationship.aggregation?.measuresFrom.includes(entity));
        const missingDimension = request.dimensionEntities?.find((entity) => !relationship.aggregation?.dimensionsFrom.includes(entity));
        if (missingMeasure || missingDimension) {
          return blocked('unsafe_relationship', entities, [relationship], `Relationship "${relationship.id}" does not authorize the requested measure/dimension direction.`);
        }
      }
    }
    return undefined;
  };

  const governedSpan = spanWith(['governed']);
  if (governedSpan) {
    const violation = enforceSelectedEdgePolicies(governedSpan);
    if (violation) return violation;
    return allowed(entities, [...governedSpan.values()], manifest);
  }

  const mixedSpan = spanWith(['governed', 'exploratory']);
  if (mixedSpan) {
    const violation = enforceSelectedEdgePolicies(mixedSpan);
    if (violation) return violation;
    const ambiguity = detectRelationshipAmbiguity(manifest, [...mixedSpan.values()], tierOf);
    if (ambiguity) return ambiguity(entities);
    return exploratoryCandidatePlan(manifest, entities, [...mixedSpan.values()]);
  }

  // No spanning path even over declared draft edges: keep the specific denial
  // when a direct-but-unusable candidate exists, else the generic missing-path block.
  const connected = new Set<string>([entities[0]!]);
  const target = entities.slice(1).find((entity) => !connected.has(entity)) ?? entities[1]!;
  const candidate = relationships.find((relationship) =>
    (connected.has(relationship.from) && relationship.to === target)
    || (connected.has(relationship.to) && relationship.from === target));
  if (candidate) {
    const decision = assessAnalyticalRelationship(candidate, manifest);
    if (!decision.executable && decision.code !== 'unsafe_relationship' && tierOf(candidate) === 'denied') {
      return blocked(decision.code ?? 'unsafe_relationship', entities, [candidate], decision.message);
    }
  }
  if (candidate?.crossDomain) return blocked('relationship_not_exported', entities, candidate ? [candidate] : [], 'The cross-domain path is missing a certified export/import interface or valid purpose.');
  return blocked('unsafe_relationship', entities, candidate ? [candidate] : [], `No certified, validated, fanout-safe DQL path connects ${entities.join(', ')}.`);
}

/**
 * Edge classification for path planning:
 * - governed: full certified/validated/fanout-safe proof chain (assessAnalyticalRelationship).
 * - exploratory: DECLARED draft/review edge that is structurally safe (real keys,
 *   safe cardinality, declared-safe fanout, same-domain). May only feed the
 *   bounded review-required exploratory lane — never governed SQL.
 * - denied: everything else (deprecated, cross-domain, unsafe/unknown fanout,
 *   attribution-required, missing keys). Never traversed, never suggested.
 */
function relationshipTierResolver(manifest: DQLManifest): (relationship: ManifestModelRelationship) => 'governed' | 'exploratory' | 'denied' {
  const cache = new Map<ManifestModelRelationship, 'governed' | 'exploratory' | 'denied'>();
  return (relationship) => {
    const cached = cache.get(relationship);
    if (cached) return cached;
    const tier = assessAnalyticalRelationship(relationship, manifest).executable
      ? 'governed'
      : isExploratoryEligibleRelationship(relationship)
        ? 'exploratory'
        : 'denied';
    cache.set(relationship, tier);
    return tier;
  };
}

function isExploratoryEligibleRelationship(relationship: ManifestModelRelationship): boolean {
  return (relationship.status === 'draft' || relationship.status === 'evaluated' || relationship.status === 'review' || relationship.status === 'reviewed')
    && !relationship.crossDomain
    && relationship.fanout === 'safe'
    && ['one_to_one', 'one_to_many', 'many_to_one'].includes(relationship.cardinality)
    && relationship.keys.length > 0
    && relationship.keys.every((key) => key.from.trim().length > 0 && key.to.trim().length > 0);
}

/**
 * Two eligible relationships of the SAME tier connecting the same entity pair
 * with DIFFERENT key columns (e.g. billing vs shipping location) make the path
 * semantically ambiguous — refuse with a focused question instead of picking one.
 * A governed edge always outranks exploratory alternatives, so cross-tier
 * duplicates are not ambiguous.
 */
function detectRelationshipAmbiguity(
  manifest: DQLManifest,
  selected: ManifestModelRelationship[],
  tierOf: (relationship: ManifestModelRelationship) => 'governed' | 'exploratory' | 'denied',
): ((entities: string[]) => AnalyticalPathPlan) | undefined {
  const relationships = Object.values(manifest.modeling?.relationships ?? {});
  for (const edge of selected) {
    const tier = tierOf(edge);
    const rivals = relationships.filter((other) => other !== edge
      && tierOf(other) === tier
      && ((other.from === edge.from && other.to === edge.to) || (other.from === edge.to && other.to === edge.from))
      && keySignature(other) !== keySignature(edge));
    if (rivals.length > 0) {
      const ids = [edge, ...rivals].map((relationship) => relationship.qualifiedId ?? relationship.id).sort();
      return (entities) => blocked('relationship_ambiguous', entities, [edge, ...rivals],
        `Multiple declared relationships connect ${edge.from} and ${edge.to} with different keys: ${ids.join(', ')}. Name the intended relationship.`);
    }
  }
  return undefined;
}

function keySignature(relationship: ManifestModelRelationship): string {
  return relationship.keys.map((key) => `${key.from.toLowerCase()}=${key.to.toLowerCase()}`).sort().join('|');
}

/** Uniform-cost search minimising (exploratory edges, hops); deterministic tie-break by path relationship ids. */
function cheapestPath(
  starts: string[],
  target: string,
  adjacency: Map<string, Array<{ next: string; relationship: ManifestModelRelationship }>>,
  isExploratory: (relationship: ManifestModelRelationship) => boolean,
): ManifestModelRelationship[] | undefined {
  interface SearchState { entity: string; path: ManifestModelRelationship[]; exploratory: number }
  const costKey = (state: SearchState): string =>
    `${state.exploratory}:${state.path.length}:${state.path.map((relationship) => relationship.qualifiedId ?? relationship.id).join('>')}`;
  const queue: SearchState[] = [...starts].sort().map((entity) => ({ entity, path: [], exploratory: 0 }));
  const best = new Map<string, string>();
  for (const state of queue) best.set(state.entity, costKey(state));
  while (queue.length > 0) {
    queue.sort((a, b) => costKey(a).localeCompare(costKey(b), 'en', { numeric: true }));
    const current = queue.shift()!;
    if (current.entity === target) return current.path;
    const neighbours = [...(adjacency.get(current.entity) ?? [])]
      .sort((a, b) => (a.relationship.qualifiedId ?? a.relationship.id).localeCompare(b.relationship.qualifiedId ?? b.relationship.id));
    for (const edge of neighbours) {
      const next: SearchState = {
        entity: edge.next,
        path: [...current.path, edge.relationship],
        exploratory: current.exploratory + (isExploratory(edge.relationship) ? 1 : 0),
      };
      const nextKey = costKey(next);
      const existing = best.get(edge.next);
      if (existing !== undefined && existing.localeCompare(nextKey, 'en', { numeric: true }) <= 0) continue;
      best.set(edge.next, nextKey);
      queue.push(next);
    }
  }
  return undefined;
}

function denied(code: AnalyticalPolicyCode, message: string): AnalyticalRelationshipDecision {
  return { executable: false, code, message };
}

function authorizeCrossDomainRelationship(
  manifest: DQLManifest,
  relationship: ManifestModelRelationship,
  context: DomainContextEnvelope | undefined,
  requestedPurpose: string | undefined,
): Pick<AnalyticalPathPlan, 'safe' | 'code' | 'message'> {
  const purpose = context?.purpose?.trim();
  if (!context || !purpose) {
    return { safe: false, code: 'purpose_not_allowed', message: `Cross-domain relationship "${relationship.localId}" requires an explicit analytical purpose.` };
  }
  if (requestedPurpose?.trim() && requestedPurpose.trim() !== purpose) {
    return { safe: false, code: 'purpose_not_allowed', message: `Requested purpose "${requestedPurpose}" does not match the resolved domain context purpose "${purpose}".` };
  }
  if (!context.activeDomain || (relationship.ownerDomain && context.activeDomain !== relationship.ownerDomain)) {
    return { safe: false, code: 'relationship_not_exported', message: `Cross-domain relationship "${relationship.localId}" is not owned by the active domain context.` };
  }
  const importRefs = relationship.importRefs ?? [];
  if (importRefs.length === 0) {
    return { safe: false, code: 'relationship_not_exported', message: `Cross-domain relationship "${relationship.localId}" has no explicit import interface.` };
  }
  const exports = manifest.modeling?.interfaces?.exports ?? {};
  const contracts = Object.values(manifest.modeling?.contracts ?? {});
  for (const exportRef of importRefs) {
    const allowed = context.allowedImports.find((value) => value.exportRef === exportRef && value.purpose === purpose);
    const exported = exports[exportRef];
    if (!allowed || !exported || exported.status !== 'certified') {
      return { safe: false, code: 'relationship_not_exported', message: `Cross-domain relationship "${relationship.localId}" is missing a certified allowed import for "${exportRef}" and purpose "${purpose}".` };
    }
    const contract = exported.contract
      ? contracts.find((value) => value.qualifiedId === exported.contract
        || value.id === exported.contract
        || (value.domain === exported.domain && value.localId === exported.contract))
      : undefined;
    const contractEntityCompatible = !exported.entity || Boolean(contract?.entities.includes(exported.entity));
    const contractPurposeCompatible = !contract?.purpose || contract.purpose === purpose;
    if (!contract || contract.status !== 'certified' || !contractEntityCompatible || !contractPurposeCompatible) {
      return { safe: false, code: 'relationship_not_exported', message: `Cross-domain export "${exportRef}" has no compatible certified contract for purpose "${purpose}".` };
    }
  }
  return { safe: true };
}

function validDate(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function validValidationCounts(validation: NonNullable<ManifestModelRelationship['validation']>): boolean {
  return [
    validation.fromRows,
    validation.toRows,
    validation.joinedRows,
    validation.fromNullKeys,
    validation.toNullKeys,
    validation.unmatchedFrom,
    validation.maxFromPerKey,
    validation.maxToPerKey,
  ].every((value) => Number.isFinite(value) && value >= 0);
}

export function validateAnalyticalSql(
  sql: string,
  manifest: DQLManifest,
  dialect = 'duckdb',
  purpose?: string,
  domainContext?: DomainContextEnvelope,
): AnalyticalPathPlan {
  if (manifest.manifestVersion !== 3 || !manifest.modeling || !manifest.dbtProvenance) return allowed([], []);
  const analysis = analyzeSqlReferences(sql, dialect);
  if (!analysis.parsed) return blocked('unplanned_join', [], [], `ZLens could not parse generated SQL for analytical policy validation: ${analysis.error ?? 'unknown parse error'}`);
  const relationEntities = new Map<string, { key: string; entity: ManifestModelEntity }>();
  for (const relation of analysis.tables) {
    const entity = entityForRelation(relation, manifest);
    const key = entity ? entityRecordKey(manifest, entity) : undefined;
    if (entity && key) relationEntities.set(tableKey(relation, 'object'), { key, entity });
  }
  if (analysis.joins.length > 0) {
    const unbound = analysis.tables.filter((relation) => !entityForRelation(relation, manifest));
    if (unbound.length > 0) return blocked('unbound_relation', [...new Set([...relationEntities.values()].map((value) => value.key))], [], `Generated join references unbound relation(s): ${unbound.join(', ')}.`);
  }
  const plan = planAnalyticalPath(manifest, {
    entityIds: [...new Set([...relationEntities.values()].map((value) => value.key))],
    purpose,
    domainContext,
  });
  if (plan.disposition === 'blocked') return plan;

  // For a governed plan, only the planned certified relationships authorize joins.
  // For an exploratory candidate, any DECLARED eligible edge (certified or
  // draft/review) may match — the plan is then re-bound to the SQL's ACTUAL
  // join set so downstream probes validate exactly what will execute.
  const tierOf = relationshipTierResolver(manifest);
  const usedRelationships = new Map<string, ManifestModelRelationship>();
  for (const join of analysis.joins) {
    const left = join.leftRelation ? entityForRelation(join.leftRelation, manifest) : undefined;
    const right = join.rightRelation ? entityForRelation(join.rightRelation, manifest) : undefined;
    if (!left || !right) return blocked('unbound_relation', plan.entities, [], 'Every generated join endpoint must bind to a DQL analytical entity.');
    const leftKey = entityRecordKey(manifest, left);
    const rightKey = entityRecordKey(manifest, right);
    if (!leftKey || !rightKey) return blocked('unbound_relation', plan.entities, [], 'Every generated join endpoint must resolve to a qualified DQL analytical entity.');
    const candidates = plan.disposition === 'governed'
      ? plan.relationshipIds.map((id) => manifest.modeling?.relationships[id]).filter((value): value is ManifestModelRelationship => Boolean(value))
      : Object.values(manifest.modeling?.relationships ?? {}).filter((value) => tierOf(value) !== 'denied');
    const relationship = candidates
      .find((value) => (value.from === leftKey && value.to === rightKey) || (value.from === rightKey && value.to === leftKey));
    if (!relationship) return blocked('unplanned_join', plan.entities, [], `No planned relationship authorizes ${left.id} to ${right.id}.`);
    const matches = relationship.keys.some((key) => {
      const direct = relationship.from === leftKey && normalizeColumn(join.leftColumn) === normalizeColumn(key.from) && normalizeColumn(join.rightColumn) === normalizeColumn(key.to);
      const reverse = relationship.from === rightKey && normalizeColumn(join.leftColumn) === normalizeColumn(key.to) && normalizeColumn(join.rightColumn) === normalizeColumn(key.from);
      return direct || reverse;
    });
    if (!matches) return blocked('join_key_mismatch', plan.entities, [relationship], `Join predicate ${join.leftColumn} = ${join.rightColumn} does not match certified keys for "${relationship.id}".`);
    usedRelationships.set(relationship.qualifiedId ?? relationship.id, relationship);
  }
  if (plan.disposition === 'exploratory_candidate' && usedRelationships.size > 0) {
    return exploratoryCandidatePlan(manifest, plan.entities, [...usedRelationships.values()]);
  }
  return plan;
}

function entityRecordKey(manifest: DQLManifest, entity: ManifestModelEntity): string | undefined {
  return Object.entries(manifest.modeling?.entities ?? {}).find(([, candidate]) => candidate === entity || (Boolean(entity.qualifiedId) && candidate.qualifiedId === entity.qualifiedId))?.[0];
}

function shortestPath(
  starts: string[],
  target: string,
  adjacency: Map<string, Array<{ next: string; relationship: ManifestModelRelationship }>>,
): ManifestModelRelationship[] | undefined {
  const queue = starts.map((entity) => ({ entity, path: [] as ManifestModelRelationship[] }));
  const seen = new Set(starts);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.entity === target) return current.path;
    for (const edge of adjacency.get(current.entity) ?? []) {
      if (seen.has(edge.next)) continue;
      seen.add(edge.next);
      queue.push({ entity: edge.next, path: [...current.path, edge.relationship] });
    }
  }
  return undefined;
}

function entityForRelation(relation: string, manifest: DQLManifest): ManifestModelEntity | undefined {
  const normalized = tableKey(relation, 'object');
  return Object.values(manifest.modeling?.entities ?? {}).find((entity) => {
    const node = manifest.dbtProvenance?.nodes[entity.dbtUniqueId];
    return [node?.name, node?.relation].filter(Boolean).some((value) => {
      const candidate = tableKey(String(value), 'object');
      return candidate === normalized || candidate.endsWith(`.${normalized}`) || normalized.endsWith(`.${candidate}`);
    });
  });
}

function planEdge(manifest: DQLManifest | undefined, relationship: ManifestModelRelationship): AnalyticalJoinPlanEdge {
  return {
    relationshipId: relationship.id,
    fromEntity: relationship.from,
    toEntity: relationship.to,
    fromRelation: manifest?.dbtProvenance?.nodes[manifest.modeling?.entities[relationship.from]?.dbtUniqueId ?? '']?.relation,
    toRelation: manifest?.dbtProvenance?.nodes[manifest.modeling?.entities[relationship.to]?.dbtUniqueId ?? '']?.relation,
    keys: relationship.keys,
    cardinality: relationship.cardinality,
    fanout: relationship.fanout,
    importRefs: relationship.importRefs ?? [],
    verb: relationship.verb,
    description: relationship.description,
    rationale: relationship.rationale,
  };
}

function allowed(entities: string[], relationships: ManifestModelRelationship[], manifest?: DQLManifest): AnalyticalPathPlan {
  return {
    disposition: 'governed',
    safe: true,
    entities,
    relationshipIds: relationships.map((relationship) => relationshipRecordKey(manifest, relationship)),
    edges: relationships.map((relationship) => planEdge(manifest, relationship)),
  };
}

export function exploratoryCandidatePlan(
  manifest: DQLManifest,
  entities: string[],
  relationships: ManifestModelRelationship[],
): AnalyticalPathPlan {
  const ordered = [...relationships].sort((a, b) => (a.qualifiedId ?? a.id).localeCompare(b.qualifiedId ?? b.id));
  const edges: AnalyticalExploratoryEdge[] = ordered.map((relationship) => ({
    ...planEdge(manifest, relationship),
    lifecycle: relationship.status === 'certified' ? 'certified' : (relationship.status === 'review' || relationship.status === 'reviewed') ? 'review' : 'draft',
    evidenceSource: 'declared_relationship',
  }));
  const uncertified = edges.filter((edge) => edge.lifecycle !== 'certified');
  const pathSummary = describeJoinPath(edges);
  const technicalDetail = `Declared relationship path spans ${entities.join(', ')} with ${uncertified.length} uncertified edge(s): ${ordered.map((relationship) => relationship.qualifiedId ?? relationship.id).join(', ')}.`;
  return {
    disposition: 'exploratory_candidate',
    reasonCode: 'relationship_not_certified',
    userFacingReason: `The join between ${humanizeEntityList(entities)} isn't certified yet, but the project declares a draft join path (${pathSummary}). I can prepare a review-required exploratory answer using those declared keys. To make this governed, validate and certify the relationships in the DQL model files.`,
    technicalDetail,
    exploratoryPath: { edges, fingerprint: exploratoryPathFingerprint(edges) },
    safe: false,
    code: 'relationship_not_certified',
    message: technicalDetail,
    entities,
    relationshipIds: ordered.map((relationship) => relationshipRecordKey(manifest, relationship)),
    edges: [],
  };
}

export function exploratoryPathFingerprint(edges: AnalyticalExploratoryEdge[]): string {
  const canonical = [...edges]
    .map((edge) => ({
      relationshipId: edge.relationshipId,
      fromEntity: edge.fromEntity,
      toEntity: edge.toEntity,
      keys: [...edge.keys].map((key) => `${key.from.toLowerCase()}=${key.to.toLowerCase()}`).sort(),
    }))
    .sort((a, b) => a.relationshipId.localeCompare(b.relationshipId));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

export function humanizeAnalyticalEntityId(id: string): string {
  const local = id.split('::').at(-1) ?? id;
  return local.replace(/[_-]+/g, ' ').trim();
}

function humanizeEntityList(entities: string[]): string {
  const names = entities.map(humanizeAnalyticalEntityId);
  if (names.length <= 1) return names[0] ?? 'the requested data';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function describeJoinPath(edges: AnalyticalExploratoryEdge[]): string {
  return edges
    .map((edge) => `${humanizeAnalyticalEntityId(edge.fromEntity)} → ${humanizeAnalyticalEntityId(edge.toEntity)}`)
    .join(', ');
}

/** Deterministic business-language explanation per policy code — safe for chat surfaces. */
export function analyticalPolicyUserFacingReason(code: AnalyticalPolicyCode, entities: string[]): string {
  const subject = humanizeEntityList(entities.length > 0 ? entities : []);
  switch (code) {
    case 'attribution_policy_required':
      return `Combining ${subject} requires an attribution or allocation policy first — this is a deliberate governance rule, not a data gap. Define the policy in the DQL model to enable this analysis.`;
    case 'relationship_not_exported':
      return `This question crosses domains without a certified export/import contract. Publish the export from its owning domain and import it with an explicit purpose to enable this analysis.`;
    case 'purpose_not_allowed':
      return `Cross-domain analysis here needs an explicit, allowed analytical purpose. Set the purpose in the domain context and try again.`;
    case 'stale_certification':
      return `A relationship needed for this question has stale certification (its underlying dbt model changed). Re-run relationship validation and re-certify it.`;
    case 'relationship_evidence_missing':
    case 'relationship_evidence_expired':
    case 'relationship_proof_invalid':
      return `A relationship needed for this question is certified but its warehouse validation evidence is missing, expired, or invalid. Re-run relationship validation to restore it.`;
    case 'relationship_not_certified':
      return `A relationship between ${subject} is declared but cannot power an automatic answer yet. Complete its join keys, validate it against the warehouse, and certify it in the DQL model files.`;
    case 'relationship_ambiguous':
      return `More than one declared relationship could connect ${subject}, and they use different join keys. Tell me which relationship you mean and I will use it.`;
    case 'unbound_relation':
      return `Part of this question references data that is not bound to any modeled entity, so I cannot join it safely. Sync the dbt project or add the missing entity to the DQL model.`;
    case 'unplanned_join':
      return `The generated query used a join that is not part of the declared model, so I did not run it. Rephrase the question or add the missing relationship to the DQL model.`;
    case 'join_key_mismatch':
      return `The generated query joined on different keys than the declared relationship, so I did not run it. Ask again, or review the relationship's declared keys.`;
    case 'unsafe_relationship':
    default:
      return `I can't combine ${subject} yet: no declared join path connects them. Add the missing relationship in the DQL model files, or ask about entities that are already connected.`;
  }
}

function relationshipRecordKey(manifest: DQLManifest | undefined, relationship: ManifestModelRelationship): string {
  return Object.entries(manifest?.modeling?.relationships ?? {}).find(([, candidate]) => candidate === relationship || (Boolean(relationship.qualifiedId) && candidate.qualifiedId === relationship.qualifiedId))?.[0]
    ?? relationship.qualifiedId
    ?? relationship.id;
}

function blocked(code: AnalyticalPolicyCode, entities: string[], relationships: ManifestModelRelationship[], message: string): AnalyticalPathPlan {
  return {
    disposition: 'blocked',
    reasonCode: code,
    userFacingReason: analyticalPolicyUserFacingReason(code, entities),
    technicalDetail: message,
    safe: false,
    code,
    message,
    entities,
    relationshipIds: relationships.map((relationship) => relationship.id),
    edges: [],
  };
}

function normalizeColumn(value: string): string {
  return value.replace(/["`\[\]]/g, '').split('.').at(-1)?.trim().toLowerCase() ?? value.toLowerCase();
}
