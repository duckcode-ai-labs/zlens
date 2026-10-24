import type { KGNode } from '../kg/types.js';
import type { AnalysisQuestionPlan, RequestedAnswerShape } from './analysis-planner.js';
import type { MetadataObject } from './catalog.js';
import { extractSimpleSelectShape, selectExpressionOutputName } from './sql-shape.js';

export interface CertifiedBlockFit {
  kind: 'exact' | 'trim_safe' | 'context_only' | 'not_applicable';
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  /**
   * Requested measures the block itself does not declare as metric outputs.
   *
   * This is deliberately distinct from `missingOutputs`: a block can be
   * broadly relevant to revenue while returning a different metric such as
   * `lifetime_spend`.  Tags, descriptions, examples, and pooled retrieval
   * candidates never fill this list.  A non-empty list is a hard Tier-1 stop,
   * including for an otherwise exact authored example or directly named block.
   */
  missingMeasures?: string[];
  missingOutputs: string[];
  missingDimensions: string[];
  unsupportedFilters: string[];
  grainMismatch?: string;
  topNAction?: 'none' | 'trim' | 'generate';
  inferredContract: boolean;
}

const STRUCTURAL_SCOPE_WORDS = new Set(['item', 'items', 'flag', 'record', 'row', 'rows', 'active', 'valid', 'current', 'status', 'type', 'id', 'is', 'true', 'false', 'deleted', 'enabled']);
const GENERIC_TAG_WORDS = new Set(['ranking', 'rank', 'top', 'kpi', 'metric', 'metrics', 'report', 'dashboard', 'certified', 'block', 'summary', 'analysis', 'total', 'count']);

export function requestedShapeFromPlan(plan: AnalysisQuestionPlan): RequestedAnswerShape {
  return plan.requestedShape;
}

export function certifiedFitAllowsTier1(fit: CertifiedBlockFit): boolean {
  return (fit.kind === 'exact' || fit.kind === 'trim_safe')
    && fit.confidence === 'high'
    && (fit.missingMeasures?.length ?? 0) === 0;
}

export type CertifiedTerminationBypass = 'named_block' | 'exact_example' | 'definition_lookup';

export interface CertifiedTerminationVerdict {
  allow: boolean;
  fit: CertifiedBlockFit;
  bypass?: CertifiedTerminationBypass;
  reason: string;
}

/**
 * THE single authority for "may this certified block TERMINATE the answer".
 *
 * Four semi-independent layers (catalog route planner, answer-loop Stage-1
 * pickers, router shortcuts, engine routing) each used to re-derive this from
 * `certifiedFitAllowsTier1` plus local bypass/inferred-contract rules — and the
 * seams between them produced certified answers that silently ignored the
 * user's request (an unfiltered top-10 ranking for a member-scoped follow-up).
 * Every layer must consume this verdict instead of re-deriving it.
 *
 * One rule is absolute: a typed member binding the block cannot apply is NEVER
 * bypassable. Tier-1 executes blocks verbatim, so naming a block ("run
 * top_beverage_customers for Joy Lam") does not authorize silently dropping
 * the "for Joy Lam" part — that demotes to the adaptation/generated lane.
 */
export function certifiedTerminationVerdict(input: {
  fit: CertifiedBlockFit;
  bypass?: CertifiedTerminationBypass;
  allowInferredContract?: boolean;
}): CertifiedTerminationVerdict {
  const { fit } = input;
  // A Tier-1 block executes its authored SQL verbatim.  It cannot claim a
  // requested metric that is absent from its own output contract merely
  // because the block is tagged/retrieved near that metric.  Keep this before
  // every bypass: an example or a named block can accept grain, never replace
  // `revenue` with `lifetime_spend`.
  if ((fit.missingMeasures?.length ?? 0) > 0) {
    return {
      allow: false,
      fit,
      reason: `the block does not declare required measure output(s): ${fit.missingMeasures!.join(', ')}`,
    };
  }
  if (fit.unsupportedFilters.length > 0) {
    return {
      allow: false,
      fit,
      reason: `the block cannot apply required filter(s): ${fit.unsupportedFilters.join(', ')} — Tier-1 executes verbatim`,
    };
  }
  if (input.bypass) {
    return { allow: true, fit, bypass: input.bypass, reason: `directly requested (${input.bypass}); grain implicitly accepted` };
  }
  if (certifiedFitAllowsTier1(fit)) {
    return { allow: true, fit, reason: 'exact or trim-safe fit at high confidence' };
  }
  if (input.allowInferredContract
    && fit.kind === 'exact'
    && fit.confidence === 'medium'
    && fit.missingDimensions.length === 0
    && fit.missingOutputs.length === 0
    && !fit.grainMismatch) {
    return { allow: true, fit, reason: 'inferred-contract exact fit with no shape gaps' };
  }
  return { allow: false, fit, reason: fit.reasons[0] ?? 'fit below the Tier-1 threshold' };
}

/**
 * Did the question enumerate attributes the planner could not map?
 *
 * "list every customer's credit card number and home address" reduces to
 * `requiredOutputs: ['customer']` — IDENTICAL to the plan for "who are the top
 * customers" — because the extraction chain silently drops phrases it cannot
 * resolve. A certified block then fits perfectly, and the reader is handed
 * `top_customers` stamped `certified` for a question about data the project
 * does not have.
 *
 * The signal is the deficit, not the words: a possessive or of-phrase that
 * enumerates N attributes must leave N mapped outputs behind the entity. When
 * it does not, content was dropped, and a block cannot claim to answer what was
 * never understood. Measured to separate the case above (asked 2, mapped 1)
 * from the legitimate "customer's lifetime spend and order count" (asked 2,
 * mapped 3) without touching questions that use no possessive at all.
 */
export function droppedAttributeRequest(question: string, mappedOutputs: number): boolean {
  const match = /(?:\b\w+'s|\bof\s+(?:each|every|the)\s+\w+)\s+(.+)$/i.exec(question);
  if (!match) return false;
  const asked = match[1]!.split(/,|\band\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2).length;
  if (asked < 2) return false;
  // One mapped output is the entity itself; the rest are the attributes.
  return Math.max(0, mappedOutputs - 1) < asked;
}

export function evaluateCertifiedBlockFit(input: {
  question: string;
  plan: AnalysisQuestionPlan;
  block: MetadataObject | KGNode;
  exactExampleMatch?: boolean;
  /**
   * The catalog proved that this is the only certified block whose authored
   * example normalizes exactly to the question.  This is deliberately more
   * restrictive than `exactExampleMatch`: two blocks may share an example, in
   * which case neither gets to reinterpret a parser token through its own
   * contract.
   */
  uniqueExactExampleContract?: boolean;
  definitionLookup?: boolean;
  /**
   * Qualified semantic metrics the question names by name or label (see
   * {@link namedQualifiedSemanticMeasures}). The planner can drop the
   * qualifier ("large orders" plans as `count, order`), so these are checked
   * against the block's own outputs and scope as additional required measures.
   */
  namedSemanticMeasures?: NamedSemanticMeasure[];
}): CertifiedBlockFit {
  const requested = requestedShapeFromPlan(input.plan);
  const block = blockShape(input.block);

  const requestedDimensions = requested.dimensions.map(canonicalToken).filter(Boolean);
  // Preserve the authored measure identity rather than collapsing it into a
  // broad analytical family (`lifetime_spend` and `revenue` used to both
  // become `revenue`).  The helper below admits only conservative, role-safe
  // aliases such as total/gross/net/monthly revenue; it never accepts tags,
  // examples, or descriptive prose as output authority.
  const requestedMeasures = requestedMetricOutputIdentities(requested.measures);
  const requiredOutputs = requested.requiredOutputs.map(canonicalColumn).filter(Boolean);
  const blockDimensions = new Set(block.dimensions);
  const blockMeasures = new Set(block.measures);
  const blockOutputs = new Set(block.outputs);

  // A "dimension" the parser read from "by beverage" may be the qualifier of
  // the block's own measure: an output named `beverage_revenue` declares, in
  // the author's words, that the block is the beverage-qualified one. Only
  // an output NAME counts — a tag or a description is not a column promise.
  const outputNameDeclares = (token: string) => [...blockOutputs]
    .some((output) => output.split(/[^a-z0-9]+/).includes(token));
  const missingDimensions = uniqueStrings(requestedDimensions.filter((dimension) =>
    !blockDimensions.has(dimension)
    && !outputHasEntity(blockOutputs, dimension)
    && !outputNameDeclares(dimension)
    && !uniqueExactExampleMemberToken(input, dimension, block)
  ));
  const missingOutputs = uniqueStrings(requiredOutputs.filter((output) =>
    // A directly named artifact is an execution request, not a request for a
    // column that happens to resemble the artifact's snake_case name.  For
    // example, `run top_customers` requires the block's declared customer
    // output contract; it does not require a fabricated `top_customer` column.
    !artifactNameRequirement(output, input.block)
    && !outputRequirementCovered(output, block)
    // A planner may retain the spoken measure phrase in requiredOutputs as
    // well as measures (for example "spent"). It is not an additional
    // projected field once the same declared metric output has already proved
    // coverage. The strict missingMeasures gate below remains authoritative.
    && !(requestedMeasures.includes(canonicalMetricOutputIdentity(output))
      && declaredQualifiedOutputCoversMeasure(block, canonicalMetricOutputIdentity(output), input.question, input.plan, requested))
    // An exact authored example may contain member words (for example
    // "food" and "drink") which the parser retains as output requests even
    // though the block's declared `category` output is the actual role.  Only
    // the unique exact-example contract may consume those unstructured member
    // tokens.  Measures, structural role outputs, filters, grain, ranking and
    // static scope remain independently validated below.
    && !uniqueExactExampleMemberToken(input, output, block)
  ));
  const missingRequestedMeasures = requestedMeasures.filter((measure) =>
    !blockMeasures.has(measure)
    && !declaredQualifiedOutputCoversMeasure(block, measure, input.question, input.plan, requested)
  );
  const missingMeasures = uniqueStrings([
    ...missingRequestedMeasures,
    ...(input.namedSemanticMeasures ?? [])
      .filter((measure) => !blockCoversNamedSemanticMeasure(block, measure, input.question, input.plan, requested))
      .map((measure) => measure.metric),
  ]);
  const measureMatch = requestedMeasures.length === 0
    || missingRequestedMeasures.length === 0;

  const unsupportedFilters = unsupportedRequestedFilters(requested, block, input.question);
  // The WHERE-derived scope is entailed when the question names it in the
  // column's words OR in the author's tag words for it.
  const scopeTagEntailed = [...block.scopeTagTokens]
    .some((token) => questionEntailsScopeToken(input.question, input.plan, requested, token));
  const unentailedScope = scopeTagEntailed
    ? []
    : [...block.staticScopeTokens]
      .filter((token) => !questionEntailsScopeToken(input.question, input.plan, requested, token));
  const requestedGrainIsExactExampleMemberNoise = requested.grain
    && uniqueExactExampleMemberToken(input, requested.grain, block);
  const grainMismatch = requested.grain && block.grain && canonicalToken(requested.grain) !== block.grain
    && !blockDimensions.has(canonicalToken(requested.grain))
    // The only allowed grain reinterpretation is a unique, exact authored
    // example whose parser retained a member value (food) in `grain` rather
    // than its declared role (category). The block still has to declare its
    // actual grain, and all measure/output/filter/ranking checks below remain
    // in force. This is not a general exact-example grain bypass.
    && !requestedGrainIsExactExampleMemberNoise
    ? `certified block grain=${block.grain} does not cover requested grain=${canonicalToken(requested.grain)}`
    : scalarRequestCannotUseRowGrainBlock(input.plan, requestedDimensions, block)
      ? `certified block returns rows at ${block.grain ?? block.dimensions[0]} grain but the question requests one aggregate value`
      : undefined;
  const topNAction = topNFitAction(requested, block);
  // Content the planner dropped cannot be checked against the block, so a fit
  // computed over what survived is not evidence that the question is covered.
  const droppedRequest = droppedAttributeRequest(input.question, requiredOutputs.length);

  if (droppedRequest || grainMismatch || missingDimensions.length > 0 || missingMeasures.length > 0 || missingOutputs.length > 0 || unsupportedFilters.length > 0 || unentailedScope.length > 0 || !measureMatch || topNAction === 'generate') {
    const reasons = [
      droppedRequest
        ? 'the question asks for attributes that could not be resolved against the model'
        : '',
      grainMismatch,
      missingDimensions.length ? `missing requested dimensions: ${missingDimensions.join(', ')}` : '',
      missingMeasures.length ? `missing declared measure outputs: ${missingMeasures.join(', ')}` : '',
      missingOutputs.length ? `missing requested outputs: ${missingOutputs.join(', ')}` : '',
      unsupportedFilters.length ? `unsupported requested filters: ${unsupportedFilters.join(', ')}` : '',
      unentailedScope.length ? `certified static scope is not requested: ${unentailedScope.join(', ')}` : '',
      !measureMatch ? `missing requested measures: ${requestedMeasures.join(', ')}` : '',
      topNAction === 'generate' ? 'certified block limit is narrower than requested top-N' : '',
    ].filter((reason): reason is string => Boolean(reason));
    return {
      kind: block.relevance > 0 ? 'context_only' : 'not_applicable',
      confidence: 'high',
      reasons,
      ...(missingMeasures.length > 0 ? { missingMeasures } : {}),
      missingOutputs,
      missingDimensions,
      unsupportedFilters,
      grainMismatch,
      topNAction,
      inferredContract: block.inferredContract,
    };
  }

  const hasRequestedShape = requestedDimensions.length > 0 || requestedMeasures.length > 0 || requiredOutputs.length > 0 || Boolean(requested.grain);
  if (!hasRequestedShape) {
    return {
      kind: 'exact',
      confidence: 'low',
      reasons: ['question has no strong requested answer shape; block fit is not proven'],
      missingOutputs: [],
      missingDimensions: [],
      unsupportedFilters: [],
      topNAction: 'none',
      inferredContract: block.inferredContract,
    };
  }

  const inferredMeasureOnly = block.inferredContract
    && block.outputs.length === 0
    && requestedDimensions.length === 0
    && requiredOutputs.length > 0
    && requiredOutputs.every((output) => outputRequirementCovered(output, block));
  return {
    kind: topNAction === 'trim' ? 'trim_safe' : 'exact',
    confidence: block.inferredContract && block.outputs.length === 0 && !inferredMeasureOnly ? 'medium' : 'high',
    reasons: [
      'certified block covers requested metric, grain, dimensions, filters, and outputs',
      topNAction === 'trim' ? 'certified result can be trimmed to requested top-N' : '',
      input.exactExampleMatch ? 'question matches a certified example after declared-output validation' : '',
      input.definitionLookup ? 'definition lookup remains within the declared-output contract' : '',
      block.inferredContract ? 'block contract was safely inferred from available metadata' : '',
    ].filter(Boolean),
    missingOutputs: [],
    missingDimensions: [],
    unsupportedFilters: [],
    topNAction,
    inferredContract: block.inferredContract,
  };
}

/**
 * A block can contain the requested measure and still answer at the wrong
 * cardinality. For example, a customer-profile block exposes lifetime_spend,
 * but it cannot directly answer "total lifetime spend across all customers"
 * because it returns one row per customer. Keep it as trusted context and let
 * the semantic compiler perform the requested aggregate instead. AGT-009/010.
 */
function scalarRequestCannotUseRowGrainBlock(
  plan: AnalysisQuestionPlan,
  requestedDimensions: string[],
  block: BlockShape,
): boolean {
  if (plan.outputShape !== 'value' || requestedDimensions.length > 0) return false;
  return block.dimensions.length > 0;
}

interface BlockShape {
  grain?: string;
  dimensions: string[];
  measures: string[];
  outputs: string[];
  filters: string[];
  /** Static scope proven by the certified name/tags/WHERE clause. */
  scopeTokens: Set<string>;
  /** Scope that must be entailed before the block may terminate. */
  staticScopeTokens: Set<string>;
  /** The author's tags for that scope, in business words (see blockShape). */
  scopeTagTokens: Set<string>;
  limit?: number;
  relevance: number;
  inferredContract: boolean;
}

function blockShape(block: MetadataObject | KGNode): BlockShape {
  const record = block as unknown as Record<string, unknown>;
  const payload = isMetadataObject(block) ? block.payload ?? {} : record;
  // DQL parser payloads retain authored block SQL as `query`; older catalog
  // paths call it `sql`. Both are an artifact-owned output contract, unlike
  // a description or retrieval tag.
  const sql = stringValue(payload.sql)
    ?? stringValue(payload.query)
    ?? stringValue(record.sql)
    ?? stringValue(record.query);
  const descriptiveText = [
    stringValue(record.name),
    stringValue(record.description),
    stringValue(payload.description),
    stringValue(payload.llmContext),
    Array.isArray(record.tags) ? (record.tags as unknown[]).filter((item): item is string => typeof item === 'string').join(' ') : '',
  ].filter(Boolean).join(' ');
  const sqlOutputs = sql ? extractSqlOutputs(sql) : [];
  const outputs = uniqueStrings([
    ...stringArray(payload.declaredOutputs),
    ...stringArray(record.declaredOutputs),
    ...stringArray(payload.outputs),
    ...stringArray(payload.outputContract),
    ...outputContractColumns(payload.outputContract),
    ...sqlOutputs,
  ].map(canonicalColumn).filter(Boolean));
  const explicitDimensions = uniqueStrings([
    ...stringArray(payload.dimensions),
    ...stringArray(record.dimensions),
    ...outputs.filter(isDimensionLike),
    ...tokensFromValue(stringValue(payload.grain) ?? stringValue(record.grain) ?? '').filter(isDimensionLike),
  ].map(canonicalToken).filter(Boolean));
  const dimensions = uniqueStrings([
    ...explicitDimensions,
    ...inferredTextDimensions(descriptiveText),
  ]);
  const measures = uniqueStrings([
    ...outputs.filter(isMeasureLike),
  ].map(canonicalMetricOutputIdentity).filter(Boolean));
  const filters = uniqueStrings([
    ...stringArray(payload.allowedFilters),
    ...stringArray(record.allowedFilters),
    ...filterBindingNames(payload.filterBindings),
    ...filterBindingNames(record.filterBindings),
    ...parameterNames(payload.parameters),
    ...parameterNames(record.parameters),
  ].map(canonicalToken).filter(Boolean));
  const declaredStaticScopeText = [
    ...stringArray(payload.scopeTokens),
    ...stringArray(record.scopeTokens),
    ...stringArray(payload.staticScope),
    ...stringArray(record.staticScope),
    sql ? extractSqlStaticScope(sql) : '',
  ].filter(Boolean).join(' ');
  const outputScopeTokens = outputs.flatMap((output) => inferredOutputScopeTokens(output));
  // `is_drink_item = true` scopes the block to drinks; "item" is the column's
  // structure, not a business scope a question could be asked to entail.
  const staticScopeTokens = new Set([
    ...tokensFromValue(declaredStaticScopeText).map(canonicalToken).filter((token) => Boolean(token) && !STRUCTURAL_SCOPE_WORDS.has(token)),
    ...outputScopeTokens,
  ]);
  // The author's own words for the block's scope: tags that name neither an
  // output, a dimension, a measure nor the grain ("beverage" on a block whose
  // outputs are customer_name and beverage_revenue). A question that entails
  // one of these has asked for the scope the WHERE clause implements, even
  // when it spells it differently than the column does.
  const structuralWords = new Set([
    ...outputs.flatMap((output) => output.split('_')),
    ...explicitDimensions.flatMap((dimension) => dimension.split('_')),
    ...measures.flatMap((measure) => measure.split('_')),
    ...tokensFromValue(stringValue(payload.grain) ?? stringValue(record.grain) ?? '').map(canonicalToken),
  ]);
  const scopeTagTokens = new Set(
    tokensFromValue([
      Array.isArray(record.tags) ? (record.tags as unknown[]).filter((item): item is string => typeof item === 'string').join(' ') : '',
      Array.isArray(payload.tags) ? (payload.tags as unknown[]).filter((item): item is string => typeof item === 'string').join(' ') : '',
    ].join(' ')).map(canonicalToken).filter((token) => Boolean(token) && !structuralWords.has(token) && !GENERIC_TAG_WORDS.has(token)),
  );
  const scopeText = [
    stringValue(record.name),
    Array.isArray(record.tags) ? (record.tags as unknown[]).filter((item): item is string => typeof item === 'string').join(' ') : '',
    Array.isArray(payload.tags) ? (payload.tags as unknown[]).filter((item): item is string => typeof item === 'string').join(' ') : '',
    declaredStaticScopeText,
  ].filter(Boolean).join(' ');
  const scopeTokens = new Set(tokensFromValue(scopeText).map(canonicalToken).filter(Boolean));
  const grain = canonicalToken(stringValue(payload.grain) ?? stringValue(record.grain) ?? explicitDimensions[0] ?? '');
  const relevance = outputs.length + dimensions.length + measures.length;
  return {
    ...(grain ? { grain } : {}),
    dimensions,
    measures,
    outputs,
    filters,
    scopeTokens,
    staticScopeTokens,
    scopeTagTokens,
    limit: sql ? parseSqlLimit(sql) : undefined,
    relevance,
    inferredContract: stringArray(payload.declaredOutputs).length === 0 && stringArray(record.declaredOutputs).length === 0,
  };
}

function inferredOutputScopeTokens(output: string): string[] {
  const tokens = output.split('_').filter(Boolean);
  const measureIndex = tokens.findIndex((token) => isMeasureLike(token));
  if (measureIndex <= 0) return [];
  const genericModifiers = new Set(['adjusted', 'average', 'avg', 'cumulative', 'gross', 'lifetime', 'monthly', 'net', 'total']);
  return tokens.slice(0, measureIndex)
    .filter((token) => !genericModifiers.has(token) && !isDimensionLike(token))
    .map(canonicalToken)
    .filter(Boolean);
}

function parameterNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
    ? [(item as { name: string }).name]
    : []);
}

function inferredTextDimensions(text: string): string[] {
  const normalized = text.replace(/[_-]+/g, ' ').toLowerCase();
  const inferred: string[] = [];
  for (const match of normalized.matchAll(/\b(?:by|per)\s+([a-z][a-z0-9 ]{1,48})/g)) {
    const phrase = (match[1] ?? '')
      .replace(/\b(?:for|from|with|and|or|including|include|where|when|over|during|not)\b.*$/i, '')
      .trim();
    const dimensions = tokensFromValue(phrase).map(canonicalToken).filter(isDimensionLike);
    const dimension = dimensions.at(-1);
    if (dimension) inferred.push(dimension);
  }
  return uniqueStrings(inferred);
}

function unsupportedRequestedFilters(requested: RequestedAnswerShape, block: BlockShape, question: string): string[] {
  const memberBindings = requested.memberBindings ?? [];
  const boundValueTokens = new Set(memberBindings.flatMap((binding) => binding.values.map(canonicalToken)));
  const unsupportedBindings = memberBindings.flatMap((binding) => {
    const dimension = canonicalToken(binding.dimension);
    const staticallyScoped = binding.values.every((value) => block.scopeTokens.has(canonicalToken(value)));
    // Only a real parameterized filter contract makes a typed member binding
    // SUPPORTED for exact Tier-1 termination. A matching DIMENSION column is
    // not enough: Tier-1 executes the block verbatim, so a "customer" dimension
    // cannot apply `customer = "Joy Lam"` — claiming support here returned the
    // full unfiltered ranking as a certified answer for a member-scoped
    // follow-up. A dimension match demotes to context_only instead, where the
    // adaptation lane applies the actual restriction (or the generated lane
    // answers the member-specific shape).
    const exposesBinding = block.filters.some((filter) => filterContractMatchesDimension(filter, dimension));
    return staticallyScoped || exposesBinding ? [] : binding.values;
  });
  const requestedFilters = uniqueStrings([
    ...requested.filters.filter((filter) => !boundValueTokens.has(canonicalToken(filter))),
    ...requested.followUpReferences.flatMap((ref) => ref.resolvedValues ?? []),
  ].map(canonicalToken).filter((filter) => Boolean(filter) && !isTemporalFilter(filter)));
  const unboundRequestedFilters = requestedFilters.filter((filter) => !boundValueTokens.has(filter));
  if (unboundRequestedFilters.length === 0) return uniqueStrings(unsupportedBindings);
  // A certified artifact may bake a restriction into its identity and SQL
  // rather than expose it as a dynamic parameter. For example,
  // top_beverage_customers has WHERE products.is_beverage and is already exactly
  // beverage-scoped. This is stronger than a description mention: scopeTokens
  // are sourced only from the certified name, tags, and WHERE clause.
  const uncoveredFilters = unboundRequestedFilters.filter((filter) => !block.scopeTokens.has(filter));
  if (uncoveredFilters.length === 0) return uniqueStrings(unsupportedBindings);
  // A filtered question cannot be answered exactly by an unparameterized block.
  // Returning [] here used to erase the user's restriction and let a broad
  // certified ranking (for example all-customer lifetime spend) answer a
  // category-specific question. A block may still be useful as context, but it
  // cannot terminate the certified lane unless it exposes the requested value
  // through a filter or dimension contract.
  if (block.filters.length === 0) {
    // A certified breakdown can be safely narrowed on one of its own output
    // dimensions when the question explicitly names that binding ("by segment
    // for Enterprise"). The adaptation lane applies the actual restriction.
    const explicitlyFilterable = block.dimensions.some((dimension) => {
      const words = dimension.replace(/_/g, '[ _-]+');
      return new RegExp(`\\b(?:by|per)\\s+${words}\\b`, 'i').test(question)
        || new RegExp(`\\b${words}\\s*(?:=|:|is|equals)`, 'i').test(question);
    });
    if (explicitlyFilterable) return uniqueStrings(unsupportedBindings);
    return uniqueStrings([
      ...unsupportedBindings,
      ...uncoveredFilters.filter((filter) => !block.dimensions.includes(filter)),
    ]);
  }
  const blockFilters = new Set(block.filters);
  return uniqueStrings([
    ...unsupportedBindings,
    ...uncoveredFilters.filter((filter) => !blockFilters.has(filter) && !block.dimensions.includes(filter)),
  ]);
}

function filterContractMatchesDimension(filter: string, dimension: string): boolean {
  const tokens = (value: string) => canonicalToken(value)
    .split('_')
    .filter((token) => token && token !== 'name' && token !== 'label' && token !== 'value' && token !== 'set');
  const left = tokens(filter);
  const right = tokens(dimension);
  return left.length > 0 && right.length > 0
    && (left.every((token) => right.includes(token)) || right.every((token) => left.includes(token)));
}

function extractSqlFilterScope(sql: string): string {
  const match = /\bwhere\b([\s\S]*?)(?=\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|$)/i.exec(sql);
  return match?.[1] ?? '';
}

/**
 * Static SQL predicates are execution scope, not descriptive relevance. Keep
 * only literal values and boolean `is_*` predicates so table aliases, SQL
 * keywords, and generic block tags do not become accidental business filters.
 */
function extractSqlStaticScope(sql: string): string {
  const where = extractSqlFilterScope(sql);
  if (!where) return '';
  const literals = [...where.matchAll(/'(?:''|[^'])*'|"(?:""|[^"])*"/g)]
    .map((match) => (match[0] ?? '').slice(1, -1).replace(/''/g, "'").replace(/""/g, '"'));
  const booleanPredicates = [...where.matchAll(/\b(?:[a-z_][a-z0-9_]*\.)?is_([a-z][a-z0-9_]*)\s*=\s*(?:true|1)\b/gi)]
    .map((match) => match[1] ?? '');
  return [...literals, ...booleanPredicates].join(' ');
}

function questionEntailsScopeToken(
  question: string,
  plan: AnalysisQuestionPlan,
  requested: RequestedAnswerShape,
  token: string,
): boolean {
  const requestedTokens = new Set(tokensFromValue([
    question,
    ...plan.searchTerms,
    ...plan.filterTerms,
    ...requested.filters,
    ...(requested.memberBindings ?? []).flatMap((binding) => binding.values),
    ...requested.followUpReferences.flatMap((reference) => reference.resolvedValues ?? []),
  ].join(' ')).map(canonicalToken));
  return requestedTokens.has(canonicalToken(token));
}

function isTemporalFilter(filter: string): boolean {
  return /^(?:day|week|month|quarter|year|season)$/.test(filter)
    || /^(?:last|this|next|previous|prior|current)_(?:day|week|month|quarter|year|season)$/.test(filter)
    || /^\d{4}$/.test(filter);
}

function topNFitAction(requested: RequestedAnswerShape, block: BlockShape): CertifiedBlockFit['topNAction'] {
  if (!requested.topN) return 'none';
  if (!block.limit) return 'none';
  if (block.limit === requested.topN.n) return 'none';
  if (block.limit > requested.topN.n) return 'trim';
  return 'generate';
}

function outputCoversRequired(outputs: string[], required: string): boolean {
  const outputSet = new Set(outputs);
  if (outputSet.has(required)) return true;
  const requiredTokens = required.split('_').filter(Boolean);
  if (requiredTokens.length === 0) return true;
  if (required.endsWith('_name')) {
    const entity = requiredTokens[0] ?? '';
    return outputs.some((output) => {
      const tokens = output.split('_');
      return tokens.includes(entity) && (tokens.includes('name') || tokens.includes('title') || output === entity);
    });
  }
  return outputs.some((output) => requiredTokens.every((token) => output.split('_').includes(token)));
}

function outputRequirementCovered(required: string, block: BlockShape): boolean {
  const roleRequirement = analyticalRoleOutput(required);
  // Compound dimension outputs are contracts, not loose keyword hints.
  // `beverage_product_types` (a count) must not satisfy `product_type`, and a
  // block that merely touches products must not satisfy `product_name`.
  // Requiring the concrete projected output here prevents a high-overlap block
  // at the wrong grain from being promoted to an exact certified answer.
  if (isStructuredDimensionOutput(roleRequirement)) {
    const directDimension = roleRequirement.replace(/_(?:name|title)$/, '');
    return block.outputs.includes(roleRequirement)
      || (directDimension !== roleRequirement && block.outputs.includes(directDimension));
  }
  if (outputCoversRequired(block.outputs, roleRequirement)) return true;
  const token = canonicalToken(roleRequirement);
  if (block.dimensions.includes(token)) return true;
  if (isMeasureLike(roleRequirement) || block.measures.includes(canonicalMetricOutputIdentity(roleRequirement))) {
    return block.measures.includes(canonicalMetricOutputIdentity(roleRequirement));
  }
  return false;
}

/**
 * Exact authored examples are executable contract evidence, but only after
 * their own block has proved the requested measure and every structural answer
 * role.  A natural-language parser can retain a member value as a dimension or
 * output requirement: in the authored example "revenue by food and drink",
 * `food` and `drink` are values of the declared `category` role, not physical
 * dimensions.  Do not use this escape hatch for a named block, a merely
 * lexical example, or a shared example.  That would make descriptions/tags or
 * pooled candidates silently redefine the answer shape again.
 */
function uniqueExactExampleMemberToken(
  input: Parameters<typeof evaluateCertifiedBlockFit>[0],
  token: string,
  block: BlockShape,
): boolean {
  if (!input.exactExampleMatch || !input.uniqueExactExampleContract) return false;
  if (block.dimensions.length === 0 && block.outputs.length === 0) return false;
  const canonical = canonicalToken(token);
  if (!canonical || block.dimensions.includes(canonical) || block.outputs.includes(canonical)) return false;
  // Never reinterpret a measure, a concrete output role, a time role, or a
  // common entity/dimension role as a member value.  Those are requirements the
  // block must declare locally even for an exact authored example.
  if (isMeasureLike(canonical)
    || isStructuredDimensionOutput(canonical)
    || EXACT_EXAMPLE_STRUCTURAL_ROLES.has(canonical)) return false;
  return true;
}

const EXACT_EXAMPLE_STRUCTURAL_ROLES = new Set([
  'product', 'customer', 'account', 'user', 'member', 'category', 'segment',
  'region', 'channel', 'order', 'day', 'week', 'month', 'quarter', 'year',
]);

/**
 * Ranking words describe the result ordering, not an extra projected field.
 * `top_customer` is therefore covered by a declared `customer_name` output
 * only after the independent ranking/limit checks have accepted the block.
 */
function analyticalRoleOutput(value: string): string {
  return value.replace(/^(?:top|bottom|highest|lowest|best|worst|leading)_/, '');
}

function artifactNameRequirement(required: string, block: MetadataObject | KGNode): boolean {
  const name = canonicalColumn((block as { name?: unknown }).name as string ?? '');
  return Boolean(name && name === required);
}

function isStructuredDimensionOutput(value: string): boolean {
  return /_(?:id|key|name|title|type|category|segment|region|country|channel|date|month|quarter|year)$/.test(value)
    && !isMeasureLike(value);
}

function outputHasEntity(outputs: Set<string>, entity: string): boolean {
  for (const output of outputs) {
    if (output === entity || output.split('_').includes(entity)) return true;
  }
  return false;
}

function extractSqlOutputs(sql: string): string[] {
  const shape = extractSimpleSelectShape(sql);
  if (shape) {
    return shape.selectExpressions
      .map(selectExpressionOutputName)
      .filter((value): value is string => Boolean(value));
  }

  // A scalar certified KPI may intentionally be a source-free SELECT, for
  // example `SELECT 42500 AS revenue_total`. It is still an authored output
  // contract, so recognize explicit aliases without falling back to prose,
  // tags, examples, or pooled retrieval evidence. Keep this deliberately
  // narrow: complex/ambiguous SQL remains unavailable for Tier-1 proof.
  const scalar = sql.trim().replace(/;\s*$/, '');
  if (!/^select\s+/i.test(scalar) || /\bfrom\b/i.test(scalar)) return [];
  return [...scalar.matchAll(/\bas\s+(["`]?\w+["`]?)\b/gi)]
    .map((match) => match[1]?.replace(/^["`]|["`]$/g, '').trim())
    .filter((value): value is string => Boolean(value));
}

function outputContractColumns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [
      ...stringArray(value),
      ...arrayObjectNames(value),
    ];
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...stringArray(record.columns),
    ...stringArray(record.outputs),
    ...arrayObjectNames(record.columns),
    ...arrayObjectNames(record.outputs),
  ];
}

function filterBindingNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    return [stringValue(record.filter), stringValue(record.name), stringValue(record.binding)].filter((v): v is string => Boolean(v));
  });
}

function arrayObjectNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    return [stringValue(record.name), stringValue(record.field), stringValue(record.column)].filter((v): v is string => Boolean(v));
  });
}

function parseSqlLimit(sql: string): number | undefined {
  const match = sql.match(/\blimit\s+(\d{1,6})\b/i);
  return match ? Number(match[1]) : undefined;
}

function isMetadataObject(value: MetadataObject | KGNode): value is MetadataObject {
  return 'objectKey' in value && 'objectType' in value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return [stringValue(record.name), stringValue(record.field), stringValue(record.column)].filter((v): v is string => Boolean(v));
    }
    return [];
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isDimensionLike(value: string): boolean {
  return /\b(account|category|channel|cohort|country|customer|date|department|geo|hour|item|location|market|member|month|order|period|person|player|product|quarter|region|segment|sku|store|team|territory|type|user|vendor|week|year)\b/.test(value);
}

function isMeasureLike(value: string): boolean {
  const measureTerms = new Set([
    'amount', 'arr', 'average', 'avg', 'balance', 'booking', 'churn',
    'conversion', 'cost', 'count', 'duration', 'expense', 'growth', 'kpi',
    'margin', 'metric', 'mrr', 'number', 'order', 'point', 'profit',
    'quantity', 'rate', 'revenue', 'sale', 'score', 'spend', 'stat', 'total',
    'usage', 'value', 'volume',
  ]);
  return tokensFromValue(value).some((token) => measureTerms.has(token));
}

function tokensFromValue(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token !== 'id')
    .map((token) => (token.endsWith('id') && token.length > 3 ? token.slice(0, -2) : token))
    .map(singularize);
}

function canonicalColumn(value: string): string {
  return tokensFromValue(value).join('_');
}

/**
 * Canonical identity for a declared metric OUTPUT, not a retrieval synonym.
 *
 * `gross_revenue`, `net_revenue`, `total_revenue`, and `monthly_revenue` are
 * ordinary authored aliases for the same revenue output family.  By contrast,
 * `product_revenue`, `beverage_revenue`, and `lifetime_spend` retain their
 * business qualifiers and cannot silently answer a generic `revenue` request.
 */
function canonicalMetricOutputIdentity(value: string): string {
  const aliases: Record<string, string> = {
    avg: 'average',
    beverage: 'beverage',
    drink: 'beverage',
    score: 'point',
    scorer: 'point',
    scoring: 'point',
    sale: 'revenue',
    sales: 'revenue',
    spend: 'revenue',
    spent: 'revenue',
    spending: 'revenue',
    sum: 'total',
  };
  const genericModifiers = new Set([
    'annual', 'average', 'current', 'daily', 'gross', 'monthly', 'net',
    'quarterly', 'total', 'yearly',
  ]);
  const tokens = tokensFromValue(value)
    .map((token) => aliases[token] ?? token)
    .filter(Boolean);
  while (tokens.length > 1 && genericModifiers.has(tokens[0]!)) tokens.shift();
  while (tokens.length > 1 && genericModifiers.has(tokens.at(-1)!)) tokens.pop();
  return tokens.join('_');
}

/**
 * Planner extraction may retain both a complete phrase (`total points`) and
 * its presentation modifier (`total`). The latter is not an independently
 * requested metric; requiring an output literally named `total` would reject
 * the artifact that explicitly projects `total_points`. Retain a bare generic
 * request only when it is all the reader supplied.
 */
function requestedMetricOutputIdentities(values: string[]): string[] {
  const identities = uniqueStrings(values.map(canonicalMetricOutputIdentity).filter(Boolean));
  if (identities.length <= 1) return identities;
  return identities.filter((identity) => identity !== 'total' && identity !== 'average');
}

/**
 * A scoped declared output can satisfy the metric root only when every
 * business qualifier is explicitly present in the request.  This keeps
 * `beverage_revenue` valid for a beverage request while preventing the
 * unrelated `lifetime_spend` output from standing in for bare revenue.
 *
 * This is still output-contract evidence: descriptions, tags, examples, and
 * neighbouring candidates never participate in the match.
 */
function declaredQualifiedOutputCoversMeasure(
  block: BlockShape,
  requestedMeasure: string,
  question: string,
  plan: AnalysisQuestionPlan,
  requested: RequestedAnswerShape,
): boolean {
  const requestedRoot = metricOutputRoot(requestedMeasure);
  if (!requestedRoot) return false;
  return block.measures.some((declaredMeasure) => {
    // A count that is explicitly named after the requested entity is a
    // role-correct authored metric identity: `customer_count` answers "how
    // many customers", and `order_count` answers "total orders".  Require
    // the count/total language in the question so a generic entity reference
    // cannot become a count merely through retrieval proximity.
    if (declaredMeasure === `${requestedMeasure}_count`
      && /\b(?:how\s+many|count|number\s+of|total)\b/i.test(question)) {
      return true;
    }
    // The same count with business qualifiers (`large_order_count`) answers
    // "how many large orders" when the question states every qualifier.
    if (declaredMeasure.endsWith(`_${requestedMeasure}_count`)
      && /\b(?:how\s+many|count|number\s+of|total)\b/i.test(question)
      && declaredMeasure.slice(0, -`_${requestedMeasure}_count`.length).split('_').every((qualifier) =>
        questionEntailsOutputQualifier(question, plan, requested, qualifier))) {
      return true;
    }
    if (metricOutputRoot(declaredMeasure) !== requestedRoot) return false;
    const qualifiers = metricOutputQualifiers(declaredMeasure);
    if (qualifiers.length > 0 && qualifiers.every((qualifier) =>
      questionEntailsOutputQualifier(question, plan, requested, qualifier))) return true;
    // Conversely, a generic output becomes a qualified answer only when the
    // block itself declares every qualifier as a dimension/output at the
    // requested grain.  This admits an authored `{ product_name, revenue }`
    // block for product revenue, while never allowing a lifetime-spend block
    // to impersonate generic revenue.
    const requestedQualifiers = metricOutputQualifiers(requestedMeasure);
    return declaredMeasure === requestedRoot
      && requestedQualifiers.length > 0
      && requestedQualifiers.every((qualifier) =>
        block.dimensions.includes(canonicalToken(qualifier))
        || outputHasEntity(new Set(block.outputs), canonicalToken(qualifier)))
      && requestedQualifiers.every((qualifier) =>
        questionEntailsOutputQualifier(question, plan, requested, qualifier));
  });
}

export interface NamedSemanticMeasure {
  /** Semantic metric local name, e.g. `large_orders`. */
  metric: string;
  /** Canonical metric output identity, e.g. `large_order`. */
  identity: string;
  /** Business qualifiers that scope the metric, e.g. `['large']`. */
  qualifiers: string[];
}

/**
 * Semantic metrics the question names by their name or label whose identity
 * carries a business qualifier beyond the measure and entity words: "large
 * orders" names `large_orders`, "food revenue %" names `food_revenue_pct`.
 *
 * Only the longest named phrase counts, so "food revenue" names `food_revenue`
 * and not also `revenue`. Unqualified metrics (`orders`, `revenue`,
 * `order_total`) add nothing: the planner's own measures already cover them.
 */
export function namedQualifiedSemanticMeasures(
  question: string,
  objects: Array<Pick<MetadataObject, 'objectType' | 'name' | 'payload'>>,
): NamedSemanticMeasure[] {
  const questionTokens = tokensFromValue(question);
  const named: Array<NamedSemanticMeasure & { start: number; end: number }> = [];
  for (const object of objects) {
    if (object.objectType !== 'semantic_metric') continue;
    const metric = stringValue(object.payload?.localId) ?? object.name.split('.').at(-1) ?? object.name;
    const phrases = [metric, stringValue(object.payload?.label) ?? ''].filter(Boolean);
    const span = phrases
      .map((phrase) => tokenPhraseSpan(questionTokens, tokensFromValue(phrase)))
      .filter((match): match is { start: number; end: number } => Boolean(match))
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    if (!span) continue;
    const identity = canonicalMetricOutputIdentity(metric);
    const qualifiers = metricOutputQualifiers(identity).filter((token) => !isDimensionLike(token));
    named.push({ metric, identity, qualifiers, ...span });
  }
  return named
    .filter((item) => !named.some((other) =>
      other !== item
      && other.start <= item.start && other.end >= item.end
      && other.end - other.start > item.end - item.start))
    .filter((item) => item.qualifiers.length > 0)
    .map(({ metric, identity, qualifiers }) => ({ metric, identity, qualifiers }));
}

function tokenPhraseSpan(haystack: string[], needle: string[]): { start: number; end: number } | undefined {
  if (needle.length === 0 || needle.length > haystack.length) return undefined;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) {
      return { start, end: start + needle.length };
    }
  }
  return undefined;
}

/**
 * A block answers a named qualified semantic metric only when its own outputs
 * say so: an output with the same identity, a qualified output whose
 * qualifiers the question entails, or a measure with the same root
 * (`order_count` for orders) inside a static scope (WHERE, name, tags) that
 * declares every qualifier. `monthly_revenue`'s `order_count` counts every
 * order, so it does not answer "large orders".
 */
function blockCoversNamedSemanticMeasure(
  block: BlockShape,
  measure: NamedSemanticMeasure,
  question: string,
  plan: AnalysisQuestionPlan,
  requested: RequestedAnswerShape,
): boolean {
  if (block.measures.includes(measure.identity)) return true;
  if (declaredQualifiedOutputCoversMeasure(block, measure.identity, question, plan, requested)) return true;
  const root = metricOutputRoot(measure.identity);
  const sameRoot = block.measures.some((declared) => {
    const tokens = declared.split('_');
    return tokens.at(-1) === root || (tokens.at(-1) === 'count' && tokens.at(-2) === root);
  });
  const scoped = measure.qualifiers.every((qualifier) =>
    block.scopeTokens.has(canonicalToken(qualifier))
    || block.outputs.some((output) => output.split('_').includes(qualifier)));
  return sameRoot && scoped;
}

function metricOutputRoot(identity: string): string | undefined {
  return identity.split('_').filter(Boolean).at(-1);
}

function metricOutputQualifiers(identity: string): string[] {
  const tokens = identity.split('_').filter(Boolean);
  return tokens.slice(0, -1);
}

function questionEntailsOutputQualifier(
  question: string,
  plan: AnalysisQuestionPlan,
  requested: RequestedAnswerShape,
  qualifier: string,
): boolean {
  if (questionEntailsScopeToken(question, plan, requested, qualifier)) return true;
  // This is a role-safe authored alias pair, not a broad retrieval synonym.
  // It is deliberately limited to the fixture/domain-neutral vocabulary that
  // the planner itself treats as the same category restriction.
  if (qualifier === 'beverage') {
    return /\b(?:beverage|drink)\b/i.test(question);
  }
  return false;
}

function canonicalToken(value: string): string {
  const tokens = tokensFromValue(value);
  if (tokens.length === 0) return '';
  if (tokens.includes('product')) return 'product';
  if (tokens.includes('category')) return 'category';
  if (tokens.includes('customer') || tokens.includes('client')) return 'customer';
  if (tokens.includes('account')) return 'account';
  if (tokens.includes('user') || tokens.includes('member')) return 'user';
  if (tokens.includes('region') || tokens.includes('geo') || tokens.includes('market') || tokens.includes('territory')) return 'region';
  if (tokens.includes('segment') || tokens.includes('cohort')) return 'segment';
  if (tokens.includes('channel')) return 'channel';
  if (tokens.includes('order')) return 'order';
  if (tokens.includes('revenue') || tokens.includes('sale') || tokens.includes('spend') || tokens.includes('amount')) return 'revenue';
  if (tokens.includes('score') || tokens.includes('scoring') || tokens.includes('scorer') || tokens.includes('point')) return 'score';
  if (tokens.includes('count') || tokens.includes('number') || tokens.includes('quantity') || tokens.includes('volume')) return 'count';
  if (tokens.includes('week')) return 'week';
  if (tokens.includes('month')) return 'month';
  if (tokens.includes('quarter')) return 'quarter';
  if (tokens.includes('year') || tokens.includes('season')) return 'year';
  if (tokens.includes('day') || tokens.includes('date')) return 'day';
  return tokens[0] ?? '';
}

function singularize(token: string): string {
  // `gross` is an uninflected measure modifier, not a plural. Treating it as
  // `gros` made a `gross_revenue` output look like an unexplained static scope
  // and incorrectly demoted a complete certified monthly-revenue block.
  if (token === 'gross') return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 3) return token.slice(0, -1);
  return token;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}
