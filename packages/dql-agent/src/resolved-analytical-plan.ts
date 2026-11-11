/**
 * Immutable, snapshot-bound analytical plan shared by every downstream route.
 * The router emits it authoritatively by default. The `shadow` discriminator
 * remains only for explicit dev/test comparison fixtures; production has no
 * environment flag or request field that can select it.
 *
 * Acceptance: AGT-013, API-006.
 */

import { createHash } from "node:crypto";
import {
  normalizeMetricCapabilityContract,
  type AnalyticalDimensionRole,
  type AnalyticalQuestionFrameV2,
  type MetricCapabilityContract,
  type ResolvedRelationshipProofV1,
} from "@zlens/core";
import type { KnowledgeLens } from "./domain-context.js";
import type {
  AgentEvidenceCandidate,
  AgentRetrievalEvidence,
  MeaningExecutionRoute,
  MeaningQuestionType,
  MeaningResolution,
} from './meaning-resolution.js';
import {
  certifiedCandidateDeclaredDimensionOutput,
  certifiedCandidateDeclaredMeasureOutput,
  certifiedCandidateExplicitlyCoversMeasures,
  certifiedCandidateGrainDimensionOutputs,
} from './meaning-resolution.js';
import { currentQuestionGroundedParsedIntent } from './analytical-orchestration.js';
import {
  buildResolvedRelationshipProofsV1,
  buildGovernedRelationshipSafetyProofsV1,
  type GovernedRelationshipSafetyProofV1,
  governedCapabilityDimensionHasFreshAutomaticRelationshipProofV1,
  semanticDimensionUsesExactAdapterGrouping,
} from './relationship-proof.js';
import { proveSameSnapshotMetricflowRoleExtensionV1 } from './analytical-frame.js';

export type ResolvedPlanCapability =
  | 'certified_execution'
  | 'semantic_execution'
  | 'governed_relational'
  | 'bounded_exploration'
  | 'blocked';

export interface ResolvedPlanMemberBinding {
  requested: string;
  qualifiedId?: string;
  /**
   * The declared field returned by a certified execution authority. The
   * qualified ID remains the block execution ID; this field prevents a
   * requested measure or dimension phrase from being represented as though it
   * were an output when the block returns a differently named column.
   */
  outputName?: string;
  aggregation?: string;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  candidateIds: string[];
}

export interface ResolvedPlanCompatibilityProof {
  candidateId: string;
  compatibility: AgentEvidenceCandidate['compatibility'];
  facts: string[];
}

export interface ResolvedAnalyticalPlan {
  schemaVersion: 1 | 2;
  mode: "shadow" | "authoritative";
  planId: string;
  fingerprint: string;
  parentPlanId?: string;
  rootPlanId?: string;
  revision: number;
  snapshotId: string;
  sourceFingerprint?: string;
  question: string;
  interpretedQuestion: string;
  questionType: MeaningQuestionType;
  confidence: MeaningResolution['confidence'];
  selectedConceptIds: string[];
  executionId?: string;
  /** Exact normalized execution authority selected before the plan was frozen. */
  selectedCapability?: MetricCapabilityContract;
  /** Stable authority identity retained separately for receipt comparison. */
  selectedCapabilityFingerprint?: string;
  recommendedRoute: MeaningExecutionRoute;
  capability: ResolvedPlanCapability;
  query: {
    measures: ResolvedPlanMemberBinding[];
    dimensions: ResolvedPlanMemberBinding[];
    filters: Array<{
      field: string;
      value: string;
      binding: ResolvedPlanMemberBinding;
    }>;
    timeRange?: string;
    timeBounds?: {
      expression: string;
      startInclusive: string;
      endExclusive: string;
      timeZone: 'UTC';
    };
    timeGrain?: string;
    order?: 'asc' | 'desc';
    limit?: number;
  };
  entityGrain?: string;
  sourceRelationIds: string[];
  relationshipPathIds: string[];
  /** Exact selected relationship authority; native semantic paths are never DQL relationship IDs. */
  relationshipProofs?: ResolvedRelationshipProofV1[];
  /**
   * Snapshot-bound safety facts for a frozen governed physical traversal.
   * Unlike a relationship path ID, this pins lifecycle, fanout, certification
   * and validation evidence for compiler revalidation after plan freeze.
   */
  governedRelationshipSafetyProofs?: GovernedRelationshipSafetyProofV1[];
  compatibilityProof: ResolvedPlanCompatibilityProof[];
  outputContract: {
    measures: string[];
    dimensions: string[];
    /**
     * Host-owned explicit projection. These are not grouping dimensions: each
     * item is a qualified output binding that the frozen exploratory SQL and
     * returned result must retain before ZLens can display it.
     */
    /** Absent only on persisted pre-V4 plans; newly built plans always set it. */
    requiredOutputs?: ResolvedPlanMemberBinding[];
    timeGrain?: string;
    fields?: string[];
    periodIds?: string[];
  };
  evidenceIds: string[];
  rejectedCandidates: Array<{ id: string; reason: string }>;
  missingInformation: string[];
  clarification?: string;
  /** Typed deterministic failure retained without changing the selected plan. */
  resolutionFailure?: {
    outcome: 'clarify' | 'modeling_gap' | 'policy_blocked';
    codes: string[];
    candidateIds: string[];
    selectedCapabilityId?: string;
    selectedExecutionId?: string;
    finalCapability: ResolvedPlanCapability;
    bindings: Array<{
      kind: 'measure' | 'dimension' | 'filter' | 'output';
      requested: string;
      status: ResolvedPlanMemberBinding['status'];
      candidateIds: string[];
    }>;
  };
  knowledgeLens?: KnowledgeLens;
  /** Exact selected policy identities and source hashes used for defaults. */
  analyticalPolicies?: Array<{ policyId: string; sourceHash: string }>;
  /** Exact RFC 0005 meaning. Present iff schemaVersion is 2. */
  analyticalFrame?: AnalyticalQuestionFrameV2;
}

export interface BuildResolvedAnalyticalPlanInput {
  question: string;
  resolution: MeaningResolution;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  mode?: ResolvedAnalyticalPlan['mode'];
  /** Clock captured once by the router; used only to resolve relative time. */
  referenceTime?: Date;
}

export interface ResolvedAnalyticalPlanDelta {
  question: string;
  measures?: ResolvedPlanMemberBinding[];
  dimensions?: ResolvedPlanMemberBinding[];
  filters?: ResolvedAnalyticalPlan['query']['filters'];
  selectedResultFilter?: {
    binding: ResolvedPlanMemberBinding;
    value: string;
    sourceTurnId: string;
  };
  timeRange?: string;
  timeGrain?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  referenceTime?: Date;
  analyticalFrame?: AnalyticalQuestionFrameV2;
}

export function buildResolvedAnalyticalPlan(
  input: BuildResolvedAnalyticalPlanInput,
): ResolvedAnalyticalPlan {
  // A same-snapshot MetricFlow role extension deliberately retains the
  // source card's legacy ID so older persisted selections remain readable,
  // while carrying the capability-qualified dimension ID that the frozen
  // plan must compile.  Do not let a later, short-alias copy of that card win
  // the legacy-ID map: doing so reopens a lexically similar but unproven
  // dimension after the runtime already verified the exact grouping field.
  // This is narrowly scoped to an extension whose qualified ID is present in
  // the resolved immutable frame; ordinary duplicate retrieval cards retain
  // the historical last-card behavior.
  const frameDimensionIds = new Set(
    input.resolution.analyticalFrame?.dimensions.map((binding) => binding.dimensionId) ?? [],
  );
  const isFrameQualifiedSemanticExtension = (candidate: AgentEvidenceCandidate | undefined): boolean =>
    Boolean(
      candidate?.kind === 'semantic_member'
      && candidate.sameSnapshotRoleExtension
      && candidate.qualifiedId
      && frameDimensionIds.has(candidate.qualifiedId),
    );
  const byLegacyId = new Map<string, AgentEvidenceCandidate>();
  for (const candidate of input.candidates) {
    const existing = byLegacyId.get(candidate.id);
    if (existing && isFrameQualifiedSemanticExtension(existing) && !isFrameQualifiedSemanticExtension(candidate)) {
      continue;
    }
    byLegacyId.set(candidate.id, candidate);
  }
  const selectedCandidates = input.resolution.selectedConceptIds
    .flatMap((id) => {
      // V3 programs retain a stable qualified field identity while the legacy
      // carrier normally stores the local candidate ID.  Resolve only an
      // exact local identity first, then one exact qualified identity.  This
      // preserves a host-bound physical filter field such as
      // `dbt:column:locations.location_name` / `locations.location_name`
      // through the compiler bridge without treating an alias or leaf name as
      // authority over a different relation.
      const local = byLegacyId.get(id);
      if (local) return [local];
      const qualified = input.candidates.filter((candidate) => candidate.qualifiedId === id);
      return qualified.length === 1 ? qualified : [];
    });
  const executionCandidate = input.resolution.recommendedExecutionId
    // V3 programs carry the canonical execution authority, while legacy
    // selected concepts retain the local index ID for backwards-readable
    // receipts.  A certified block commonly has both (`dql:block:*` and
    // `domain::block::*`). Resolve either exact identity here; otherwise the
    // compiler carrier loses the selected execution authority and rebinds a
    // complete certified tuple through unrelated semantic cards.
    ? input.candidates.find((candidate) =>
      candidate.id === input.resolution.recommendedExecutionId
      || candidate.qualifiedId === input.resolution.recommendedExecutionId)
    : selectedCandidates[0];
  const bindingCandidates = input.resolution.recommendedRoute === 'certified' && executionCandidate
    // A deterministically compatible certified block has already proved the
    // complete tuple. Bind its declared inputs/outputs as one execution
    // authority instead of mixing in the semantic concept used to select it.
    ? [executionCandidate]
    // A governed-relational route may bind through its certified relationship
    // closure. Exploratory is different: the router has already selected a
    // minimal qualified physical closure before plan freeze. Re-opening the
    // whole snapshot here lets unrelated columns re-enter an exact output
    // contract and turns `order_id`/`product_id` into false ambiguities.
    : input.resolution.recommendedRoute === 'governed_sql'
    ? input.candidates
    : selectedCandidates.length > 0
      ? selectedCandidates
      : executionCandidate
        ? [executionCandidate]
        : input.candidates;
  const canonicalId = (candidate: AgentEvidenceCandidate): string => candidate.qualifiedId ?? candidate.id;
  const executionId = executionCandidate ? canonicalId(executionCandidate) : undefined;
  const measures: ResolvedPlanMemberBinding[] = input.resolution.queryIntent.measures.length > 0
    ? input.resolution.queryIntent.measures.map((requested) => bindRequestedMember(requested, bindingCandidates, 'measure', input.question))
    : selectedCandidates
      .filter((candidate) => candidate.kind === 'semantic_metric')
      .map((candidate): ResolvedPlanMemberBinding => ({
        requested: candidate.name,
        qualifiedId: canonicalId(candidate),
        status: 'resolved' as const,
        candidateIds: [canonicalId(candidate)],
      }));
  // A v2 frame has already proved the exact governed dimensional tuple. Keep
  // semantic-member evidence available for the human phrasing ("customer")
  // even when selectedConceptIds intentionally contains only requested
  // metrics.
  const dimensionBindingCandidates = input.resolution.analyticalFrame
    ? input.candidates
    : bindingCandidates;
  const selectedCapability = normalizeMetricCapabilityContract(executionCandidate?.analyticalCapability);
  const selectedCertifiedBlock = input.resolution.recommendedRoute === 'certified'
    && executionCandidate?.kind === 'certified_block'
    && executionCandidate.compatibility === 'compatible'
    ? executionCandidate
    : undefined;
  // The direct router may canonicalize a literal request (for example,
  // “food and drink”) to an exact block's declared output (`category`) after
  // that exact block independently proved the tuple. Keep that narrow
  // zero-provider projection distinct from the ordinary host requirement
  // contract below; a model-selected block can never create it.
  const exactCertifiedDimensionProjection = certifiedBlockCanUseExactCanonicalDimensionProjection(
    executionCandidate,
    input.resolution,
  );
  const hostEntityDisplayTerms = new Set(
    input.resolution.hostRequirementSeed?.requirements.entityDisplayTerms
      .map(normalize)
      .filter(Boolean) ?? [],
  );
  // A certified route is not a semantic capability route with a green badge.
  // Every host-owned grouping/display/output term must be declared by the
  // selected block itself before that block can freeze. The optional normalized
  // capability can corroborate the selected block, but it may not substitute a
  // contextual semantic field for a block output the block never promised.
  const hostCertifiedProjectionTerms = new Set([
    ...(input.resolution.hostRequirementSeed?.queryIntent.dimensions ?? []),
    // The host requirement seed retains the business entity separately from
    // its display label.  For a block that has already passed the exact-tuple
    // gate, both are projections of the block's own declared output (for
    // example `customer` -> `customer_name`).  Leaving the entity out here
    // re-bound it through a generic semantic card during the compatibility
    // carrier handoff, so a proven certified customer profile became blocked
    // after its zero-call fast path had selected it.
    ...(input.resolution.hostRequirementSeed?.requirements.entityTerms ?? []),
    ...(input.resolution.hostRequirementSeed?.requirements.entityDisplayTerms ?? []),
    ...(input.resolution.hostRequirementSeed?.requirements.outputTerms ?? []),
  ].map(normalize).filter(Boolean));
  const bindCertifiedDeclaredDimension = (
    requested: string,
  ): ResolvedPlanMemberBinding => {
    const outputName = selectedCertifiedBlock
      ? certifiedCandidateDeclaredDimensionOutput(selectedCertifiedBlock, requested)
      : undefined;
    if (!selectedCertifiedBlock || !outputName) {
      return { requested, status: 'unresolved', candidateIds: [] };
    }
    const candidateId = canonicalId(selectedCertifiedBlock);
    return {
      requested,
      qualifiedId: candidateId,
      outputName,
      status: 'resolved',
      candidateIds: [candidateId],
    };
  };
  const bindCertifiedDeclaredOutput = (
    requested: string,
  ): ResolvedPlanMemberBinding => {
    const outputName = selectedCertifiedBlock
      ? certifiedCandidateDeclaredDimensionOutput(selectedCertifiedBlock, requested)
        ?? certifiedCandidateDeclaredMeasureOutput(selectedCertifiedBlock, requested)
      : undefined;
    if (!selectedCertifiedBlock || !outputName) {
      return { requested, status: 'unresolved', candidateIds: [] };
    }
    const candidateId = canonicalId(selectedCertifiedBlock);
    return {
      requested,
      qualifiedId: candidateId,
      outputName,
      status: 'resolved',
      candidateIds: [candidateId],
    };
  };
  const bindDimension = (
    requested: string,
    roles: AnalyticalDimensionRole[],
  ): ResolvedPlanMemberBinding => {
    const normalizedRequested = normalize(requested);
    if (selectedCertifiedBlock && hostCertifiedProjectionTerms.has(normalizedRequested)) {
      return bindCertifiedDeclaredDimension(requested);
    }
    // A V2 frame is already the verified, snapshot-bound result of the
    // planner role bindings.  Re-scoring its selected dimensions against
    // every capability field can swap two valid roles when an entity label
    // and a categorical grouping coexist (for example Customer Name plus
    // Product Category).  Prefer an exact qualified frame binding when the
    // request names that field or a same-snapshot extension explicitly maps
    // the business term to it.  This is an identity-preserving projection,
    // not a lexical fallback: the frame ID must be an eligible dimension of
    // the selected capability and the extension must carry its original
    // metric/dimension proof.
    const frameOwnedDimensionIds = uniqueSorted((input.resolution.analyticalFrame?.dimensions ?? [])
      .filter((binding) => capabilityEntailsFrameDimension(selectedCapability, binding))
      .map((binding) => binding.dimensionId));
    const exactFrameIds = frameOwnedDimensionIds.filter((dimensionId) => {
      const dimension = selectedCapability?.dimensions.find((item) => item.dimensionId === dimensionId);
      if (!dimension || !roles.every((role) => dimension.supportedRoles.includes(role))) return false;
      return frameDimensionMatchesRequestedBinding({
        requested: normalizedRequested,
        dimension,
        candidates: input.candidates,
      });
    });
    if (exactFrameIds.length === 1) {
      return {
        requested,
        qualifiedId: exactFrameIds[0],
        status: 'resolved',
        candidateIds: exactFrameIds,
      };
    }
    // The candidate-ID meaning protocol cannot author a frame, but the host
    // has already bound a V2 frame from the immutable requirement seed. A
    // seeded rank/display requirement may use the human phrase `customer
    // name` while the selected MetricFlow capability truthfully names the
    // native field simply `customer`. Re-running that field through generic
    // lexical scoring loses the authoritative host binding and makes an
    // executable legacy capability look unmodeled. Reuse only the exact host
    // frame rank entity, and only after the selected capability proves every
    // required role. This is not a name-based fallback and cannot select
    // Customer Type, Customer Owner, or a cross-model same-leaf field.
    const hostRankEntityDimensionId = hostEntityDisplayTerms.has(normalizedRequested)
      ? input.resolution.analyticalFrame?.ranking?.entityDimensionId
      : undefined;
    const hostRankEntityDimension = hostRankEntityDimensionId
      ? selectedCapability?.dimensions.find((dimension) =>
        dimension.dimensionId === hostRankEntityDimensionId)
      : undefined;
    if (hostRankEntityDimension && roles.every((role) =>
      hostRankEntityDimension.supportedRoles.includes(role))) {
      return {
        requested,
        qualifiedId: hostRankEntityDimension.dimensionId,
        status: 'resolved',
        candidateIds: [hostRankEntityDimension.dimensionId],
      };
    }
    // The host-built V2 frame may intentionally retain a genuine native
    // display-key ambiguity (for example Billing Account versus Service
    // Account). Keep that exact, metric-owned choice set when RAP binds the
    // same seeded phrase. Re-running it through lexical candidate matching
    // would discard the qualified alternatives and turn a useful
    // clarification into a false “unresolved” gap. The frame is already
    // snapshot-bound; still require the selected capability to prove every
    // requested role before carrying a choice forward.
    const sourceAmbiguity = input.resolution.analyticalFrame?.ambiguity.find((entry) => {
      const [lane, ...parts] = entry.field.split('.');
      return lane === 'dimensions' && normalize(parts.join('.')) === normalizedRequested;
    });
    const sourceChoices = uniqueSorted((sourceAmbiguity?.candidateIds ?? []).filter((candidateId) =>
      eligibleCapabilityDimensions(selectedCapability, roles)
        .some((dimension) => dimension.dimensionId === candidateId)));
    if (sourceChoices.length === 1) {
      return {
        requested,
        qualifiedId: sourceChoices[0],
        status: 'resolved',
        candidateIds: sourceChoices,
      };
    }
    if (sourceChoices.length > 1) {
      return {
        requested,
        status: 'ambiguous',
        candidateIds: sourceChoices,
      };
    }
    // An exact certified block is its own execution authority. Its declared
    // output contract may use the entity identity (`customer`) where the
    // host-owned ranking seed deliberately retains the display phrase
    // (`customer name`). Do not let the optional normalized semantic
    // capability re-run that proven block output through lexical capability
    // matching: the capability is context for the block, while the block's
    // declared output is the certified proof. This remains narrow to the
    // selected compatible block and cannot bind an unrelated retrieved field.
    const certifiedOutput = selectedCertifiedBlock
      ? certifiedCandidateDeclaredDimensionOutput(selectedCertifiedBlock, requested)
      : undefined;
    if (certifiedOutput && selectedCertifiedBlock) return bindCertifiedDeclaredDimension(requested);
    const capabilityBinding = bindSelectedCapabilityDimension(
      requested,
      selectedCapability,
      roles,
      input.candidates,
    );
    // A provider frame may describe a selected capability, but it cannot pick
    // one of that capability's grouping dimensions for the host. Once a
    // normalized capability supplies a relevant binding, its identifiers,
    // roles, entity/grain and relationship proof are authoritative.
    // A selected capability owns its grouping dimensions, but when it reports
    // AMBIGUITY the question text can still settle it — and until it did, an
    // answerable lookup stopped to ask.
    if (capabilityBinding && capabilityBinding.status === 'ambiguous') {
      const settled = memberNamedInQuestion(capabilityBinding.candidateIds, input.candidates, input.question);
      if (settled) return { ...capabilityBinding, qualifiedId: settled, status: 'resolved', candidateIds: [settled] };
    }
    if (capabilityBinding && capabilityBinding.status !== 'unresolved') return capabilityBinding;
    const frameIds = uniqueSorted((input.resolution.analyticalFrame?.dimensions ?? [])
      .filter((binding) =>
        capabilityEntailsFrameDimension(selectedCapability, binding)
        && memberTermMatches(normalize(binding.dimensionId), normalizedRequested))
      .map((binding) => binding.dimensionId));
    if (frameIds.length === 1) {
      return {
        requested,
        qualifiedId: frameIds[0],
        status: 'resolved',
        candidateIds: frameIds,
      };
    }
    if (capabilityBinding) return capabilityBinding;
    return bindRequestedMember(requested, dimensionBindingCandidates, 'dimension', input.question);
  };
  const rankingRequested = input.resolution.questionType === 'ranking'
    || input.resolution.queryIntent.order !== undefined
    || input.resolution.queryIntent.limit !== undefined;
  // A ranked report can group by several dimensions, but exactly one of them
  // is the entity being ranked. Requiring `rank_entity` on every grouping
  // field made a complete tuple such as "top customers by product category"
  // clarify because `product_type` correctly supports grouping but not being
  // the ranked customer entity.
  const rankEntityDimensionId = input.resolution.analyticalFrame?.ranking?.entityDimensionId;
  const requiredDimensionRoles = (requested: string): AnalyticalDimensionRole[] => {
    if (!rankingRequested) return ['group_by'];
    const rankEntity = selectedCapability?.dimensions.find((dimension) =>
      dimension.dimensionId === rankEntityDimensionId);
    const matchesHostEntityDisplay = hostEntityDisplayTerms.has(normalize(requested))
      && Boolean(rankEntity && rankEntity.dimensionId === rankEntityDimensionId);
    const matchesRankEntity = matchesHostEntityDisplay || Boolean(rankEntity && selectedCapability
      && capabilityDimensionMatchScore(requested, rankEntity, selectedCapability, input.candidates) > 0);
    return matchesRankEntity ? ['group_by', 'rank_entity'] : ['group_by'];
  };
  // The requirement seed is the immutable, host-owned tuple for a bounded
  // meaning call.  Route reconciliation may still carry a legacy/broad
  // `queryIntent` alongside that seed for compatibility, but it must never
  // reintroduce an entity noun that the seed deliberately separated from its
  // display/rank requirement.  For example, `top customers by product
  // category` binds the host terms `customer name` and `product category`;
  // a legacy `customer` dimension would make Customer Type and Customer Order
  // Number compete with the metric-native Customer Name key after the frame
  // had already resolved it.  Structured selections are merged into the
  // seed before this point, so the seeded dimensions remain complete.
  //
  // An exact authored certified asset is a zero-provider host decision. Its
  // direct router canonicalizes literal value wording (for example, “food and
  // drink”) to the block's declared output (`category`) only after that exact
  // block itself proved the requested measures and output contract. A model
  // cannot reach this branch: candidate-ID meaning merge restores the host
  // seed before RAP construction. Preserve this narrow canonical projection
  // instead of turning a certified answer back into two invented dimensions.
  // Unseeded V1/legacy callers retain their historical query-intent path.
  const seededDimensionTerms = exactCertifiedDimensionProjection
    ? input.resolution.queryIntent.dimensions
    : input.resolution.hostRequirementSeed
      ? input.resolution.hostRequirementSeed.queryIntent.dimensions
      : input.resolution.queryIntent.dimensions;
  // A server-issued clarification choice is a typed continuation binding. It
  // may complete a display/grouping role that did not occur literally in the
  // source question (for example “Show the top names by revenue” → Customer
  // Name), but only after the router revalidated the stable choice against
  // this snapshot. Candidate-ID model output cannot use this carrier.
  const authoritativeDimensionTerms = [...new Set([
    ...seededDimensionTerms,
    ...(input.resolution.structuredDimensionIds ?? []),
  ])];
  const rawDimensions = authoritativeDimensionTerms
    .map((requested) => bindDimension(
      requested,
      requiredDimensionRoles(requested),
    ));
  // The host-owned seed retains an entity display term (for example, "customer
  // name") so a model cannot quietly turn "top customers" into an anonymous
  // entity id.  Some authored semantic/certified capabilities deliberately
  // expose that display role under the generic entity identity ("customer").
  // In that case the label is not a second requested grouping dimension.  Keep
  // it in the immutable seed/receipt, but remove only a redundant execution
  // binding when the same resolved entity proves it, or an unresolved label
  // when a resolved generic entity already covers the role.  A real explicit
  // `by customer name` dimension remains untouched because it appears in the
  // seed's ordinary dimensions as well as its display terms.
  const dimensions = collapseHostEntityDisplayBindings(
    rawDimensions,
    input.resolution.hostRequirementSeed,
  );
  // A provider may name the field it is grouping by and forget the MEMBER the
  // reader asked about: "What customer type is Wesley Jenkins?" came back with
  // `filters: []`, so the run returned all 200 customers and the narration
  // truthfully reported that his value was not present.
  //
  // ZLens had already found him. `evidence.parsedIntent.filters` are GROUNDED
  // member bindings — matched against the retrieved context, not guessed — so
  // falling back to them adds no unproven predicate. The provider's own filters
  // still win whenever it supplies any.
  const requestedFilters = input.resolution.queryIntent.filters.length > 0
    ? input.resolution.queryIntent.filters
    : (input.resolution.hostRequirementSeed?.queryIntent.filters
      ?? currentQuestionGroundedParsedIntent(input.question, input.evidence.parsedIntent)?.filters
      ?? []).filter((filter) => filter.field && filter.value);
  const filters = requestedFilters.map((filter) => ({
    ...filter,
    binding: bindDimension(filter.field, ['filter']),
  }));
  // Output terms are a distinct host-owned projection. A model may choose a
  // qualified binding for one only from the admitted snapshot, but it cannot
  // turn explicit `order ID` / `product ID` output terms into dimensions or
  // omit them from an exploratory result contract.
  //
  // Host-owned output bindings have to come from the qualified meaning
  // closure, not from the provisional route label. A meaning response may
  // still carry the legacy `governed_sql` recommendation before the cascade
  // proves whether the tuple is relational or exploratory. Re-opening the
  // complete snapshot in that state turns unrelated `orders.order_id` /
  // `raw_items.order_id` cards into false alternatives to the explicitly
  // selected `order_items.order_id` output.
  //
  // If no meaning candidate was selected, preserve the legacy evidence path
  // so a deterministic/certified binding can still explain a genuine gap.
  // Once selection exists, however, only that snapshot-bound closure can
  // satisfy a user-named output. The authorizer still proves target,
  // read-only, relation, and exact-expression safety before SQL dispatch.
  const outputBindingCandidates = selectedCandidates.length > 0
    ? selectedCandidates
    : executionCandidate
      ? [executionCandidate]
      : bindingCandidates;
  const requiredOutputs = (input.resolution.hostRequirementSeed?.requirements.outputTerms ?? [])
    .map((requested) => selectedCertifiedBlock
      ? bindCertifiedDeclaredOutput(requested)
      : bindRequestedMember(requested, outputBindingCandidates, 'output', input.question));
  const outputAuthorityCandidates = requiredOutputs.flatMap((binding) => {
    const ids = new Set([binding.qualifiedId, ...binding.candidateIds].filter((id): id is string => Boolean(id)));
    return input.candidates.filter((candidate) => ids.has(canonicalId(candidate)) || ids.has(candidate.id));
  });
  const frozenAuthorityCandidates = uniqueCandidatesByCanonicalId([
    ...selectedCandidates,
    ...(executionCandidate ? [executionCandidate] : []),
    ...outputAuthorityCandidates,
  ], canonicalId);
  const selectedConceptIds = frozenAuthorityCandidates.map(canonicalId);
  const capabilityDimensionProof = resolvedCapabilityDimensionProof(
    selectedCapability,
    dimensions,
    filters,
  );
  const proofCandidates = frozenAuthorityCandidates;
  const compatibilityProof = proofCandidates.map((candidate) => ({
    candidateId: canonicalId(candidate),
    compatibility: candidate.compatibility,
    facts: uniqueSorted([
      ...(candidate.compatibilityFacts ?? []),
      ...(candidate.id === executionCandidate?.id && selectedCapability
        ? selectedCapabilityProofFacts(selectedCapability, capabilityDimensionProof)
        : []),
    ]),
  }));
  const capability = resolveCapability(
    input.resolution,
    executionCandidate,
    measures,
    dimensions,
    filters,
    requiredOutputs,
    selectedCapability,
    frozenAuthorityCandidates,
    input.candidates,
  );
  const bindingGaps = bindingMissingInformation(measures, dimensions, filters, requiredOutputs);
  // The reader named a member that no grounding lane could bind. Answering the
  // question WITHOUT it silently changes what was asked — "what customer type
  // is Wesley Jenkins" became "list every customer" — so the plan carries it as
  // a gap rather than dropping it. Live value lookup is opt-in per project, so
  // the remedy is named here instead of leaving a bare failure: in the
  // reader's words, since a business user reads this gap. The config key
  // (agent.runtimeValueGrounding) is for admins, in Settings and the health check.
  const unboundMembers = filters.length === 0 ? (input.evidence.unboundMemberTerms ?? []) : [];
  const unboundMemberGaps = unboundMembers.length > 0
    ? [`The named value ${unboundMembers.map((term) => `“${term}”`).join(' and ')} could not be matched to a value the project knows, so it was not applied as a filter. Name the field it belongs to, or ask an admin whether searching stored values is turned on for this project.`]
    : [];
  const missingInformation = uniqueSorted([
    ...input.resolution.missingInformation,
    ...bindingGaps,
    ...unboundMemberGaps,
    ...(capability === 'blocked' && input.resolution.missingInformation.length === 0 && bindingGaps.length === 0
      ? [`The selected ${input.resolution.recommendedRoute} capability is not executable for this analytical tuple.`]
      : []),
  ]);
  const timeBounds = input.resolution.queryIntent.timeRange
    ? resolvePlanTimeRange(input.resolution.queryIntent.timeRange, input.referenceTime ?? new Date())
    : undefined;
  const snapshotId = input.evidence.knowledgeLens?.snapshotId
    ?? input.evidence.snapshotId
    ?? input.evidence.sourceFingerprint
    ?? 'snapshot-unavailable';
  const selectedExecutionCapability = selectedCapability?.executionCapabilities.find((candidate) =>
    candidate.route === input.resolution.recommendedRoute);
  const relationshipProofs = selectedCapability && selectedExecutionCapability && executionId
    ? buildResolvedRelationshipProofsV1({
        capability: selectedCapability,
        dimensionIds: capabilityDimensionProof.map((dimension) => dimension.dimensionId),
        route: selectedExecutionCapability.route,
        ...(selectedExecutionCapability.adapterId ? { adapterId: selectedExecutionCapability.adapterId } : {}),
        executionId,
        snapshotId,
      })
    : [];
  const governedRelationshipSafetyProofs = selectedCapability
    && selectedExecutionCapability?.route === 'governed_sql'
    ? buildGovernedRelationshipSafetyProofsV1({
        capability: selectedCapability,
        dimensions: capabilityDimensionProof,
        candidates: input.candidates,
        snapshotId,
      })
    : [];
  const payload = {
    schemaVersion: input.resolution.analyticalFrame
      ? (2 as const)
      : (1 as const),
    mode: input.mode ?? ("authoritative" as const),
    revision: 0,
    snapshotId,
    sourceFingerprint: input.evidence.sourceFingerprint,
    question: input.question,
    interpretedQuestion: input.resolution.interpretedQuestion,
    questionType: input.resolution.questionType,
    confidence: input.resolution.confidence,
    selectedConceptIds,
    executionId,
    ...(selectedCapability
      ? {
          selectedCapability,
          selectedCapabilityFingerprint: selectedCapability.sourceFingerprint,
        }
      : {}),
    recommendedRoute: input.resolution.recommendedRoute,
    capability,
    query: {
      measures,
      dimensions,
      filters,
      ...(input.resolution.queryIntent.timeRange ? { timeRange: input.resolution.queryIntent.timeRange } : {}),
      ...(timeBounds ? { timeBounds } : {}),
      ...(input.resolution.queryIntent.timeGrain ? { timeGrain: input.resolution.queryIntent.timeGrain } : {}),
      ...(input.resolution.queryIntent.order ? { order: input.resolution.queryIntent.order } : {}),
      ...(input.resolution.queryIntent.limit !== undefined ? { limit: input.resolution.queryIntent.limit } : {}),
    },
    entityGrain: selectedCapability
      ? resolvedCapabilityEntityGrain(selectedCapability, dimensions)
      : input.resolution.analyticalFrame?.entityGrainIds[0] ?? executionCandidate?.primaryEntity,
    sourceRelationIds: uniqueSorted(
      frozenAuthorityCandidates.flatMap((candidate) => candidate.sourceObjects ?? []),
    ),
    relationshipPathIds: selectedCapability
      ? uniqueSorted(relationshipProofs.flatMap((proof) =>
        proof.kind === 'dql_relationship_path' ? proof.relationshipPathIds : []))
      : uniqueSorted(frozenAuthorityCandidates.flatMap(
        (candidate) => candidate.relationshipEvidence ?? [],
      )),
    relationshipProofs,
    governedRelationshipSafetyProofs,
    compatibilityProof,
    outputContract: {
      measures: uniqueSorted(
      measures.flatMap((binding) =>
          binding.outputName ? [binding.outputName] : binding.qualifiedId ? [binding.qualifiedId] : [binding.requested],
        ),
      ),
      dimensions: uniqueSorted(
        dimensions.flatMap((binding) =>
          binding.outputName ? [binding.outputName] : binding.qualifiedId ? [binding.qualifiedId] : [binding.requested],
        ),
      ),
      requiredOutputs: requiredOutputs.map(cloneBinding),
      ...(input.resolution.queryIntent.timeGrain
        ? { timeGrain: input.resolution.queryIntent.timeGrain }
        : {}),
      ...(input.resolution.analyticalFrame
        ? {
            fields: input.resolution.analyticalFrame.requestedOutputs.map(
              (output) => output.id,
            ),
            periodIds:
              input.resolution.analyticalFrame.timeContext?.periods.map(
                (period) => period.id,
              ) ?? [],
          }
        : {}),
    },
    evidenceIds: uniqueSorted(input.candidates.map(canonicalId)),
    rejectedCandidates: input.resolution.rejectedCandidates.map((candidate) => {
      const retrieved = byLegacyId.get(candidate.id);
      return { id: retrieved ? canonicalId(retrieved) : candidate.id, reason: candidate.reason };
    }),
    missingInformation,
    clarification: input.resolution.clarifyingQuestion,
    ...(capability === 'blocked'
      ? {
          resolutionFailure: {
            outcome: input.resolution.compatibilityOutcome
              ?? (input.resolution.recommendedRoute === 'clarify' || input.resolution.confidence === 'low'
                ? 'clarify'
                : bindingCandidateIds(measures, dimensions, filters, requiredOutputs).length > 0
                  ? 'clarify'
                  : 'modeling_gap'),
            codes: uniqueSorted([
              ...(input.resolution.compatibilityFailures ?? []).map((failure) => failure.code),
              ...bindingFailureCodes(measures, dimensions, filters, requiredOutputs),
            ]),
            candidateIds: uniqueSorted([
              ...(input.resolution.compatibilityFailures ?? []).flatMap((failure) => failure.candidateIds),
              ...bindingCandidateIds(measures, dimensions, filters, requiredOutputs),
            ]),
            ...(selectedCapability?.metricId
              ? { selectedCapabilityId: selectedCapability.metricId }
              : {}),
            ...(executionId ? { selectedExecutionId: executionId } : {}),
            finalCapability: capability,
            bindings: unresolvedBindingReceipts(measures, dimensions, filters, requiredOutputs),
          },
        }
      : {}),
    knowledgeLens: input.evidence.knowledgeLens,
    ...((input.resolution.analyticalPolicyIds?.length ?? 0) > 0
      ? {
          analyticalPolicies: input.resolution
            .analyticalPolicyIds!.flatMap((policyId) => {
              const policy = input.evidence.analyticalPolicies?.find(
                (candidate) => candidate.policyId === policyId,
              );
              return policy
                ? [{ policyId, sourceHash: policy.sourceHash }]
                : [];
            })
            .sort((left, right) => left.policyId.localeCompare(right.policyId)),
        }
      : {}),
    ...(input.resolution.analyticalFrame
      ? { analyticalFrame: structuredClone(input.resolution.analyticalFrame) }
      : {}),
  };
  const fingerprint = sha256(stableStringify(payload));
  return deepFreeze({
    ...payload,
    planId: `rap:${fingerprint.slice(0, 24)}`,
    fingerprint,
  });
}

/**
 * The selected metric capability is the sole authority for metric-relative
 * dimensions. Standalone member cards can help the model explain meaning, but
 * cannot introduce a second execution binding or substitute a same-name ID.
 */
function bindSelectedCapabilityDimension(
  requested: string,
  capability: MetricCapabilityContract | undefined,
  requiredRoles: AnalyticalDimensionRole[],
  candidates: AgentEvidenceCandidate[],
): ResolvedPlanMemberBinding | undefined {
  if (!capability) return undefined;
  const eligible = eligibleCapabilityDimensions(capability, requiredRoles);
  const exactIds = uniqueSorted(eligible
    .filter((dimension) => dimension.dimensionId === requested)
    .map((dimension) => dimension.dimensionId));
  if (exactIds.length === 1) {
    return {
      requested,
      qualifiedId: exactIds[0],
      status: 'resolved',
      candidateIds: exactIds,
    };
  }
  const requestedEntityEvidence = candidates.filter((candidate) =>
    candidate.semanticObjectType === 'entity'
    && candidateTerms(candidate).some((term) =>
      termMatchSpecificity(term, canonicalTokens(requested)) > 0));
  const entityScoped = requestedEntityEvidence.length > 0
    ? eligible.filter((dimension) => capabilityDimensionMatchesEntityEvidence(
      dimension,
      requestedEntityEvidence,
    ))
    : [];
  const bindingPool = entityScoped.length > 0 ? entityScoped : eligible;
  const scored = bindingPool
    .map((dimension) => ({
      dimension,
      score: capabilityDimensionMatchScore(requested, dimension, capability, candidates),
    }))
    .filter((match) => match.score > 0);
  if (scored.length === 0) {
    return {
      requested,
      status: 'unresolved',
      // Role-compatible but semantically unrelated members are not choices a
      // user can use to repair this binding. Keep the list empty so the router
      // reports a modeling/binding gap instead of offering arbitrary booleans.
      candidateIds: [],
    };
  }
  const bestScore = Math.max(...scored.map((match) => match.score));
  const matches = scored
    .filter((match) => match.score === bestScore)
    .map((match) => match.dimension);
  const ids = uniqueSorted(matches.map((dimension) => dimension.dimensionId));
  return {
    requested,
    ...(ids.length === 1 ? { qualifiedId: ids[0] } : {}),
    status: ids.length === 1 ? 'resolved' : 'ambiguous',
    candidateIds: ids,
  };
}

function capabilityDimensionMatchScore(
  requested: string,
  dimension: MetricCapabilityContract['dimensions'][number],
  capability: MetricCapabilityContract,
  candidates: AgentEvidenceCandidate[],
): number {
  const requestedTokens = canonicalTokens(requested);
  if (requestedTokens.length === 0) return 0;
  const evidenceTerms = candidates
    .filter((candidate) => candidate.kind === 'semantic_member'
      && candidate.semanticObjectType !== 'entity'
      && (candidate.qualifiedId ?? candidate.id) === dimension.dimensionId)
    .flatMap((candidate) => [candidate.name, ...(candidate.aliases ?? [])]);
  const evidenceScore = Math.max(0, ...evidenceTerms.map((term) =>
    termMatchSpecificity(term, requestedTokens)));
  const authoredDisplayScore = Math.max(
    0,
    ...[dimension.label, ...(dimension.aliases ?? [])]
      .filter((term): term is string => Boolean(term))
      .map((term) => termMatchSpecificity(term, requestedTokens)),
  );
  const localScore = termMatchSpecificity(localQualifiedLeaf(dimension.dimensionId), requestedTokens);
  const conventionalIdentityScore = conventionalIdentitySpecificity(
    localQualifiedLeaf(dimension.dimensionId),
    requestedTokens,
  );
  const entityScore = termMatchSpecificity(localQualifiedLeaf(dimension.entityId), requestedTokens);
  const identityScore = Math.max(
    evidenceScore > 0 ? 1_000 + evidenceScore : 0,
    authoredDisplayScore > 0 ? 900 + authoredDisplayScore : 0,
    conventionalIdentityScore > 0 ? 1_100 + conventionalIdentityScore : 0,
    localScore > 0 ? 600 + localScore : 0,
    entityScore > 0 ? 300 + entityScore : 0,
  );
  if (identityScore === 0) return 0;
  const authorityScore =
    (dimension.supportedRoles.includes('display') ? 8 : 0)
    + (dimension.entityId === capability.primaryEntityId ? 4 : 0)
    + (capability.resultGrainIds.includes(dimension.entityId) ? 4 : 0)
    + ((dimension.relationshipPathIds?.length ?? 0) > 0 ? 4 : 0);
  return identityScore + authorityScore;
}

/**
 * Match a frozen V2 frame dimension only through its own qualified identity,
 * authored label/alias, or the host-authored same-snapshot extension that
 * produced the frame.  The latter is intentionally exact: a capability
 * extension records both the original requested business term and the native
 * MetricFlow dimension ID, so it can carry `product category` to
 * `order_items.product_type` without turning arbitrary semantic aliases into
 * compiler authority.
 */
function frameDimensionMatchesRequestedBinding(input: {
  requested: string;
  dimension: MetricCapabilityContract['dimensions'][number];
  candidates: AgentEvidenceCandidate[];
}): boolean {
  if (!input.requested) return false;
  const namespaceTail = input.dimension.dimensionId.split(':').at(-1) ?? input.dimension.dimensionId;
  const identities = [
    input.dimension.dimensionId,
    namespaceTail,
    input.dimension.label,
    ...(input.dimension.aliases ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalize);
  if (identities.includes(input.requested)) return true;
  return input.candidates.some((candidate) => {
    const extension = candidate.sameSnapshotRoleExtension;
    if (!extension
      || extension.version !== 1
      || extension.role !== 'categorical_dimension'
      || normalize(extension.requestedTerm) !== input.requested) return false;
    const candidateId = candidate.qualifiedId ?? candidate.id;
    return candidateId === input.dimension.dimensionId
      && extension.dimensionId === input.dimension.dimensionId;
  });
}

function conventionalIdentitySpecificity(term: string, requestedTokens: string[]): number {
  const termTokens = canonicalTokens(term);
  if (!requestedTokens.every((token) => termTokens.includes(token))) return 0;
  const remaining = termTokens.filter((token) => !requestedTokens.includes(token));
  const identityDescriptors = new Set(['display', 'identifier', 'id', 'key', 'label', 'name', 'title']);
  return remaining.length === 1 && identityDescriptors.has(remaining[0]!) ? 100 : 0;
}

function capabilityDimensionMatchesEntityEvidence(
  dimension: MetricCapabilityContract['dimensions'][number],
  entityCandidates: AgentEvidenceCandidate[],
): boolean {
  const ownerTokens = canonicalTokens(localQualifiedOwner(dimension.dimensionId));
  return entityCandidates.some((candidate) => {
    const candidateId = candidate.qualifiedId ?? candidate.id;
    if (dimension.entityId === candidateId) return true;
    if (ownerTokens.length === 0) return false;
    const entityTerms = [candidate.name, ...(candidate.aliases ?? []), localQualifiedLeaf(candidateId)];
    return entityTerms.some((term) => {
      const tokens = canonicalTokens(localQualifiedLeaf(term));
      return tokens.length > 0 && tokens.every((token) => ownerTokens.includes(token));
    });
  });
}

function termMatchSpecificity(term: string, requestedTokens: string[]): number {
  const termTokens = canonicalTokens(term);
  if (termTokens.length === 0 || !requestedTokens.every((token) => termTokens.includes(token))) return 0;
  if (termTokens.length === requestedTokens.length
    && termTokens.every((token, index) => token === requestedTokens[index])) return 100;
  return 50 + requestedTokens.length;
}

function canonicalTokens(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter(Boolean)
    .map(singularizeBindingToken);
}

function singularizeBindingToken(value: string): string {
  if (value.length <= 4 || value.endsWith('ss') || value.endsWith('us') || value.endsWith('is')) return value;
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  return value.endsWith('s') ? value.slice(0, -1) : value;
}

function localQualifiedLeaf(value: string): string {
  const leaf = value.split(/[:./]+/).filter(Boolean).at(-1);
  return leaf ?? value;
}

function localQualifiedOwner(value: string): string {
  const local = value.split(':').at(-1) ?? value;
  const segments = local.split(/[./]+/).filter(Boolean);
  return segments.length > 1 ? segments[0]! : '';
}

function eligibleCapabilityDimensions(
  capability: MetricCapabilityContract | undefined,
  requiredRoles: AnalyticalDimensionRole[],
): MetricCapabilityContract['dimensions'] {
  if (!capability) return [];
  return capability.dimensions.filter((dimension) => {
    if (!requiredRoles.every((role) => dimension.supportedRoles.includes(role))) return false;
    const sameEntity = dimension.entityId === capability.primaryEntityId;
    // A semantic metric may only use a cross-model dimension when the
    // capability carries the exact adapter-native grouping reference which
    // the compiler can consume. Result-grain membership and a generic DQL
    // relationship ID prove neither MetricFlow spelling nor semantic adapter
    // reachability, so they must not admit a semantic freeze on their own.
    // Non-semantic routes retain their separately governed relationship
    // authority below.
    const semanticNativeGroupingProven = semanticNativeGroupingIsExact(capability, dimension);
    const nonSemanticRoute = capability.executionCapabilities.some((execution) => execution.route !== 'semantic');
    const relationalProof = nonSemanticRoute
      && (capability.resultGrainIds.includes(dimension.entityId)
        || (dimension.relationshipPathIds?.length ?? 0) > 0);
    return sameEntity || semanticNativeGroupingProven || relationalProof;
  });
}

/**
 * Verify a cross-model semantic grouping before it is allowed to bind the
 * frozen plan. The capability is the only authority here: leaf-name equality,
 * a broad result grain, and a physical/DQL relationship are intentionally not
 * enough to claim MetricFlow can compose this tuple.
 */
function semanticNativeGroupingIsExact(
  capability: MetricCapabilityContract,
  dimension: MetricCapabilityContract['dimensions'][number],
): boolean {
  return dimension.entityId === capability.primaryEntityId
    || semanticDimensionUsesExactAdapterGrouping(capability, dimension);
}

function capabilityEntailsFrameDimension(
  capability: MetricCapabilityContract | undefined,
  binding: { dimensionId: string; role: AnalyticalDimensionRole },
): boolean {
  if (!capability) return false;
  if (binding.role === 'time_axis') {
    return capability.timeDimensions.some((dimension) =>
      dimension.dimensionId === binding.dimensionId);
  }
  return eligibleCapabilityDimensions(capability, [binding.role])
    .some((dimension) => dimension.dimensionId === binding.dimensionId);
}

function resolvedCapabilityDimensionProof(
  capability: MetricCapabilityContract | undefined,
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
): MetricCapabilityContract['dimensions'] {
  if (!capability) return [];
  const boundIds = new Set([
    ...dimensions.flatMap((binding) => binding.qualifiedId ? [binding.qualifiedId] : []),
    ...filters.flatMap((filter) =>
      filter.binding.qualifiedId ? [filter.binding.qualifiedId] : []),
  ]);
  return capability.dimensions
    .filter((dimension) => boundIds.has(dimension.dimensionId))
    .sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
}

function resolvedCapabilityEntityGrain(
  capability: MetricCapabilityContract,
  dimensions: ResolvedPlanMemberBinding[],
): string {
  const groupedIds = new Set(dimensions.flatMap((binding) =>
    binding.qualifiedId ? [binding.qualifiedId] : []));
  const groupedEntityIds = uniqueSorted(capability.dimensions
    .filter((dimension) => groupedIds.has(dimension.dimensionId))
    .map((dimension) => dimension.entityId));
  if (groupedEntityIds.length === 1 && capability.resultGrainIds.includes(groupedEntityIds[0]!)) {
    return groupedEntityIds[0]!;
  }
  return capability.defaultResultGrainId;
}

function selectedCapabilityProofFacts(
  capability: MetricCapabilityContract,
  dimensions: MetricCapabilityContract['dimensions'],
): string[] {
  return [
    `capability:metric:${capability.metricId}`,
    `capability:primary_entity:${capability.primaryEntityId}`,
    `capability:default_result_grain:${capability.defaultResultGrainId}`,
    ...capability.resultGrainIds.map((grain) => `capability:result_grain:${grain}`),
    ...dimensions.map((dimension) => `capability:dimension:${dimension.dimensionId}:${dimension.entityId}`),
    ...dimensions.flatMap((dimension) => dimension.nativeGroupingReference
      ? [`capability:native_grouping:${dimension.dimensionId}:${dimension.nativeGroupingReference}`]
      : []),
    ...dimensions.flatMap((dimension) =>
      (dimension.relationshipPathIds ?? []).map((relationshipId) =>
        `capability:relationship:${relationshipId}`)),
    ...capability.executionCapabilities.map((execution) =>
      `capability:route:${execution.route}:${execution.adapterId ?? 'native'}`),
  ];
}

function unresolvedBindingReceipts(
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
  requiredOutputs: ResolvedPlanMemberBinding[] = [],
): NonNullable<ResolvedAnalyticalPlan['resolutionFailure']>['bindings'] {
  return [
    ...measures.map((binding) => ({ kind: 'measure' as const, binding })),
    ...dimensions.map((binding) => ({ kind: 'dimension' as const, binding })),
    ...filters.map((filter) => ({ kind: 'filter' as const, binding: filter.binding })),
    ...requiredOutputs.map((binding) => ({ kind: 'output' as const, binding })),
  ]
    .filter(({ binding }) => binding.status !== 'resolved')
    .map(({ kind, binding }) => ({
      kind,
      requested: binding.requested,
      status: binding.status,
      candidateIds: [...binding.candidateIds],
    }));
}

function bindingCandidateIds(
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
  requiredOutputs: ResolvedPlanMemberBinding[] = [],
): string[] {
  return unresolvedBindingReceipts(measures, dimensions, filters, requiredOutputs)
    .flatMap((binding) => binding.candidateIds);
}

function bindingFailureCodes(
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
  requiredOutputs: ResolvedPlanMemberBinding[] = [],
): string[] {
  return unresolvedBindingReceipts(measures, dimensions, filters, requiredOutputs)
    .map((binding) => `${binding.kind.toUpperCase()}_${binding.status.toUpperCase()}`);
}

function bindingMissingInformation(
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
  requiredOutputs: ResolvedPlanMemberBinding[] = [],
): string[] {
  return [
    ...measures.map((binding) => ({ kind: 'measure', binding })),
    ...dimensions.map((binding) => ({ kind: 'dimension', binding })),
    ...filters.map((filter) => ({ kind: 'filter', binding: filter.binding })),
    ...requiredOutputs.map((binding) => ({ kind: 'output', binding })),
  ].flatMap(({ kind, binding }) => {
    if (binding.status === 'resolved') return [];
    const choices = binding.candidateIds.length > 0
      ? ` Qualified choices: ${binding.candidateIds.join(', ')}.`
      : '';
    return [`Requested ${kind} “${binding.requested}” is ${binding.status}.${choices}`];
  });
}

/**
 * Apply an explicitly typed follow-up delta. No prose, prior SQL, or answer text
 * is inspected; every carried member remains a qualified binding from the root.
 * Acceptance: CTX-003, AGT-013, AGT-016.
 */
export function deriveResolvedAnalyticalPlan(
  parent: ResolvedAnalyticalPlan,
  delta: ResolvedAnalyticalPlanDelta,
): ResolvedAnalyticalPlan {
  const dimensions = delta.dimensions ? delta.dimensions.map(cloneBinding) : parent.query.dimensions.map(cloneBinding);
  const measures = delta.measures ? delta.measures.map(cloneBinding) : parent.query.measures.map(cloneBinding);
  const filters = delta.filters
    ? delta.filters.map(cloneFilter)
    : parent.query.filters.map(cloneFilter);
  if (delta.selectedResultFilter) {
    filters.push({
      field: delta.selectedResultFilter.binding.requested,
      value: delta.selectedResultFilter.value,
      binding: cloneBinding(delta.selectedResultFilter.binding),
    });
  }
  const timeRange = delta.timeRange !== undefined ? delta.timeRange : parent.query.timeRange;
  // An inherited relative range is already bound to the root plan's captured
  // clock. Re-resolving "last month" during a later turn would silently change
  // the analytical contract, so only an explicit time delta gets a new clock.
  const timeBounds = delta.timeRange !== undefined
    ? (timeRange ? resolvePlanTimeRange(timeRange, delta.referenceTime ?? new Date()) : undefined)
    : parent.query.timeBounds;
  const unresolved = [...measures, ...dimensions, ...filters.map((filter) => filter.binding)]
    .concat((parent.outputContract.requiredOutputs ?? []).map(cloneBinding))
    .filter((binding) => binding.status !== 'resolved');
  const payload = {
    ...parent,
    parentPlanId: parent.planId,
    rootPlanId: parent.rootPlanId ?? parent.planId,
    revision: parent.revision + 1,
    question: delta.question,
    interpretedQuestion: delta.question,
    capability: unresolved.length > 0 ? 'blocked' as const : parent.capability,
    query: {
      measures,
      dimensions,
      filters,
      ...(timeRange ? { timeRange } : {}),
      ...(timeBounds ? { timeBounds } : {}),
      ...((delta.timeGrain ?? parent.query.timeGrain) ? { timeGrain: delta.timeGrain ?? parent.query.timeGrain } : {}),
      ...((delta.order ?? parent.query.order) ? { order: delta.order ?? parent.query.order } : {}),
      ...(delta.limit !== undefined || parent.query.limit !== undefined ? { limit: delta.limit ?? parent.query.limit } : {}),
    },
    outputContract: {
      measures: uniqueSorted(
      measures.flatMap((binding) =>
          binding.outputName ? [binding.outputName] : binding.qualifiedId ? [binding.qualifiedId] : [binding.requested],
        ),
      ),
      dimensions: uniqueSorted(
        dimensions.flatMap((binding) =>
          binding.outputName ? [binding.outputName] : binding.qualifiedId ? [binding.qualifiedId] : [binding.requested],
        ),
      ),
      requiredOutputs: (parent.outputContract.requiredOutputs ?? []).map(cloneBinding),
      ...((delta.timeGrain ?? parent.query.timeGrain)
        ? { timeGrain: delta.timeGrain ?? parent.query.timeGrain }
        : {}),
      ...((delta.analyticalFrame ?? parent.analyticalFrame)
        ? {
            fields: (delta.analyticalFrame ??
              parent.analyticalFrame)!.requestedOutputs.map(
              (output) => output.id,
            ),
            periodIds:
              (delta.analyticalFrame ??
                parent.analyticalFrame)!.timeContext?.periods.map(
                (period) => period.id,
              ) ?? [],
          }
        : {}),
    },
    missingInformation:
      unresolved.length > 0
        ? uniqueSorted([
            ...parent.missingInformation,
            ...unresolved.map(
              (binding) => `${binding.requested} is ${binding.status}.`,
            ),
          ])
        : [...parent.missingInformation],
    ...(delta.analyticalFrame
      ? {
          schemaVersion: 2 as const,
          analyticalFrame: structuredClone(delta.analyticalFrame),
        }
      : {}),
  };
  const { planId: _oldPlanId, fingerprint: _oldFingerprint, ...fingerprintPayload } = payload;
  const fingerprint = sha256(stableStringify(fingerprintPayload));
  return deepFreeze({
    ...fingerprintPayload,
    planId: `rap:${fingerprint.slice(0, 24)}`,
    fingerprint,
  });
}

function cloneBinding(binding: ResolvedPlanMemberBinding): ResolvedPlanMemberBinding {
  return { ...binding, candidateIds: [...binding.candidateIds] };
}

function cloneFilter(filter: ResolvedAnalyticalPlan['query']['filters'][number]): ResolvedAnalyticalPlan['query']['filters'][number] {
  return { ...filter, binding: cloneBinding(filter.binding) };
}

/**
 * Disambiguate a member binding using the QUESTION TEXT.
 *
 * A planner (or a provider) often reduces "customer type" to the bare term
 * `type`, and worse, may split it into two requested dimensions ("customer",
 * "type"). A bare `type` then matches `customers.customer_type` AND
 * `products.product_type` and reads as ambiguous, so an answerable question
 * stops to ask which dimension was meant. The question already answers it:
 * "customer type" appears in it and "product type" does not.
 *
 * Returns the single id the reader actually named, or undefined when the text
 * does not settle it. Only multi-word names count — one shared token is not
 * evidence.
 */
function memberNamedInQuestion(
  ids: string[],
  candidates: AgentEvidenceCandidate[],
  question: string,
): string | undefined {
  if (ids.length < 2) return undefined;
  const questionText = normalize(question);
  if (!questionText) return undefined;
  const named = ids.filter((id) => {
    const candidate = candidates.find((item) => (item.qualifiedId ?? item.id) === id || item.id === id);
    const terms = [candidate?.name ?? '', ...(candidate?.aliases ?? []), id.split(/[.:/]/).at(-1) ?? '']
      .map((term) => normalize(String(term)))
      .filter((term) => term.split(' ').length > 1);
    return terms.some((term) =>
      questionText === term
      || questionText.startsWith(`${term} `)
      || questionText.endsWith(` ${term}`)
      || questionText.includes(` ${term} `));
  });
  return named.length === 1 ? named[0] : undefined;
}

function bindRequestedMember(
  requested: string,
  candidates: AgentEvidenceCandidate[],
  kind: 'measure' | 'dimension' | 'output',
  question = '',
): ResolvedPlanMemberBinding {
  const normalized = normalize(requested);
  // A lexical decoy that compatibility already rejected must never introduce
  // a second binding identity into the frozen plan. Only candidates still
  // eligible for the requested tuple can contribute member authority.
  const eligibleCandidates = candidates.filter((candidate) => candidate.compatibility !== 'incompatible');
  const kindCandidates = eligibleCandidates.filter((candidate) => {
    const kindMatches = kind === 'measure'
      ? candidate.kind === 'semantic_metric' || candidate.kind === 'sql_column'
      : kind === 'dimension'
        ? candidate.kind === 'semantic_member' || candidate.kind === 'sql_column'
        // Explicit projected fields are not grouping dimensions. A metric can
        // satisfy a requested price/revenue output only when it is selected as
        // the measure; the projection lane itself accepts qualified members or
        // physical columns.
        : candidate.kind === 'semantic_member' || candidate.kind === 'sql_column';
    return kindMatches;
  });
  // Explicit outputs are a projection contract, not an approximate semantic
  // search. Prefer a physical qualified column whose leaf is exactly the
  // requested field. This keeps `product_id` from becoming an alternative for
  // `order id` through a noisy alias and collapses duplicate cards for the
  // same physical relation.column. Different exact physical columns remain
  // distinct, so genuine ambiguity is still surfaced for clarification.
  const exactOutputCandidates = kind === 'output'
    ? exactOutputBindingCandidates(kindCandidates, normalized)
    : [];
  const directCandidates = kind === 'output'
    ? exactOutputCandidates.length > 0 || isExplicitOutputIdentity(normalized)
      ? exactOutputCandidates
      : uniqueOutputBindingCandidates(kindCandidates.filter((candidate) =>
        candidateTerms(candidate).some((term) => memberTermMatches(term, normalized))))
    : kindCandidates.filter((candidate) =>
      candidateTerms(candidate).some((term) => memberTermMatches(term, normalized)));
  const collectedIds = uniqueSorted([
    ...directCandidates.map((candidate) => candidate.qualifiedId ?? candidate.id),
    ...(kind === 'dimension' ? eligibleCandidates.flatMap((candidate) =>
      (candidate.dimensions ?? []).filter((dimension) => {
        const value = normalize(dimension);
        return value === normalized || value.endsWith(` ${normalized}`);
      }).map((dimension) => qualifyDeclaredDimension(candidate, dimension))) : []),
  ]);
  // A candidate contributes its qualified identity AND its own declared
  // dimension list, so a dimension that IS the candidate arrived twice —
  // `semantic:dimension:customers.customer_type` alongside a bare
  // `customer_type`. Two ids read as ambiguous, the binding failed, and the
  // plan blocked, which is why a metric-free attribute lookup could never
  // freeze. A bare name that is the LEAF of a qualified id in the same set is
  // the same member named twice, not a second choice.
  const qualifiedIds = collectedIds.filter((id) => /[:./]/.test(id));
  const ids = collectedIds.filter((id) => {
    if (/[:./]/.test(id)) return true;
    const bare = normalize(id);
    return !qualifiedIds.some((qualified) =>
      normalize(qualified.split(/[.:/]/).at(-1) ?? '') === bare);
  });
  if (ids.length === 0 && kind === 'measure' && eligibleCandidates.length === 1) {
    const certified = eligibleCandidates[0]!;
    const outputName = certifiedCandidateDeclaredMeasureOutput(certified, requested);
    if (certified.kind === 'certified_block'
      && certified.compatibility === 'compatible'
      && certifiedCandidateExplicitlyCoversMeasures(certified, [requested])
      && outputName) {
      const id = certified.qualifiedId ?? certified.id;
      return {
        requested,
        qualifiedId: id,
        outputName,
        status: 'resolved',
        candidateIds: [id],
      };
    }
  }
  if (ids.length === 0 && (kind === 'dimension' || kind === 'output') && eligibleCandidates.length === 1) {
    const certified = eligibleCandidates[0]!;
    const outputName = certifiedCandidateDeclaredDimensionOutput(certified, requested);
    if (certified.kind === 'certified_block'
      && certified.compatibility === 'compatible'
      && outputName) {
      const id = certified.qualifiedId ?? certified.id;
      return {
        requested,
        qualifiedId: id,
        outputName,
        status: 'resolved',
        candidateIds: [id],
      };
    }
  }
  const namedWinner = memberNamedInQuestion(ids, eligibleCandidates, question);
  if (namedWinner) {
    const winnerCandidate = directCandidates.find((candidate) => (candidate.qualifiedId ?? candidate.id) === namedWinner);
    return {
      requested,
      qualifiedId: namedWinner,
      ...(kind === 'output' ? { outputName: outputNameForCandidate(winnerCandidate, namedWinner) } : {}),
      ...(winnerCandidate?.aggregation ? { aggregation: winnerCandidate.aggregation } : {}),
      status: 'resolved',
      candidateIds: [namedWinner],
    };
  }

  const direct = ids.length === 1
    ? directCandidates.find((candidate) => (candidate.qualifiedId ?? candidate.id) === ids[0])
    : undefined;
  return {
    requested,
    ...(ids.length === 1 ? { qualifiedId: ids[0] } : {}),
    ...(kind === 'output' && ids.length === 1
      ? { outputName: outputNameForCandidate(direct, ids[0]!) }
      : {}),
    ...(direct?.aggregation ? { aggregation: direct.aggregation } : {}),
    status: ids.length === 1 ? 'resolved' : ids.length > 1 ? 'ambiguous' : 'unresolved',
    candidateIds: ids,
  };
}

/**
 * Return the exact host-authoritative output candidates for a requested
 * projection. Physical columns win over descriptive semantic aliases: when a
 * selected closure contains `order_items.order_id`, a semantic entity named
 * `order_id` is useful retrieval context but is not a competing SQL output.
 */
function exactOutputBindingCandidates(
  candidates: AgentEvidenceCandidate[],
  requested: string,
): AgentEvidenceCandidate[] {
  const exactPhysical = candidates.filter((candidate) =>
    physicalOutputColumnLeaf(candidate) === requested);
  if (exactPhysical.length > 0) return uniqueOutputBindingCandidates(exactPhysical);

  // Semantic projections do not always carry a physical column identity. They
  // may still bind if their declared name itself is exact; aliases alone never
  // have authority to substitute one requested identifier for another.
  return uniqueOutputBindingCandidates(candidates.filter((candidate) =>
    normalize(candidate.name) === requested));
}

/**
 * A requested `... id` / `... identifier` must not fall back to lexical alias
 * matching. In particular, an alias attached to product_id cannot make it a
 * candidate for order_id when no actual order_id is selected.
 */
function isExplicitOutputIdentity(requested: string): boolean {
  return /(?:^| )(?:id|identifier)$/.test(requested);
}

function physicalOutputColumnLeaf(candidate: AgentEvidenceCandidate): string | undefined {
  if (candidate.kind !== 'sql_column') return undefined;
  const raw = candidate.qualifiedId ?? candidate.id;
  const columnReference = raw.replace(/^(?:dbt|runtime):column:/i, '');
  const leaf = columnReference.split('.').at(-1);
  const normalized = normalize(leaf ?? '');
  return normalized || undefined;
}

/**
 * Candidate IDs can be emitted once by the dbt manifest and again by runtime
 * schema/index lanes. They describe one output only when their canonical
 * physical relation.column is identical. Do not dedupe two relations that
 * merely share the same leaf: that remains a real ambiguity.
 */
function uniqueOutputBindingCandidates(
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const identity = canonicalOutputBindingIdentity(candidate);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function canonicalOutputBindingIdentity(candidate: AgentEvidenceCandidate): string {
  if (candidate.kind === 'sql_column') {
    const raw = candidate.qualifiedId ?? candidate.id;
    const columnReference = raw.replace(/^(?:dbt|runtime):column:/i, '');
    if (columnReference.includes('.')) return `physical:${normalize(columnReference)}`;
  }
  return `candidate:${candidate.qualifiedId ?? candidate.id}`;
}

/**
 * A selected physical/semantic output's alias is part of the frozen result
 * contract. Prefer the inspected candidate name; a qualified-id leaf is a
 * safe fallback for machine-authored dbt/sql column identities.
 */
function outputNameForCandidate(
  candidate: AgentEvidenceCandidate | undefined,
  qualifiedId: string,
): string {
  const candidateName = candidate?.name?.trim();
  if (candidateName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidateName)) return candidateName;
  const leaf = qualifiedId.split(/[:.]/).at(-1)?.replace(/[^A-Za-z0-9_]/g, '_');
  return leaf && /^[A-Za-z_][A-Za-z0-9_]*$/.test(leaf)
    ? leaf
    : normalize(candidateName || qualifiedId).replace(/\s+/g, '_');
}

function qualifyDeclaredDimension(candidate: AgentEvidenceCandidate, dimension: string): string {
  if (/[:./]/.test(dimension) || !candidate.domain) return dimension;
  const domain = candidate.domain.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  const local = dimension.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return `semantic:${domain}:dimension:${local}`;
}

function memberTermMatches(candidateTerm: string, requested: string): boolean {
  if (candidateTerm === requested || candidateTerm.endsWith(` ${requested}`)) return true;
  if (!requested) return false;
  return ` ${candidateTerm} `.includes(` ${requested} `);
}

function candidateTerms(candidate: AgentEvidenceCandidate): string[] {
  return [candidate.name, ...(candidate.aliases ?? []), candidate.qualifiedId ?? '', candidate.id]
    .map(normalize)
    .filter(Boolean);
}

function resolveCapability(
  resolution: MeaningResolution,
  execution: AgentEvidenceCandidate | undefined,
  measures: ResolvedPlanMemberBinding[],
  dimensions: ResolvedPlanMemberBinding[],
  filters: ResolvedAnalyticalPlan['query']['filters'],
  requiredOutputs: ResolvedPlanMemberBinding[] = [],
  selectedCapability?: MetricCapabilityContract,
  frozenAuthorityCandidates: AgentEvidenceCandidate[] = [],
  snapshotCandidates: AgentEvidenceCandidate[] = [],
): ResolvedPlanCapability {
  if (
    resolution.confidence === "low" ||
    resolution.recommendedRoute === "clarify" ||
    !execution ||
    Boolean(resolution.analyticalFrame?.ambiguity.length)
  )
    return "blocked";
  if (
    ((measures.some((binding) => binding.status !== "resolved") &&
      resolution.queryIntent.measures.length > 0) ||
      (dimensions.some((binding) => binding.status !== "resolved") &&
        resolution.queryIntent.dimensions.length > 0)) &&
    (resolution.recommendedRoute === "certified" ||
      resolution.recommendedRoute === "semantic")
  )
    return "blocked";
  if (
    filters.some((filter) => filter.binding.status !== "resolved") &&
    (resolution.recommendedRoute === "certified" ||
      resolution.recommendedRoute === "semantic")
  )
    return "blocked";
  // A frozen plan may not silently drop an explicitly requested projection.
  // This applies to exploratory SQL too: otherwise a query can execute and
  // display five rows that omit one of the user-named identifiers.
  if (requiredOutputs.some((binding) => binding.status !== 'resolved')) return 'blocked';
  if (execution.compatibility === "incompatible") return "blocked";
  if (
    resolution.recommendedRoute === "certified" &&
    execution.kind === "certified_block" &&
    execution.compatibility === "compatible" &&
    certifiedCandidateExplicitlyCoversMeasures(
      execution,
      measures.map((binding) => binding.requested),
    ) &&
    certifiedBlockProvesHostProjection(
      execution,
      resolution,
    )
  ) {
    return "certified_execution";
  }
  if (resolution.recommendedRoute === 'semantic'
    && (execution.kind === 'semantic_metric' || execution.kind === 'semantic_member')
    && semanticCapabilitiesProveFrozenTuple({
      capability: selectedCapability,
      measures,
      dimensions,
      filters,
      requiredOutputs,
      timeGrain: resolution.queryIntent.timeGrain,
      hasTimeRange: Boolean(resolution.queryIntent.timeRange),
      candidates: frozenAuthorityCandidates,
    })
    && (
      execution.compatibility === 'compatible'
      || sameSnapshotSemanticExtensionProvesFrozenTuple({
        execution,
        capability: selectedCapability,
        measures,
        dimensions,
        filters,
        requiredOutputs,
        candidates: frozenAuthorityCandidates,
        timeGrain: resolution.queryIntent.timeGrain,
        hasTimeRange: Boolean(resolution.queryIntent.timeRange),
      })
    )) return 'semantic_execution';
  // A relationship/entity card and a qualified physical closure are useful
  // evidence for exploratory SQL, but they are not themselves a governed DQL
  // projection.  In particular, a DQL entity may bridge an order-items model
  // to related business context while the selected tuple still consists only
  // of dbt/runtime columns.  Freezing that as governed relational defers the
  // first real eligibility check until the compiler, where it becomes a
  // post-freeze COMPILATION_FAILED with no permitted fallback.
  //
  // Keep the boundary before freeze: governed relational execution requires a
  // snapshot-declared capability with a concrete governed adapter and proof
  // for every bound measure/dimension/filter/output.  A raw physical path is
  // deliberately returned as blocked here so the router can evaluate its
  // existing same-snapshot exploratory cascade, which rebuilds an immutable
  // review-required plan with `recommendedRoute: exploratory`.
  if (resolution.recommendedRoute === 'governed_sql'
    // A partial DQL modeling card can contribute relationship context, but it
    // cannot be the compiler authority for a frozen governed plan. In
    // particular, an entity card that merely names an order-item grain must
    // not turn selected dbt/runtime output columns into a governed DQL
    // projection. It remains eligible evidence for the router's safe
    // same-snapshot exploratory cascade below this pre-freeze gate.
    && execution.compatibility === 'compatible'
    && governedRelationalCapabilityProvesFrozenTuple({
      capability: selectedCapability,
      measures,
      dimensions,
      filters,
      requiredOutputs,
      timeGrain: resolution.queryIntent.timeGrain,
      hasTimeRange: Boolean(resolution.queryIntent.timeRange),
      snapshotCandidates,
    })) return 'governed_relational';
  if (resolution.recommendedRoute === 'exploratory') return 'bounded_exploration';
  return 'blocked';
}

/**
 * Governed relational compilation has a distinct authority boundary from
 * physical SQL safety.  The latter can prove a read-only, review-required
 * closure; it cannot mint a governed compiler projection.  Require the
 * selected capability to declare the governed adapter and to prove the exact
 * frozen tuple before the router is allowed to freeze this tier.
 */
function governedRelationalCapabilityProvesFrozenTuple(input: {
  capability: MetricCapabilityContract | undefined;
  measures: ResolvedPlanMemberBinding[];
  dimensions: ResolvedPlanMemberBinding[];
  filters: ResolvedAnalyticalPlan['query']['filters'];
  requiredOutputs: ResolvedPlanMemberBinding[];
  timeGrain?: string;
  hasTimeRange: boolean;
  /** Immutable retrieval snapshot; compact meaning cards alone cannot mint a relationship proof. */
  snapshotCandidates: readonly AgentEvidenceCandidate[];
}): boolean {
  const { capability } = input;
  if (!capability) return false;
  if (!capability.executionCapabilities.some((execution) =>
    execution.route === 'governed_sql' && Boolean(execution.adapterId?.trim()))) return false;

  const metricIds = new Set([capability.metricId, ...capability.measureIds]);
  if (!input.measures.every((binding) =>
    binding.status === 'resolved'
    && Boolean(binding.qualifiedId)
    && metricIds.has(binding.qualifiedId!))) return false;

  const provesDimension = (
    binding: ResolvedPlanMemberBinding,
    roles: AnalyticalDimensionRole[],
  ): boolean => {
    if (binding.status !== 'resolved' || !binding.qualifiedId) return false;
    const dimension = eligibleCapabilityDimensions(capability, roles)
      .find((candidate) => candidate.dimensionId === binding.qualifiedId);
    return Boolean(dimension
      && governedCapabilityDimensionHasFreshAutomaticRelationshipProofV1({
        capability,
        dimension,
        candidates: input.snapshotCandidates,
      }));
  };
  if (!input.dimensions.every((binding) => provesDimension(binding, ['group_by']))) return false;
  if (!input.filters.every((filter) => provesDimension(filter.binding, ['filter']))) return false;

  // An explicit output is a host-owned result-contract field, not an
  // implication of a physical relation. A `declaredOutputIds` entry is not a
  // compiler projection on its own: the governed compiler consumes metrics
  // and grouped dimensions. Therefore a non-measure output must be the exact
  // selected capability display/rank dimension *and* already be represented
  // in the frozen grouped tuple. This keeps raw `order_id` / `product_id`
  // columns and detached cross-entity display fields on the exploratory path
  // unless the authored governed graph can actually compile them.
  // Metrics follow the same rule: capability membership describes what could
  // be compiled, while the frozen query measures describe what *will* be
  // projected. A required `gross_profit` output may not piggyback on a
  // selected `revenue` measure just because both live in the capability.
  const groupedDimensionIds = new Set(input.dimensions
    .flatMap((binding) => binding.qualifiedId ? [binding.qualifiedId] : []));
  const projectedMeasureIds = new Set(input.measures
    .filter((binding) => binding.status === 'resolved')
    .flatMap((binding) => binding.qualifiedId ? [binding.qualifiedId] : []));
  const provesOutput = (binding: ResolvedPlanMemberBinding): boolean => {
    if (binding.status !== 'resolved' || !binding.qualifiedId) return false;
    if (metricIds.has(binding.qualifiedId)) return projectedMeasureIds.has(binding.qualifiedId);
    if (!groupedDimensionIds.has(binding.qualifiedId)) return false;
    return provesDimension(binding, ['display'])
      || provesDimension(binding, ['rank_entity']);
  };
  if (!input.requiredOutputs.every(provesOutput)) return false;
  if (input.timeGrain && !capability.timeDimensions.some((dimension) =>
    dimension.supportedGrains.some((grain) => normalize(grain) === normalize(input.timeGrain!)))) return false;
  return !input.hasTimeRange || capability.timeDimensions.length > 0;
}

/**
 * A selected certified block must prove the host-owned projection itself.
 * Contextual semantic capability metadata is useful corroboration, but it is
 * never authority to add an entity label, grouping field, or explicit output
 * that the block does not declare. This defensive freeze gate covers paths
 * where a binding was collapsed/projected before capability resolution.
 */
function certifiedBlockProvesHostProjection(
  block: AgentEvidenceCandidate,
  resolution: MeaningResolution,
): boolean {
  const seed = resolution.hostRequirementSeed;
  if (!seed) return true;
  const projectedDimensions = certifiedBlockCanUseExactCanonicalDimensionProjection(block, resolution)
    ? resolution.queryIntent.dimensions
    : seed.queryIntent.dimensions;
  const terms = uniqueSorted([
    ...projectedDimensions,
    ...seed.requirements.entityTerms,
    ...seed.requirements.entityDisplayTerms,
    ...(seed.requirements.outputTerms ?? []),
  ].map(normalize).filter(Boolean));
  if (!terms.every((term) => Boolean(
    certifiedCandidateDeclaredDimensionOutput(block, term)
    || certifiedCandidateDeclaredMeasureOutput(block, term),
  ))) return false;
  const declaredRequestedDimensions = terms
    .map((term) => certifiedCandidateDeclaredDimensionOutput(block, term))
    .filter((output): output is string => Boolean(output))
    .map(normalize);
  // A block can return profile attributes or filterable inputs beside the
  // output that establishes its grain. Treat only an authored grain-driving
  // output as an extra grouping field. This keeps a complete customer profile
  // executable for a customer ranking while still rejecting a scalar revenue
  // request against a customer-grain block.
  const declaredBlockDimensions = certifiedCandidateGrainDimensionOutputs(block)
    .map(normalize)
    .filter(Boolean);
  // Do not certify a narrower/wider saved answer than the frozen host tuple.
  // Extra grouped dimensions alter result grain even if the requested measure
  // happens to be an authored block output.
  return declaredBlockDimensions.length === 0
    || declaredBlockDimensions.every((dimension) => declaredRequestedDimensions.includes(dimension));
}

function certifiedBlockCanUseExactCanonicalDimensionProjection(
  block: AgentEvidenceCandidate | undefined,
  resolution: MeaningResolution,
): boolean {
  const seed = resolution.hostRequirementSeed;
  return Boolean(
    seed
    && resolution.recommendedRoute === 'certified'
    && block?.kind === 'certified_block'
    && block.exactMatch
    && block.compatibility === 'compatible'
    && block.analyticalFitClass === 'exact'
    && certifiedCandidateExplicitlyCoversMeasures(block, resolution.queryIntent.measures)
    && resolution.queryIntent.dimensions.length > 0
    && resolution.queryIntent.dimensions.every((dimension) =>
      Boolean(certifiedCandidateDeclaredDimensionOutput(block, dimension)))
    && !sameNormalizedTerms(resolution.queryIntent.dimensions, seed.queryIntent.dimensions)
  );
}

/**
 * The semantic route may freeze only after the exact frozen tuple can be
 * expressed by the selected semantic adapter. A metric-relative native
 * grouping reference is required for every cross-model dimension/filter.
 * Same-model dimensions are already a declared group-by on the metric model.
 */
function semanticCapabilityProvesFrozenTuple(input: {
  capability: MetricCapabilityContract | undefined;
  measures: ResolvedPlanMemberBinding[];
  dimensions: ResolvedPlanMemberBinding[];
  filters: ResolvedAnalyticalPlan['query']['filters'];
  requiredOutputs: ResolvedPlanMemberBinding[];
  timeGrain?: string;
  hasTimeRange: boolean;
}): boolean {
  const { capability } = input;
  // Metric-free semantic member lookups retain their existing exact registry
  // path. A metric tuple, however, must have a normalized capability.
  if (!capability) return input.measures.length === 0;
  if (!capability.executionCapabilities.some((execution) =>
    execution.route === 'semantic' && Boolean(execution.adapterId?.trim()))) return false;
  const metricIds = new Set([capability.metricId, ...capability.measureIds]);
  if (!input.measures.every((binding) =>
    binding.status === 'resolved' && Boolean(binding.qualifiedId) && metricIds.has(binding.qualifiedId!))) return false;
  const provesDimension = (
    binding: ResolvedPlanMemberBinding,
    roles: AnalyticalDimensionRole[],
  ): boolean => {
    if (binding.status !== 'resolved' || !binding.qualifiedId) return false;
    const dimension = capability.dimensions.find((candidate) =>
      candidate.dimensionId === binding.qualifiedId
      && roles.every((role) => candidate.supportedRoles.includes(role)));
    return Boolean(dimension && (dimension.entityId === capability.primaryEntityId
      || semanticNativeGroupingIsExact(capability, dimension)));
  };
  if (!input.dimensions.every((binding) => provesDimension(binding, ['group_by']))) return false;
  if (!input.filters.every((filter) => provesDimension(filter.binding, ['filter']))) return false;
  // Explicit output projections are not grouping dimensions. They have their
  // own frozen result contract and cannot be smuggled into a semantic tuple by
  // a same-snapshot extension.
  if (input.requiredOutputs.length > 0) return false;
  if (input.timeGrain && !capability.timeDimensions.some((dimension) =>
    dimension.supportedGrains.some((grain) => normalize(grain) === normalize(input.timeGrain!)))) return false;
  return !input.hasTimeRange || capability.timeDimensions.length > 0;
}

/**
 * A multi-metric semantic plan remains one immutable request frame, but each
 * selected metric has to prove that frame independently before the route can
 * freeze.  The first selected capability remains the stable execution anchor
 * for backward-compatible receipts; it is never allowed to stand in for a
 * second requested metric.  This closes the old single-capability shortcut
 * where a multi-metric frame was marked blocked (or, worse, could later be
 * compiled against only its first measure).
 */
function semanticCapabilitiesProveFrozenTuple(input: {
  capability: MetricCapabilityContract | undefined;
  measures: ResolvedPlanMemberBinding[];
  dimensions: ResolvedPlanMemberBinding[];
  filters: ResolvedAnalyticalPlan['query']['filters'];
  requiredOutputs: ResolvedPlanMemberBinding[];
  timeGrain?: string;
  hasTimeRange: boolean;
  candidates: AgentEvidenceCandidate[];
}): boolean {
  const resolvedMeasures = input.measures.filter((binding) =>
    binding.status === 'resolved' && Boolean(binding.qualifiedId));
  if (resolvedMeasures.length <= 1) {
    return semanticCapabilityProvesFrozenTuple(input);
  }
  // Every requested metric must have a selected normalized capability.  The
  // identity match is exact; aliases, matching leaves, or a correlated metric
  // are not enough to enlarge the frozen tuple.
  const capabilities = uniqueMetricCapabilities([
    input.capability,
    ...input.candidates.map((candidate) =>
      normalizeMetricCapabilityContract(candidate.analyticalCapability)),
  ]);
  const selected = resolvedMeasures.map((measure) => {
    const matches = capabilities.filter((capability) =>
      capability.metricId === measure.qualifiedId
      || capability.measureIds.includes(measure.qualifiedId!));
    return matches.length === 1 ? { measure, capability: matches[0]! } : undefined;
  });
  if (selected.some((entry) => !entry)) return false;
  const entries = selected as Array<{ measure: ResolvedPlanMemberBinding; capability: MetricCapabilityContract }>;
  const semanticRoutes = entries.map((entry) => entry.capability.executionCapabilities
    .filter((route) => route.route === 'semantic' && Boolean(route.adapterId?.trim())));
  if (semanticRoutes.some((routes) => routes.length !== 1)) return false;
  const adapterId = semanticRoutes[0]![0]!.adapterId;
  if (!entries.every((entry, index) =>
    semanticRoutes[index]![0]!.adapterId === adapterId
    && entry.capability.semanticModelId === entries[0]!.capability.semanticModelId)) return false;
  return entries.every(({ measure, capability }) => semanticCapabilityProvesFrozenTuple({
    capability,
    measures: [measure],
    dimensions: input.dimensions,
    filters: input.filters,
    requiredOutputs: input.requiredOutputs,
    ...(input.timeGrain ? { timeGrain: input.timeGrain } : {}),
    hasTimeRange: input.hasTimeRange,
  }));
}

function uniqueMetricCapabilities(
  capabilities: Array<MetricCapabilityContract | undefined>,
): MetricCapabilityContract[] {
  const byFingerprint = new Map<string, MetricCapabilityContract>();
  for (const capability of capabilities) {
    if (!capability) continue;
    // The source fingerprint is the snapshot identity, not a metric identity:
    // one semantic model can legitimately expose several requested metrics
    // from the same immutable snapshot. A duplicate of the *same* metric can
    // appear as selected execution and selected evidence, but must not turn
    // that metric into an ambiguous capability choice.
    byFingerprint.set(`${capability.sourceFingerprint}:${capability.metricId}`, capability);
  }
  return [...byFingerprint.values()];
}

/**
 * Retrieval cards are scored before the role-balanced same-snapshot extension
 * is admitted. A semantic metric can therefore retain `partial` even after
 * the host has selected its one proven MetricFlow grouping field. Do not make
 * `partial` generally executable: advance it only when the immutable frozen
 * tuple proves the exact metric, every required role, and the extension's
 * metric/dimension identity from the same snapshot.
 *
 * This is semantic-adapter authority only. It never authorizes a physical join
 * or exploratory SQL, and an omitted output, unbound role, mismatched metric,
 * mismatched dimension, unsupported time grain, or absent extension remains
 * blocked for the cascade to evaluate safely.
 */
function sameSnapshotSemanticExtensionProvesFrozenTuple(input: {
  execution: AgentEvidenceCandidate;
  capability: MetricCapabilityContract | undefined;
  measures: ResolvedPlanMemberBinding[];
  dimensions: ResolvedPlanMemberBinding[];
  filters: ResolvedAnalyticalPlan['query']['filters'];
  requiredOutputs: ResolvedPlanMemberBinding[];
  candidates: AgentEvidenceCandidate[];
  timeGrain?: string;
  hasTimeRange: boolean;
}): boolean {
  const { execution, capability } = input;
  if (execution.kind !== 'semantic_metric' || execution.compatibility !== 'partial' || !capability) return false;
  if (!semanticCapabilityProvesFrozenTuple(input)) return false;
  // Explicit output terms have their own source-column result proof. A
  // semantic role extension does not prove such an extra projection.
  if (input.requiredOutputs.length > 0 || input.measures.length === 0) return false;

  const metricAuthorityIds = new Set([
    execution.id,
    execution.qualifiedId,
    capability.metricId,
    ...capability.measureIds,
  ].filter((id): id is string => Boolean(id)));
  if (!input.measures.every((binding) =>
    binding.status === 'resolved'
    && Boolean(binding.qualifiedId)
    && metricAuthorityIds.has(binding.qualifiedId!))) return false;

  const declaredExtensionProvesTuple = input.candidates.some((candidate) => {
    const proof = proveSameSnapshotMetricflowRoleExtensionV1({
      candidate,
      metricCandidate: execution,
    });
    if (!proof) return false;
    const extension = candidate.sameSnapshotRoleExtension!;
    return metricAuthorityIds.has(extension.metricId)
      && input.dimensions.some((binding) => binding.qualifiedId === proof.dimension.dimensionId);
  });
  if (declaredExtensionProvesTuple) return true;

  // dbt/MetricFlow registry cards commonly have a registry identity such as
  // `semantic:dimension:customers.customer_name`, while the selected metric
  // capability carries its canonical MetricFlow identity
  // `semantic:uncategorized:dimension:customers.customer_name`.  Both are
  // sourced from the same immutable snapshot. A selected semantic member that
  // *exactly* names one declared group-by field is therefore a direct
  // same-snapshot binding, even when the index did not materialize the older
  // `sameSnapshotRoleExtension` wrapper. This does not broaden selection:
  // only cards already in the frozen authority set are considered, and every
  // requested bound dimension must be proved by the selected metric's own
  // capability before the semantic tier can freeze.
  return input.dimensions.every((binding) => {
    if (binding.status !== 'resolved' || !binding.qualifiedId) return false;
    const dimension = capability.dimensions.find((item) =>
      item.dimensionId === binding.qualifiedId
      && item.supportedRoles.includes('group_by'));
    return Boolean(dimension && input.candidates.some((candidate) =>
      // When metadata supplies an explicit extension record, it is the
      // authority for this bridge and must name the selected metric. Do not
      // bypass a mismatched record through an alias-only direct fallback.
      !candidate.sameSnapshotRoleExtension
      && selectedSemanticMemberMatchesCapabilityDimension(candidate, dimension)));
  });
}

/**
 * Match only stable metadata identities, never a free-form short alias. This
 * lets a selected registry card bind the same declared MetricFlow field while
 * preventing a broad word such as `customer` from making `customer_order_number`
 * look like the requested customer display key.
 */
function selectedSemanticMemberMatchesCapabilityDimension(
  candidate: AgentEvidenceCandidate,
  dimension: MetricCapabilityContract['dimensions'][number],
): boolean {
  if (candidate.kind !== 'semantic_member' || candidate.compatibility === 'incompatible') return false;
  const stableForms = (values: Array<string | undefined>): Set<string> => new Set(values
    .filter((value): value is string => Boolean(value))
    .filter((value) => /[.:/_-]/.test(value))
    .map(normalize)
    .filter(Boolean));
  const candidateForms = stableForms([
    candidate.id,
    candidate.qualifiedId,
    candidate.name,
    ...(candidate.aliases ?? []),
  ]);
  const dimensionForms = stableForms([
    dimension.dimensionId,
    dimension.label,
    ...(dimension.aliases ?? []),
  ]);
  return [...candidateForms].some((form) => dimensionForms.has(form));
}

function normalize(value: string): string {
  return value.toLowerCase()
    .replace(/%/g, ' percentage ')
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a host-owned display-key requirement against a capability that uses
 * the generic entity field as its declared display output.  This is a
 * deterministic capability projection, not an interpretation of the user
 * question and never mutates the requirement seed.
 */
function collapseHostEntityDisplayBindings(
  bindings: ResolvedPlanMemberBinding[],
  seed: MeaningResolution['hostRequirementSeed'],
): ResolvedPlanMemberBinding[] {
  if (!seed) return bindings;
  const displayOnlyTerms = new Set(
    seed.requirements.entityDisplayTerms
      .map(normalize)
      .filter((term) => term.length > 0 && !seed.requirements.dimensions.some((dimension) => normalize(dimension) === term)),
  );
  const entityTerms = seed.requirements.entityTerms.map(normalize).filter(Boolean);
  if (displayOnlyTerms.size === 0 || entityTerms.length === 0) return bindings;

  const isEntityCompanion = (binding: ResolvedPlanMemberBinding): boolean => {
    const requested = normalize(binding.requested);
    return entityTerms.some((entity) => requested === entity || requested.startsWith(`${entity} `));
  };

  return bindings.filter((binding, index, all) => {
    const requested = normalize(binding.requested);
    if (!displayOnlyTerms.has(requested)) return true;
    const companion = all.find((other, otherIndex) => otherIndex !== index && isEntityCompanion(other));
    // An ambiguous generic entity is still the sole decision the reader must
    // make. Do not add an unrelated "account name" unresolved gap beside the
    // two qualified account choices.
    if (!companion || companion.status === 'unresolved') return true;
    if (binding.status === 'unresolved') return false;
    return binding.status !== 'resolved' || binding.qualifiedId !== companion.qualifiedId;
  });
}

/** Resolve common analytical ranges once so no executor reinterprets "last month". */
export function resolvePlanTimeRange(
  expression: string,
  referenceTime: Date,
): ResolvedAnalyticalPlan['query']['timeBounds'] | undefined {
  const text = expression.trim().toLowerCase();
  const reference = new Date(Date.UTC(
    referenceTime.getUTCFullYear(),
    referenceTime.getUTCMonth(),
    referenceTime.getUTCDate(),
  ));
  const explicit = /^(\d{4}-\d{2}-\d{2})\s+(?:to|through)\s+(\d{4}-\d{2}-\d{2})$/.exec(text);
  if (explicit) {
    const start = new Date(`${explicit[1]}T00:00:00.000Z`);
    const inclusiveEnd = new Date(`${explicit[2]}T00:00:00.000Z`);
    if (!Number.isNaN(start.valueOf()) && !Number.isNaN(inclusiveEnd.valueOf()) && start <= inclusiveEnd) {
      inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() + 1);
      return temporalBounds(expression, start, inclusiveEnd);
    }
  }
  const match = /^(?:the\s+)?(last|this)\s+(?:(\d+)\s+)?(day|week|month|quarter|year)s?$/.exec(text);
  if (!match) return undefined;
  const mode = match[1]!;
  const count = Math.max(1, Number(match[2] ?? 1));
  const unit = match[3]!;
  if (mode === 'this') {
    const start = startOfUnit(reference, unit);
    return temporalBounds(expression, start, addUnits(start, unit, count));
  }
  if (match[2]) return temporalBounds(expression, addUnits(reference, unit, -count), reference);
  const end = startOfUnit(reference, unit);
  return temporalBounds(expression, addUnits(end, unit, -1), end);
}

function temporalBounds(expression: string, start: Date, end: Date): NonNullable<ResolvedAnalyticalPlan['query']['timeBounds']> {
  return {
    expression,
    startInclusive: start.toISOString(),
    endExclusive: end.toISOString(),
    timeZone: 'UTC',
  };
}

function startOfUnit(value: Date, unit: string): Date {
  const out = new Date(value);
  if (unit === 'year') out.setUTCMonth(0, 1);
  else if (unit === 'quarter') out.setUTCMonth(Math.floor(out.getUTCMonth() / 3) * 3, 1);
  else if (unit === 'month') out.setUTCDate(1);
  else if (unit === 'week') out.setUTCDate(out.getUTCDate() - ((out.getUTCDay() + 6) % 7));
  return out;
}

function addUnits(value: Date, unit: string, count: number): Date {
  const out = new Date(value);
  if (unit === 'year') out.setUTCFullYear(out.getUTCFullYear() + count);
  else if (unit === 'quarter') out.setUTCMonth(out.getUTCMonth() + count * 3);
  else if (unit === 'month') out.setUTCMonth(out.getUTCMonth() + count);
  else if (unit === 'week') out.setUTCDate(out.getUTCDate() + count * 7);
  else out.setUTCDate(out.getUTCDate() + count);
  return out;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function sameNormalizedTerms(left: string[], right: string[]): boolean {
  const normalizeTerms = (values: string[]) => uniqueSorted(values.map(normalize));
  return normalizeTerms(left).join('\u0000') === normalizeTerms(right).join('\u0000');
}

function uniqueCandidatesByCanonicalId(
  candidates: AgentEvidenceCandidate[],
  canonicalId: (candidate: AgentEvidenceCandidate) => string,
): AgentEvidenceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const id = canonicalId(candidate);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}
