import {
  semanticDimensionReference,
  renderSemanticBlockSource,
  type BlockParameterDefinition,
  type ComposeQueryResult,
  type DimensionDefinition,
  type DqlArtifactReference,
  type MetricDefinition,
  type SemanticLayer,
} from '@zlens/core';
import type { KGNode } from '../kg/types.js';
import type { AnalysisQuestionPlan } from '../metadata/analysis-planner.js';

export interface SemanticBridgeFilter {
  dimension: string;
  operator: string;
  values: string[];
}

export interface SemanticBridgeOrderBy {
  name: string;
  direction: 'asc' | 'desc';
}

export interface SemanticFilterValueBinding {
  column: string;
  canonicalValue: string;
  match: 'exact' | 'normalized' | 'fuzzy';
  confidence: number;
}

export interface SemanticDqlArtifactInput {
  question: string;
  name?: string;
  metrics: string[];
  domain?: string;
  titleFallback?: string;
  dimensions: string[];
  filters: SemanticBridgeFilter[];
  timeDimension?: { name: string; granularity: string };
  orderBy?: SemanticBridgeOrderBy[];
  limit?: number;
}

export interface SemanticBridgeQueryResult {
  sql: string;
  /** Primary metric kept for backward-compatible route labels and citations. */
  metric: string;
  metrics: string[];
  dimensions: string[];
  filters: SemanticBridgeFilter[];
  timeDimension?: { name: string; granularity: string };
  orderBy?: SemanticBridgeOrderBy[];
  limit?: number;
  dqlArtifact: DqlArtifactReference & { kind: 'semantic_block' };
  composeResult: ComposeQueryResult;
}

export interface ComposeSemanticQueryInput {
  semanticLayer: SemanticLayer;
  question: string;
  questionPlan: AnalysisQuestionPlan;
  matchedMetric?: KGNode;
  driver?: string;
  tableMapping?: Record<string, string>;
  /**
   * Resolve a filter literal to the physical column name(s) whose sampled values
   * contain it (from the runtime value index / schema sample values). Lets us bind
   * a value like "beverage" to whichever dimension actually carries it, instead of
   * hard-coding project-specific value→dimension guesses.
   */
  filterValueColumns?: (value: string) => string[];
  /**
   * Field-scoped canonical member binding. Unlike metadata token search, this
   * preserves a stored value phrase and lets the compiler use the canonical
   * warehouse member (`Melissa Lopez`) while keeping the user's typo out of SQL.
   */
  filterValueBindings?: (value: string) => SemanticFilterValueBinding[];
  /**
   * Project vocabulary from DQL terms — the words THIS business uses.
   *
   * The built-in synonym clusters below are deliberately domain-neutral, which
   * means an internal term ("BCM", "ACM") could only ever be taught to the agent
   * by editing this file. Terms now carry `synonyms` and `metricRefs`, so a
   * project extends the vocabulary by writing a term instead of patching DQL.
   */
  vocabulary?: SemanticVocabulary;
}

export interface SemanticVocabulary {
  /** Equivalence clusters, merged with (never replacing) the built-in defaults. */
  synonymClusters?: string[][];
  /** Lowercased phrase -> governed metric names the phrase names. */
  metricAliases?: Record<string, string[]>;
}

export function composeSemanticQueryForQuestion(input: ComposeSemanticQueryInput): SemanticBridgeQueryResult | undefined {
  if (input.questionPlan.requestedShape.topN?.scope === 'per_group') return undefined;
  activeProjectSynonyms = buildProjectSynonymIndex(input.vocabulary?.synonymClusters);
  activeMetricAliasPhrases = buildMetricAliasPhrases(input.vocabulary?.metricAliases);
  try {
    return composeSemanticQueryForQuestionInner(input);
  } finally {
    // Always clear: a leaked overlay would apply one project's vocabulary to
    // the next question in a long-lived server process.
    activeProjectSynonyms = undefined;
    activeMetricAliasPhrases = undefined;
  }
}

function composeSemanticQueryForQuestionInner(input: ComposeSemanticQueryInput): SemanticBridgeQueryResult | undefined {

  // Prefer REAL metrics over dbt measures projected into the metrics map: match
  // against metrics-only first, and only fall back to the full pool (measures
  // included) when the question names no real metric — so "consumption % by
  // customer" picks the ratio metric, while "total bcm_amount" can still bind
  // its backing measure. De-conflation without touching the store.
  const metrics = ((): MetricDefinition[] => {
    const allMetrics = input.semanticLayer.listMetrics();
    // Exact user-authored names are authoritative even when an imported semantic
    // project represents some of them as measure projections. Choosing the
    // metrics-only pool first used to retain one business metric and silently
    // discard every explicitly named measure beside it.
    if (explicitlyNamedMetrics(allMetrics, input.question).length > 0) {
      return selectMetrics(allMetrics, input);
    }
    const metricsOnly = selectMetrics(input.semanticLayer.listMetrics(undefined, { includeMeasures: false }), input);
    return metricsOnly.length > 0 ? metricsOnly : selectMetrics(allMetrics, input);
  })();
  const primaryMetric = metrics[0];
  if (!primaryMetric) return undefined;

  const timeDimension = selectTimeDimension(input.semanticLayer, input.question, input.questionPlan, primaryMetric);
  const allDimensions = input.semanticLayer.listDimensions(undefined, { includeVariants: true });
  const dimensionSelection = selectDimensions(allDimensions, input.questionPlan, timeDimension?.name, input.question);
  const dimensions = dimensionSelection.dimensions;
  const relativeComparison = entityRelativeComparisonSpec(input, allDimensions, dimensions);
  if (requiresEntityRelativeMeasureComparison(input.question)) {
    if (!relativeComparison || timeDimension || dimensions.length !== 1) return undefined;
    const candidates = [
      ...metrics,
      ...alternativePrimaryMetrics(input, new Set(metrics.map((metric) => metric.name))),
    ];
    for (const metric of candidates) {
      const relative = buildEntityRelativeSemanticResult({
        input,
        metric,
        dimension: relativeComparison.dimension,
        referenceValue: relativeComparison.referenceValue,
        operator: relativeComparison.operator,
      });
      if (relative) return relative;
    }
    return undefined;
  }
  const filters = selectFilters(
    allDimensions,
    dimensions,
    input.question,
    input.questionPlan,
    timeDimension?.name,
    input.filterValueColumns,
    input.filterValueBindings,
  );
  // A semantic metric can legitimately encode a restriction in its governed
  // definition (`drink_revenue`, `enterprise_arr`). In that case requiring a
  // second physical dimension filter is both redundant and sometimes
  // impossible. Only treat an unresolved restriction as fatal when the selected
  // metric does not itself cover the qualifier.
  // A date restriction ("in 2025", "since March 2024") has no semantic filter
  // this compiler can write. Compiling without it answered all-time figures
  // under a governed label; refuse so a lane that can apply it answers.
  if (hasUnappliedDateRestriction(input.question, input.questionPlan)) return undefined;
  const unresolvedMetricFilters = input.questionPlan.requestedShape.filters.length > 0 && filters.length === 0;
  if (unresolvedMetricFilters
    && !metricEncodesRequestedFilters(primaryMetric, input.questionPlan.requestedShape.filters)) return undefined;
  // Abort only on a LOAD-BEARING unresolved dimension — one that isn't actually a
  // filter value or a time grain we already captured. Previously ANY unresolved
  // term (compose.ts:75) killed the governed compile, so "revenue for beverages by
  // month" fell to raw generation because "beverages" (a filter value) and "month"
  // (the time grain) parsed as dimension terms that no dimension is named after.
  const consumed = consumedTermTokens(filters, timeDimension);
  const loadBearing = dimensionSelection.unresolved.filter((term) => {
    const tokens = tokenize(term);
    return tokens.length > 0 && !tokens.every((token) => consumed.has(token));
  });
  if (loadBearing.length > 0) return undefined;
  const limit = input.questionPlan.requestedShape.topN?.n;
  const buildFor = (candidateMetrics: MetricDefinition[]): SemanticBridgeQueryResult | undefined => {
    const primary = candidateMetrics[0];
    if (!primary) return undefined;
    // Every retry candidate must independently preserve an unresolved qualifier.
    // Otherwise a failed category-specific compile (`drink_revenue by customer`)
    // can silently retry a broad metric (`lifetime_spend`) and erase "beverage".
    if (unresolvedMetricFilters
      && !metricEncodesRequestedFilters(primary, input.questionPlan.requestedShape.filters)) return undefined;
    const orderBy = input.questionPlan.requestedShape.topN
      ? [{ name: primary.name, direction: input.questionPlan.requestedShape.rankingDirection === 'bottom' ? 'asc' as const : 'desc' as const }]
      : undefined;
    return buildSemanticBridgeResult({
      semanticLayer: input.semanticLayer,
      question: input.question,
      metrics: candidateMetrics,
      dimensions,
      filters,
      timeDimension,
      orderBy,
      limit,
      driver: input.driver,
      tableMapping: input.tableMapping,
    });
  };

  const primary = buildFor(metrics);
  if (primary || dimensions.length === 0) return primary;
  // Grain-aware disambiguation: the chosen metric could not compose with the
  // requested breakdown (wrong grain — e.g. an all-orders `total_revenue` asked
  // "by product", when a product-grain `product_revenue` exists). Retry with each
  // OTHER family/concept-matching metric as the sole primary until one whose grain
  // actually joins the requested dimensions composes. This is what makes "revenue
  // by product" land on product_revenue instead of falling to raw generation.
  const tried = new Set(metrics.map((metric) => metric.name));
  for (const alternative of alternativePrimaryMetrics(input, tried)) {
    const result = buildFor([alternative]);
    if (result) return result;
  }
  return undefined;
}

/** A validated member selection, e.g. from an LLM emitting the query_semantic_model contract. */
export interface SemanticMemberSelection {
  metrics: string[];
  dimensions?: string[];
  timeDimension?: { name: string; granularity: string };
  filters?: SemanticBridgeFilter[];
  orderBy?: SemanticBridgeOrderBy[];
  limit?: number;
}

/**
 * Compose from an EXPLICIT member selection (metrics/dimensions/grain/filters),
 * validating each member against the layer before compiling. This is the Lane-2
 * fallback when deterministic token-overlap selection misses but the semantic
 * layer still covers the question — an LLM picks members, the compiler owns SQL.
 */
export function composeSemanticQueryFromMembers(input: {
  semanticLayer: SemanticLayer;
  question: string;
  selection: SemanticMemberSelection;
  driver?: string;
  tableMapping?: Record<string, string>;
}): SemanticBridgeQueryResult | undefined {
  if (requiresEntityRelativeMeasureComparison(input.question)) return undefined;
  const resolved = resolveSemanticMemberSelection(input.semanticLayer, input.selection);
  if (!resolved) return undefined;

  return buildSemanticBridgeResult({
    semanticLayer: input.semanticLayer,
    question: input.question,
    metrics: resolved.metrics,
    dimensions: resolved.dimensions,
    filters: resolved.filters,
    timeDimension: input.selection.timeDimension,
    orderBy: input.selection.orderBy,
    limit: input.selection.limit,
    driver: input.driver,
    tableMapping: input.tableMapping,
  });
}

/** Finalize SQL compiled by an external governed semantic runtime (for example
 * dbt Cloud or local MetricFlow) into the same identity-preserving result used
 * by the native compiler. Member validation still happens against the immutable
 * local semantic snapshot before the external SQL is accepted. */
export function composeSemanticQueryFromCompiledMembers(input: {
  semanticLayer: SemanticLayer;
  question: string;
  selection: SemanticMemberSelection;
  sql: string;
}): SemanticBridgeQueryResult | undefined {
  if (requiresEntityRelativeMeasureComparison(input.question) || !input.sql.trim()) return undefined;
  const resolved = resolveSemanticMemberSelection(input.semanticLayer, input.selection);
  if (!resolved) return undefined;
  return finalizeSemanticBridgeResult({
    semanticLayer: input.semanticLayer,
    question: input.question,
    metrics: resolved.metrics,
    dimensions: resolved.dimensions,
    filters: resolved.filters,
    timeDimension: input.selection.timeDimension,
    orderBy: input.selection.orderBy,
    limit: input.selection.limit,
  }, { sql: input.sql.trim(), joins: [], tables: [] });
}

function resolveSemanticMemberSelection(
  semanticLayer: SemanticLayer,
  selection: SemanticMemberSelection,
): { metrics: MetricDefinition[]; dimensions: string[]; filters: SemanticBridgeFilter[] } | undefined {
  const metricByName = new Map(semanticLayer.listMetrics().map((metric) => [metric.name.toLowerCase(), metric]));
  const metrics = uniqueStrings(selection.metrics ?? [])
    .map((name) => metricByName.get(name.toLowerCase()))
    .filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));
  if (metrics.length === 0) return undefined;

  const selectedMetricNames = metrics.map((metric) => metric.name);
  // A cross-model MetricFlow group-by is metric-relative. Preserve that exact
  // adapter spelling only after the selected metric set has returned it from
  // its compatible set; a bare leaf is not a substitute for the entity path.
  // The same qualified reference is what plan resolution/freeze proved.
  const exactCompatibleReferences = new Set(
    semanticLayer.explainCompatibleDimensions(selectedMetricNames).compatible
      .map((dimension) => dimension.qualifiedName?.toLowerCase())
      .filter((reference): reference is string => Boolean(reference)),
  );
  const dimensions = uniqueStrings(selection.dimensions ?? [])
    .flatMap((name) => {
      const dimension = resolveSelectedDimension(semanticLayer, name, selectedMetricNames);
      if (!dimension) return [];
      return [exactCompatibleReferences.has(name.toLowerCase())
        ? name
        : semanticDimensionReference(dimension)];
    });
  const dimensionNames = new Set(
    semanticLayer.listDimensions(undefined, { includeVariants: true }).flatMap((dimension) => [
      dimension.name.toLowerCase(),
      semanticDimensionReference(dimension).toLowerCase(),
      dimension.qualifiedName?.toLowerCase(),
    ].filter((value): value is string => Boolean(value))),
  );
  for (const reference of exactCompatibleReferences) dimensionNames.add(reference);
  // A hallucinated dimension is a hard miss — refuse rather than silently drop it.
  if ((selection.dimensions ?? []).some((name) => !dimensionNames.has(name.toLowerCase()))) return undefined;
  const filters = (selection.filters ?? []).flatMap((filter) => {
    const dimension = resolveSelectedDimension(semanticLayer, filter.dimension, selectedMetricNames);
    return dimension ? [{
      ...filter,
      dimension: exactCompatibleReferences.has(filter.dimension.toLowerCase())
        ? filter.dimension
        : semanticDimensionReference(dimension),
    }] : [];
  });
  if ((selection.filters ?? []).length > 0 && filters.length === 0) return undefined;
  return { metrics, dimensions, filters };
}

function resolveSelectedDimension(
  semanticLayer: SemanticLayer,
  reference: string,
  metrics: string[],
): DimensionDefinition | undefined {
  if (typeof semanticLayer.resolveDimension === 'function') {
    return semanticLayer.resolveDimension(reference, metrics);
  }
  // Compatibility for test/dry-run adapters implementing the older minimal
  // SemanticLayer surface. Production layers always use the metric-aware core
  // resolver above.
  const normalized = reference.toLowerCase();
  return semanticLayer.listDimensions().find((dimension) =>
    dimension.name.toLowerCase() === normalized
    || semanticDimensionReference(dimension).toLowerCase() === normalized
    || dimension.qualifiedName?.toLowerCase() === normalized,
  );
}

function requiresEntityRelativeMeasureComparison(question: string): boolean {
  return /\b(?:less|lower|fewer|more|higher|greater)\b[^?.!]{0,80}\bthan\b\s+[a-z0-9@._'-]+/i.test(question)
    || /\b(?:below|under|above|over)\b\s+that\s+of\s+[a-z0-9@._'-]+/i.test(question);
}

function entityRelativeComparisonSpec(
  input: ComposeSemanticQueryInput,
  allDimensions: DimensionDefinition[],
  selectedDimensions: string[],
): { dimension: string; referenceValue: string; operator: '<' | '>' } | undefined {
  const operator = /\b(?:less|lower|fewer)\b[^?.!]{0,80}\bthan\b/i.test(input.question)
    || /\b(?:below|under)\b\s+that\s+of\b/i.test(input.question)
    ? '<' as const
    : /\b(?:more|higher|greater)\b[^?.!]{0,80}\bthan\b/i.test(input.question)
      || /\b(?:above|over)\b\s+that\s+of\b/i.test(input.question)
      ? '>' as const
      : undefined;
  if (!operator) return undefined;
  const mention = input.questionPlan.valueMentions.find((candidate) => candidate.syntacticRole === 'filter_value')
    ?? input.questionPlan.valueMentions[0];
  if (!mention?.text.trim()) return undefined;

  const bindings = input.filterValueBindings?.(mention.text) ?? [];
  const binding = bindings.length === 1 ? bindings[0] : undefined;
  // A unique bounded member binding can safely canonicalize a shortened name.
  // Without one, only carry a complete multi-token display name; a bare
  // "Melissa" could refer to multiple real members and must fall back to AI or
  // clarification instead of being guessed by the deterministic compiler.
  const referenceValue = binding?.canonicalValue
    ?? (mention.text.trim().split(/\s+/).length >= 2 ? mention.text.trim() : undefined);
  if (!referenceValue) return undefined;

  const boundDimension = binding
    ? allDimensions.find((dimension) => {
        const names = [dimension.name, dimension.sql, dimension.sql.split('.').pop() ?? '']
          .map((value) => value.toLowerCase());
        return names.includes(binding.column.toLowerCase());
      })?.name
    : undefined;
  const dimension = boundDimension && selectedDimensions.includes(boundDimension)
    ? boundDimension
    : selectedDimensions[0];
  return dimension ? { dimension, referenceValue, operator } : undefined;
}

function buildEntityRelativeSemanticResult(input: {
  input: ComposeSemanticQueryInput;
  metric: MetricDefinition;
  dimension: string;
  referenceValue: string;
  operator: '<' | '>';
}): SemanticBridgeQueryResult | undefined {
  const base = buildSemanticBridgeResult({
    semanticLayer: input.input.semanticLayer,
    question: input.input.question,
    metrics: [input.metric],
    dimensions: [input.dimension],
    filters: [],
    driver: input.input.driver,
    tableMapping: input.input.tableMapping,
  });
  if (!base) return undefined;

  const dimension = quoteSqlIdentifier(input.dimension);
  const metric = quoteSqlIdentifier(input.metric.name);
  const reference = `'${input.referenceValue.replace(/'/g, "''")}'`;
  const limit = input.input.questionPlan.requestedShape.topN?.n ?? 100;
  const sql = [
    'WITH peer_values AS (',
    indentSql(base.sql.trim().replace(/;+\s*$/, ''), 2),
    '),',
    'reference_value AS (',
    `  SELECT ${metric} AS baseline_value`,
    '  FROM peer_values',
    `  WHERE ${dimension} = ${reference}`,
    '  LIMIT 1',
    ')',
    `SELECT peer.${dimension} AS ${dimension},`,
    `       peer.${metric} AS ${metric}`,
    'FROM peer_values AS peer',
    'CROSS JOIN reference_value AS reference',
    `WHERE peer.${dimension} <> ${reference}`,
    `  AND peer.${metric} ${input.operator} reference.baseline_value`,
    `ORDER BY peer.${metric} DESC`,
    `LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
  ].join('\n');
  const relativeFilter: SemanticBridgeFilter = {
    dimension: input.dimension,
    operator: input.operator === '<' ? 'less_than_reference' : 'greater_than_reference',
    values: [input.referenceValue],
  };
  const orderBy: SemanticBridgeOrderBy[] = [{ name: input.metric.name, direction: 'desc' }];
  return {
    ...base,
    sql,
    filters: [relativeFilter],
    orderBy,
    limit,
    dqlArtifact: {
      ...base.dqlArtifact,
      compiledSql: sql,
    },
    composeResult: {
      ...base.composeResult,
      sql,
    },
  };
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function indentSql(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function buildSemanticBridgeResult(input: {
  semanticLayer: SemanticLayer;
  question: string;
  metrics: MetricDefinition[];
  dimensions: string[];
  filters: SemanticBridgeFilter[];
  timeDimension?: { name: string; granularity: string };
  orderBy?: SemanticBridgeOrderBy[];
  limit?: number;
  driver?: string;
  tableMapping?: Record<string, string>;
}): SemanticBridgeQueryResult | undefined {
  const { metrics, dimensions, filters, timeDimension, limit } = input;
  const primaryMetric = metrics[0];
  if (!primaryMetric) return undefined;
  // A time breakdown with no requested ranking used to emit NO ordering at all,
  // so the warehouse returned rows in whatever order it liked — in practice
  // oldest first — and a LIMIT then kept the OLDEST periods. "Revenue by month"
  // showed the start of history instead of what just happened. Most recent
  // first is what a time question means; an explicit ranking still wins,
  // because that ordering IS the question.
  const orderBy = input.orderBy
    ?? (timeDimension ? [{ name: timeDimension.name, direction: 'desc' as const }] : undefined);
  const composed = input.semanticLayer.composeQuery({
    metrics: metrics.map((metric) => metric.name),
    dimensions,
    ...(filters.length > 0 ? { filters } : {}),
    ...(timeDimension ? { timeDimension } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(limit ? { limit } : {}),
    ...(input.driver ? { driver: input.driver } : {}),
    ...(input.tableMapping ? { tableMapping: input.tableMapping } : {}),
  });
  if (!composed) return undefined;
  // A degenerate compile — empty/blank SQL — is NOT a governed answer. It happens
  // when the (LLM- or token-) selected metric×dimension combo can't be expressed
  // by the layer (e.g. a cumulative metric sliced by an unjoined product dimension:
  // `cumulative_revenue by product_description`). Returning it would surface a
  // confident "Answered from governed semantic metrics…" with an EMPTY SQL preview
  // and no rows — a hollow answer. Reject it so the answer loop falls through to
  // Lane-3 generation, which can express the join and actually execute.
  if (typeof composed.sql !== 'string' || composed.sql.trim().length === 0) return undefined;
  return finalizeSemanticBridgeResult(input, composed);
}

function finalizeSemanticBridgeResult(input: {
  semanticLayer: SemanticLayer;
  question: string;
  metrics: MetricDefinition[];
  dimensions: string[];
  filters: SemanticBridgeFilter[];
  timeDimension?: { name: string; granularity: string };
  orderBy?: SemanticBridgeOrderBy[];
  limit?: number;
}, composed: ComposeQueryResult): SemanticBridgeQueryResult {
  const { metrics, dimensions, filters, timeDimension, orderBy, limit } = input;
  const primaryMetric = metrics[0]!;
  const artifactName = semanticDqlArtifactName({
    question: input.question,
    metrics: metrics.map((metric) => metric.name),
    dimensions,
    filters,
    timeDimension,
    orderBy,
    limit,
  });
  const runtimeContract = semanticArtifactRuntimeContract({
    filters,
    limit,
  });
  return {
    sql: composed.sql,
    metric: primaryMetric.name,
    metrics: metrics.map((metric) => metric.name),
    dimensions,
    filters,
    ...(timeDimension ? { timeDimension } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(limit ? { limit } : {}),
    dqlArtifact: {
      kind: 'semantic_block',
      name: artifactName,
      source: renderSemanticDqlArtifact({
        name: artifactName,
        question: input.question,
        metrics: metrics.map((metric) => metric.name),
        domain: sharedMetricDomain(metrics),
        titleFallback: primaryMetric.label || primaryMetric.name,
        dimensions,
        filters,
        timeDimension,
        orderBy,
        limit,
      }),
      metrics: metrics.map((metric) => metric.name),
      dimensions,
      ...(filters.length > 0 ? { filters } : {}),
      ...(timeDimension ? { timeDimension } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(limit ? { limit } : {}),
      ...(runtimeContract.parameters.length > 0 ? { parameters: runtimeContract.parameters } : {}),
      ...(Object.keys(runtimeContract.values).length > 0 ? { parameterValues: runtimeContract.values } : {}),
      persistence: 'transient',
      trustState: 'governed',
      compiledSql: composed.sql,
    },
    composeResult: composed,
  };
}

function selectMetrics(metrics: MetricDefinition[], input: ComposeSemanticQueryInput): MetricDefinition[] {
  if (metrics.length === 0) return [];
  const selected: MetricDefinition[] = [];
  // "What share of revenue comes from food" names the parts of a governed
  // share metric (`food_revenue_pct`), never its label. Without this the
  // generic `revenue` won and the answer was total revenue.
  const share = shareMetricForQuestion(metrics, input.question);
  if (share) selected.push(share);
  // AGT-017 / E2E-012: preserve every metric the user names explicitly. The
  // catalog resolver may nominate one primary metric for routing, but that hint
  // must not collapse "revenue and refunds" into a one-metric answer.
  for (const metric of explicitlyNamedMetrics(metrics, input.question, input.questionPlan)) {
    if (share && metricPhraseTokens(metric).every((token) => metricPhraseTokens(share).includes(token))) continue;
    selected.push(metric);
  }
  const qualified = qualifiedMetricForQuestion(metrics, input.questionPlan);
  if (qualified && !selected.some((metric) => metric.name === qualified.name)) {
    selected.push(qualified);
  }
  const hintedNames = input.matchedMetric
    ? [input.matchedMetric.name, leafName(input.matchedMetric.name)]
    : [];
  for (const hint of hintedNames) {
    const hit = metrics.find((metric) => semanticNameMatches(metric, hint));
    if (!hit || selected.some((metric) => metric.name === hit.name)) continue;
    // The routing hint is the catalog's best SINGLE guess and is deliberately
    // broad. If the question already resolved a more specific member of the same
    // family — "beverage revenue" -> drink_revenue — adding the generic `revenue`
    // back alongside it re-broadens the very answer the qualifier narrowed.
    const hitPhrase = ` ${normalizeMetricPhrase(leafName(hit.name))} `;
    const alreadyMoreSpecific = selected.some((metric) =>
      ` ${normalizeMetricPhrase(leafName(metric.name))} `.includes(hitPhrase));
    if (alreadyMoreSpecific) break;
    selected.push(hit);
    break;
  }

  const concepts = metricSelectionConcepts(input.questionPlan);
  for (const concept of concepts) {
    const tokens = new Set(tokenize(concept));
    if (tokens.size === 0 || selected.some((metric) => scoreMetric(metric, tokens) > 0)) {
      continue;
    }
    const hit = bestMetricForConcept(metrics, tokens, selected);
    if (hit) selected.push(hit);
  }

  if (selected.length > 0) return selected;

  const fallbackTerms = new Set([...input.questionPlan.metricTerms, ...input.questionPlan.requestedShape.measures]
    .flatMap(tokenize)
    .filter((token) => !GENERIC_METRIC_CONCEPTS.has(token)));
  if (fallbackTerms.size === 0) return [];
  return metrics
    .map((metric) => ({ metric, score: scoreMetric(metric, fallbackTerms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.metric.name.localeCompare(b.metric.name))
    .slice(0, 1)
    .map((candidate) => candidate.metric);
}

/**
 * Resolve metric names/labels that appear verbatim in the question. A phrase is
 * accepted only when it identifies one catalog metric; shared labels such as
 * "Revenue" remain ambiguous and are left to the identifier-bound resolver.
 */
function explicitlyNamedMetrics(
  metrics: MetricDefinition[],
  question: string,
  questionPlan?: AnalysisQuestionPlan,
): MetricDefinition[] {
  const normalizedQuestion = ` ${normalizeMetricPhrase(question)} `;
  // A phrase the question uses only as its grouping entity ("for new versus
  // returning customers") is not a request for the `customers` count.
  const entityOnlyTerms = new Set(questionPlan
    ? [...questionPlan.dimensionTerms, ...questionPlan.requestedShape.dimensions]
      .map((term) => singularMetricPhrase(normalizeMetricPhrase(term)))
      .filter((term) => ![...questionPlan.metricTerms, ...questionPlan.requestedShape.measures]
        .some((measure) => singularMetricPhrase(normalizeMetricPhrase(measure)) === term))
    : []);
  const byPhrase = new Map<string, MetricDefinition[]>();
  for (const metric of metrics) {
    const base = [
      normalizeMetricPhrase(metric.name),
      normalizeMetricPhrase(leafName(metric.name)),
      normalizeMetricPhrase(metric.label ?? ''),
    ].filter((phrase) => phrase.length > 0);
    // Match the metric's business SYNONYMS too. The question planner throws the
    // qualifier away — "beverage revenue" and "drink revenue" both parse to
    // measures:["revenue"], filters:[] — so this verbatim phrase match is the only
    // stage that can still see it. Without synonym variants, `drink_revenue` was
    // reachable by the word "drink" but not by "beverage", and the question fell
    // back to the generic `revenue`, silently dropping the beverage restriction.
    // Phrases this project's terms declare for the metric ("BCM" -> bcm_total).
    // Without this a business's own vocabulary can only reach the agent by
    // editing DQL's hardcoded synonym table.
    const aliasPhrases = (activeMetricAliasPhrases?.get(metric.name.toLowerCase()) ?? [])
      .map((phrase) => normalizeMetricPhrase(phrase))
      .filter((phrase) => phrase.length > 0);
    const phrases = new Set([...base, ...aliasPhrases, ...[...base, ...aliasPhrases].flatMap(metricPhraseSynonymVariants)]);
    for (const phrase of phrases) {
      if (!normalizedQuestion.includes(` ${phrase} `)) continue;
      if (entityOnlyTerms.has(singularMetricPhrase(phrase))) continue;
      const candidates = byPhrase.get(phrase) ?? [];
      candidates.push(metric);
      byPhrase.set(phrase, candidates);
    }
  }

  const unambiguous = [...byPhrase.entries()]
    .filter(([, candidates]) => new Set(candidates.map((metric) => metric.name)).size === 1);
  // A broad phrase nested inside a more specific one is not a second metric the
  // user asked for: "drink revenue" also contains "revenue", which would turn a
  // two-metric question into a four-metric block.
  //
  // Occurrences decide it, not substring containment. A question naming BOTH
  // `..._bcm` and `..._bcm_qty` mentions the shorter name once on its own and
  // once inside the longer one, so it survives; "drink revenue" mentions
  // "revenue" only inside the specific phrase, so the generic drops out.
  const occurrences = (phrase: string): number => {
    const needle = ` ${phrase} `;
    let count = 0;
    let at = normalizedQuestion.indexOf(needle);
    while (at !== -1) {
      count += 1;
      at = normalizedQuestion.indexOf(needle, at + 1);
    }
    return count;
  };
  const subsumed = new Set(unambiguous
    .filter(([phrase]) => {
      const containedBy = unambiguous.filter(([other]) =>
        other !== phrase && ` ${other} `.includes(` ${phrase} `));
      if (containedBy.length === 0) return false;
      const covered = containedBy.reduce((total, [other]) => total + occurrences(other), 0);
      return occurrences(phrase) <= covered;
    })
    .map(([phrase]) => phrase));
  const resolved = unambiguous
    .filter(([phrase]) => !subsumed.has(phrase))
    .sort(([left], [right]) =>
      normalizedQuestion.indexOf(` ${left} `) - normalizedQuestion.indexOf(` ${right} `)
      || right.split(' ').length - left.split(' ').length)
    .map(([, candidates]) => candidates[0]!)
    .filter((metric, index, all) => all.findIndex((candidate) => candidate.name === metric.name) === index);
  return resolved;
}

/**
 * Business-synonym variants of a metric phrase, one token swapped at a time:
 * "drink revenue" also answers to "beverage revenue". Bounded to single-token
 * substitutions so the phrase stays a real business name rather than a fuzzy net.
 */
function metricPhraseSynonymVariants(phrase: string): string[] {
  const words = phrase.split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [];
  words.forEach((word, index) => {
    for (const synonym of semanticSynonymsFor(word)) {
      if (synonym === word) continue;
      const variant = [...words.slice(0, index), synonym, ...words.slice(index + 1)].join(' ');
      if (variant !== phrase) out.push(variant);
    }
  });
  return out;
}

function singularMetricPhrase(phrase: string): string {
  return phrase.split(' ').map((word) => word.length > 3 ? word.replace(/ies$/, 'y').replace(/s$/, '') : word).join(' ');
}

function metricPhraseTokens(metric: MetricDefinition): string[] {
  return tokenize(leafName(metric.name)).map((token) => singularMetricPhrase(token));
}

const SHARE_QUESTION = /\b(?:share|percent|percentage|proportion|fraction|ratio|pct)\b|%/i;
const SHARE_METRIC_TOKENS = new Set(['pct', 'percent', 'percentage', 'share', 'ratio', 'proportion', 'fraction', 'rate']);

/**
 * A share question ("what share of revenue comes from food") names the parts
 * of a governed share metric rather than its label. Pick the metric whose
 * name ends in a share word (`_pct`, `_share`, `_ratio`, ...) or which is a
 * ratio, when every other word of its name appears in the question. The most
 * specific such metric wins; ties stay unresolved.
 */
function shareMetricForQuestion(metrics: MetricDefinition[], question: string): MetricDefinition | undefined {
  if (!SHARE_QUESTION.test(question)) return undefined;
  const questionTokens = new Set(tokenize(question).map((token) => singularMetricPhrase(token)));
  const candidates = metrics
    .map((metric) => {
      const tokens = metricPhraseTokens(metric);
      const parts = tokens.filter((token) => !SHARE_METRIC_TOKENS.has(token));
      const isShare = (metric.metricType ?? '').toLowerCase() === 'ratio' || tokens.some((token) => SHARE_METRIC_TOKENS.has(token));
      return { metric, parts, isShare };
    })
    .filter((candidate) => candidate.isShare
      && candidate.parts.length >= 2
      && candidate.parts.every((token) => questionTokens.has(token)))
    .sort((a, b) => b.parts.length - a.parts.length);
  if (candidates.length === 0) return undefined;
  if (candidates.length > 1 && candidates[1]!.parts.length === candidates[0]!.parts.length) return undefined;
  return candidates[0]!.metric;
}

function normalizeMetricPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_./-]+/g, ' ')
    .replace(/[^a-z0-9% ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prefer a governed metric whose semantic definition covers an explicit user
 * qualifier as well as the requested measure family. This is what lets
 * `drink_revenue` outrank broad `lifetime_spend` for "spent ... on beverages"
 * without any project-specific metric name or table rule.
 */
function qualifiedMetricForQuestion(
  metrics: MetricDefinition[],
  questionPlan: AnalysisQuestionPlan,
): MetricDefinition | undefined {
  const qualifierTokens = expandedSemanticTokens(questionPlan.requestedShape.filters);
  const measureTokens = expandedSemanticTokens([
    ...questionPlan.requestedShape.measures,
    ...questionPlan.metricTerms,
  ]);
  if (qualifierTokens.size === 0 || measureTokens.size === 0) return undefined;
  return metrics
    .map((metric) => {
      const qualifierScore = scoreMetric(metric, qualifierTokens);
      const measureScore = scoreMetric(metric, measureTokens);
      return { metric, qualifierScore, measureScore, score: (qualifierScore * 10) + measureScore };
    })
    .filter((candidate) => candidate.qualifierScore > 0 && candidate.measureScore > 0)
    .sort((a, b) => b.score - a.score || a.metric.name.localeCompare(b.metric.name))[0]?.metric;
}

function metricEncodesRequestedFilters(metric: MetricDefinition, filters: string[]): boolean {
  const metricTokens = new Set(tokenize([
    metric.name,
    metric.label,
    metric.description,
    metric.domain,
    ...(metric.tags ?? []),
  ].join(' ')));
  return filters.every((filter) => {
    const tokens = expandedSemanticTokens([filter]);
    return tokens.size > 0 && [...tokens].some((token) => metricTokens.has(token));
  });
}

function expandedSemanticTokens(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    for (const token of tokenize(value)) {
      const singular = token.replace(/ies$/, 'y').replace(/s$/, '');
      out.add(token);
      if (singular.length > 1) out.add(singular);
      for (const synonym of semanticSynonymsFor(token)) out.add(synonym);
      for (const synonym of semanticSynonymsFor(singular)) out.add(synonym);
    }
  }
  return out;
}

/**
 * Family/concept-matching metrics NOT already tried as primary, ranked by concept
 * score, for the grain-aware disambiguation retry. When several metrics share a
 * measure family ("revenue"), the first-picked one may sit at the wrong grain for
 * the requested breakdown; these are the alternatives to try, best concept-match
 * first, so the compose can land on the metric whose grain actually joins the
 * requested dimensions. Bounded to a handful so the retry stays cheap.
 */
function alternativePrimaryMetrics(input: ComposeSemanticQueryInput, tried: Set<string>): MetricDefinition[] {
  const concepts = metricSelectionConcepts(input.questionPlan);
  const conceptTokens = new Set(concepts.flatMap((concept) => tokenize(concept)));
  if (conceptTokens.size === 0) return [];
  // An alternative must carry every word of at least one requested concept
  // ("revenue" → product_revenue). Sharing one word is not enough: when
  // average_order_value could not compile, `drink_orders` matched on "order"
  // and answered a question about something else.
  const conceptTokenSets = concepts.map((concept) => tokenize(concept)).filter((tokens) => tokens.length > 0);
  const coversAConcept = (metric: MetricDefinition) => {
    const metricTokens = new Set(tokenize([metric.name, metric.label].join(' ')).map((token) => singularMetricPhrase(token)));
    return conceptTokenSets.some((tokens) => tokens.every((token) => metricTokens.has(singularMetricPhrase(token))));
  };
  return input.semanticLayer.listMetrics()
    .filter((metric) => !tried.has(metric.name))
    .filter(coversAConcept)
    .map((metric) => ({ metric, score: scoreMetric(metric, conceptTokens) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.metric.name.localeCompare(b.metric.name))
    .slice(0, 6)
    .map((candidate) => candidate.metric);
}

function bestMetricForConcept(
  metrics: MetricDefinition[],
  tokens: Set<string>,
  selected: MetricDefinition[],
): MetricDefinition | undefined {
  const selectedNames = new Set(selected.map((metric) => metric.name));
  return metrics
    .filter((metric) => !selectedNames.has(metric.name))
    .map((metric) => ({ metric, score: scoreMetric(metric, tokens) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.metric.name.localeCompare(b.metric.name))[0]?.metric;
}

function scoreMetric(metric: MetricDefinition, terms: Set<string>): number {
  return scoreSemanticText([
    metric.name,
    metric.label,
    metric.description,
    metric.domain,
    ...(metric.tags ?? []),
  ].join(' '), terms);
}

function metricSelectionConcepts(questionPlan: AnalysisQuestionPlan): string[] {
  const raw = uniqueStrings([
    ...questionPlan.requestedShape.measures,
    ...questionPlan.metricTerms,
  ].map((term) => normalizeSemanticText(term)).filter(Boolean));
  // Only generic words ("count", "total") name no metric: "How many employees
  // work at each store?" plans as just `count` once "employees" is unknown,
  // and used to compile `count_lifetime_orders`.
  return raw.filter((term) => !GENERIC_METRIC_CONCEPTS.has(term)).slice(0, 4);
}

function sharedMetricDomain(metrics: MetricDefinition[]): string | undefined {
  const first = metrics[0]?.domain;
  if (!first) return undefined;
  return metrics.every((metric) => metric.domain === first) ? first : undefined;
}

function selectDimensions(
  dimensions: DimensionDefinition[],
  questionPlan: AnalysisQuestionPlan,
  timeDimensionName: string | undefined,
  question = '',
): { dimensions: string[]; unresolved: string[] } {
  const questionWords = new Set(normalizeMetricPhrase(question).split(' '));
  const metricTerms = new Set([
    ...questionPlan.requestedShape.measures,
    ...questionPlan.metricTerms,
  ].map((term) => normalizeSemanticText(term)).filter(Boolean));
  const terms = uniqueStrings(
    questionPlan.outputShape === 'value' && questionPlan.requestedShape.dimensions.length === 0
      ? []
      : [
        ...questionPlan.requestedShape.dimensions,
        ...questionPlan.dimensionTerms,
      ],
  )
    .filter((term) => !isTimeGrainTerm(term))
    .filter((term) => !metricTerms.has(normalizeSemanticText(term)));
  const selected: string[] = [];
  const unresolved: string[] = [];
  for (const term of terms) {
    // Expand the QUERY term with common analytics synonyms + singular/plural so a
    // question saying "product" can resolve a dimension named `sku`/`item`, or
    // "region" a dimension named `geo`/`market`. The dimension's own aliases
    // (name/label/leaf) are added to its searchable text on the other side.
    const tokens = expandDimensionQueryTokens(term);
    const hit = dimensions
      .filter((dimension) => dimension.name !== timeDimensionName)
      .map((dimension) => ({
        dimension,
        score: scoreSemanticText([
          ...semanticDimensionAliases(dimension),
          dimension.description,
          dimension.domain ?? '',
          ...(dimension.tags ?? []),
        ].join(' '), tokens) + semanticDisplayRoleScore(dimension, term),
      }))
      // "new versus returning customers" compares two documented values of
      // `customer_type`; that outranks even the display-name role bonus that
      // `customer_name` earns from the word "customer".
      .map((candidate) => candidate.score > 0
        ? { ...candidate, score: candidate.score + documentedValueComparisonScore(candidate.dimension, questionWords) }
        : candidate)
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.dimension.name.localeCompare(b.dimension.name))[0]?.dimension;
    if (hit && !selected.includes(hit.name)) selected.push(hit.name);
    if (!hit) unresolved.push(term);
  }
  return { dimensions: selected, unresolved };
}

/**
 * Bonus for a dimension whose description documents quoted values ("Options
 * are 'new' or 'returning'") when the question names two or more of them: the
 * question compares that dimension's members.
 */
function documentedValueComparisonScore(dimension: DimensionDefinition, questionWords: Set<string>): number {
  const values = [...(dimension.description ?? '').matchAll(/'([^'\n]{1,40})'|"([^"\n]{1,40})"/g)]
    .map((match) => normalizeMetricPhrase(match[1] ?? match[2] ?? ''))
    .filter((value) => value.length > 0 && !value.includes(' '));
  const named = new Set(values.filter((value) => questionWords.has(value)));
  return named.size >= 2 ? 200 : 0;
}

/**
 * Generic analytics dimension-synonym seed. Each row is a synonym cluster: any
 * term in the cluster expands to all of them for dimension matching. Curated to
 * be domain-neutral (no project-specific values), so it's safe to apply broadly.
 */
const DIMENSION_SYNONYMS: string[][] = [
  ['product', 'item', 'sku', 'article', 'goods'],
  ['region', 'geo', 'geography', 'area', 'market', 'territory', 'zone', 'locale', 'location', 'site'],
  ['country', 'nation'],
  ['state', 'province'],
  ['city', 'metro', 'municipality'],
  ['customer', 'account', 'client', 'buyer', 'shopper', 'user', 'member'],
  ['channel', 'source', 'medium', 'origin'],
  ['category', 'segment', 'class', 'group', 'type', 'kind'],
  ['store', 'shop', 'outlet', 'location', 'branch'],
  ['supplier', 'vendor', 'merchant'],
  ['employee', 'staff', 'agent', 'rep', 'representative'],
  ['department', 'team', 'division', 'unit'],
  ['status', 'state', 'stage'],
];

const SEMANTIC_TERM_SYNONYMS: string[][] = [
  ['beverage', 'drink'],
  ['spend', 'spent', 'spending', 'revenue', 'sales'],
  ['customer', 'client', 'buyer', 'shopper', 'account', 'user'],
  ['product', 'item', 'sku', 'article', 'goods'],
];

const SEMANTIC_TERM_SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const index = new Map<string, Set<string>>();
  for (const cluster of SEMANTIC_TERM_SYNONYMS) {
    for (const word of cluster) index.set(word, new Set(cluster));
  }
  return index;
})();

/**
 * Project vocabulary for the current compose call.
 *
 * `composeSemanticQueryForQuestion` is fully synchronous, so a call-scoped
 * overlay cannot interleave with another question. This keeps the project's
 * words out of six separate helper signatures while leaving the built-in
 * clusters untouched — project terms EXTEND the defaults, never replace them.
 */
let activeProjectSynonyms: Map<string, Set<string>> | undefined;
/** metric name (lowercased) -> phrases this project's terms use for it. */
let activeMetricAliasPhrases: Map<string, string[]> | undefined;

function buildProjectSynonymIndex(clusters: string[][] | undefined): Map<string, Set<string>> | undefined {
  if (!clusters || clusters.length === 0) return undefined;
  const index = new Map<string, Set<string>>();
  for (const cluster of clusters) {
    const words = cluster.map((word) => word.trim().toLowerCase()).filter(Boolean);
    if (words.length < 2) continue;
    for (const word of words) {
      const existing = index.get(word);
      if (existing) for (const other of words) existing.add(other);
      else index.set(word, new Set(words));
    }
  }
  return index.size > 0 ? index : undefined;
}

function buildMetricAliasPhrases(aliases: Record<string, string[]> | undefined): Map<string, string[]> | undefined {
  if (!aliases) return undefined;
  const index = new Map<string, string[]>();
  for (const [phrase, metrics] of Object.entries(aliases)) {
    const trimmed = phrase.trim();
    if (!trimmed) continue;
    for (const metric of metrics) {
      const key = metric.trim().toLowerCase();
      if (!key) continue;
      const current = index.get(key) ?? [];
      // Also key on the leaf name so `cube.metric` refs match a bare metric name.
      if (!current.includes(trimmed)) current.push(trimmed);
      index.set(key, current);
      const leaf = key.split('.').pop();
      if (leaf && leaf !== key) {
        const leafCurrent = index.get(leaf) ?? [];
        if (!leafCurrent.includes(trimmed)) leafCurrent.push(trimmed);
        index.set(leaf, leafCurrent);
      }
    }
  }
  return index.size > 0 ? index : undefined;
}

/** Built-in synonyms for a word, plus anything this project's terms declare. */
function semanticSynonymsFor(word: string): Set<string> {
  const builtin = SEMANTIC_TERM_SYNONYM_INDEX.get(word);
  const project = activeProjectSynonyms?.get(word);
  if (!project) return builtin ?? new Set<string>();
  return new Set([...(builtin ?? []), ...project]);
}

const DIMENSION_SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const index = new Map<string, Set<string>>();
  for (const cluster of DIMENSION_SYNONYMS) {
    const set = new Set(cluster);
    for (const word of cluster) {
      const existing = index.get(word);
      if (existing) for (const w of set) existing.add(w);
      else index.set(word, new Set(set));
    }
  }
  return index;
})();

/** Query-side token expansion: the term's tokens + synonyms + singular/plural. */
function expandDimensionQueryTokens(term: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(term)) {
    out.add(token);
    const singular = token.replace(/ies$/, 'y').replace(/s$/, '');
    if (singular.length > 1) out.add(singular);
    out.add(`${token}s`);
    for (const synonym of DIMENSION_SYNONYM_INDEX.get(token) ?? []) out.add(synonym);
    for (const synonym of DIMENSION_SYNONYM_INDEX.get(singular) ?? []) out.add(synonym);
  }
  return out;
}

/** Tokens already consumed by selected filters or the chosen time dimension. */
function consumedTermTokens(
  filters: SemanticBridgeFilter[],
  timeDimension: { name: string; granularity: string } | undefined,
): Set<string> {
  const consumed = new Set<string>();
  for (const filter of filters) {
    for (const token of tokenize(filter.dimension)) consumed.add(token);
    for (const value of filter.values) for (const token of tokenize(value)) consumed.add(token);
  }
  if (timeDimension) {
    for (const token of tokenize(timeDimension.name)) consumed.add(token);
    for (const token of tokenize(timeDimension.granularity)) consumed.add(token);
    for (const grain of ['day', 'date', 'week', 'month', 'quarter', 'year', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'annual']) {
      consumed.add(grain);
    }
  }
  return consumed;
}

function selectFilters(
  dimensions: DimensionDefinition[],
  selectedDimensions: string[],
  question: string,
  questionPlan: AnalysisQuestionPlan,
  timeDimensionName: string | undefined,
  filterValueColumns: ((value: string) => string[]) | undefined,
  filterValueBindings: ((value: string) => SemanticFilterValueBinding[]) | undefined,
): SemanticBridgeFilter[] {
  const available = dimensions.filter((dimension) => dimension.name !== timeDimensionName);
  const selected = new Map<string, SemanticBridgeFilter>();
  for (const candidate of extractInlineFilterCandidates(question, available)) {
    selected.set(candidate.dimension, {
      dimension: candidate.dimension,
      operator: 'equals',
      values: uniqueStrings([...(selected.get(candidate.dimension)?.values ?? []), candidate.value]),
    });
  }

  for (const raw of questionPlan.requestedShape.filters) {
    const value = cleanFilterValue(raw);
    if (!value || [...selected.values()].some((filter) => filter.values.some((existing) => sameFilterValue(existing, value)))) {
      continue;
    }
    const resolved = selectFilterDimension(
      value,
      available,
      selectedDimensions,
      filterValueColumns,
      filterValueBindings,
    );
    if (!resolved) continue;
    selected.set(resolved.dimension.name, {
      dimension: resolved.dimension.name,
      operator: 'equals',
      values: uniqueStrings([...(selected.get(resolved.dimension.name)?.values ?? []), resolved.canonicalValue]),
    });
  }

  return [...selected.values()]
    .filter((filter) => filter.values.length > 0)
    .sort((a, b) => a.dimension.localeCompare(b.dimension));
}

function extractInlineFilterCandidates(
  question: string,
  dimensions: DimensionDefinition[],
): Array<{ dimension: string; value: string }> {
  const candidates: Array<{ dimension: string; value: string }> = [];
  for (const dimension of dimensions) {
    for (const alias of semanticDimensionAliases(dimension)) {
      const aliasPattern = alias.split(/\s+/).map(escapeRegExp).join('\\s+');
      const valueBeforeDimension = new RegExp(
        `\\b(?:for|where|only|with|in)\\s+([A-Za-z0-9&.'_-]+(?:\\s+[A-Za-z0-9&.'_-]+){0,3})\\s+${aliasPattern}\\b`,
        'gi',
      );
      for (const match of question.matchAll(valueBeforeDimension)) {
        const value = cleanFilterValue(match[1]);
        if (value) candidates.push({ dimension: dimension.name, value });
      }

      const dimensionBeforeValue = new RegExp(
        `\\b${aliasPattern}\\s*(?:=|:|is|equals|of)\\s+["']?([A-Za-z0-9&.'_-]+(?:\\s+[A-Za-z0-9&.'_-]+){0,3})["']?`,
        'gi',
      );
      for (const match of question.matchAll(dimensionBeforeValue)) {
        const value = cleanFilterValue(match[1]);
        if (value) candidates.push({ dimension: dimension.name, value });
      }
    }
  }
  return candidates;
}

function selectFilterDimension(
  value: string,
  dimensions: DimensionDefinition[],
  selectedDimensions: string[],
  filterValueColumns: ((value: string) => string[]) | undefined,
  filterValueBindings: ((value: string) => SemanticFilterValueBinding[]) | undefined,
): { dimension: DimensionDefinition; canonicalValue: string } | undefined {
  const selectedSet = new Set(selectedDimensions);

  const bindings = filterValueBindings?.(value) ?? [];
  for (const binding of bindings) {
    const normalizedColumn = normalizeColumnToken(binding.column);
    const matched = dimensions.find((dimension) =>
      dimensionColumnTokens(dimension).includes(normalizedColumn),
    );
    if (matched) return { dimension: matched, canonicalValue: binding.canonicalValue };
  }

  // Bind the literal to the dimension that actually carries it: ask the value
  // index which physical column(s) sampled this value, then match a dimension
  // whose expression/name references one of those columns. This is generic —
  // driven by real warehouse values, not a hard-coded value→dimension table.
  const valueColumns = filterValueColumns?.(value) ?? [];
  if (valueColumns.length > 0) {
    const normalizedColumns = new Set(valueColumns.map((column) => normalizeColumnToken(column)));
    const matched = dimensions.find((dimension) =>
      dimensionColumnTokens(dimension).some((token) => normalizedColumns.has(token)),
    );
    if (matched) return { dimension: matched, canonicalValue: value };
  }

  // Never bind an unresolved literal to the only selected grouping dimension.
  // "beverage by customer" previously became customer_name = 'beverage'. A
  // literal needs value-index evidence (above) or explicit dimension grammar
  // (handled by extractInlineFilterCandidates); otherwise it stays unresolved.
  void selectedSet;
  return undefined;
}

/**
 * Resolve generic entity words to their display member rather than whichever
 * equally-token-matched dimension sorts first. `product` should select
 * `product_name`, not `product_description`; explicit semantic labels still win.
 */
function semanticDisplayRoleScore(dimension: DimensionDefinition, rawTerm: string): number {
  const term = normalizeSemanticText(rawTerm).replace(/\s+/g, '_');
  if (!term) return 0;
  const name = normalizeSemanticText(dimension.name).replace(/\s+/g, '_');
  const label = normalizeSemanticText(dimension.label).replace(/\s+/g, '_');
  const leaf = normalizeSemanticText(leafName(dimension.name)).replace(/\s+/g, '_');
  let score = 0;
  if (name === `${term}_name` || leaf === `${term}_name`) score += 80;
  if (label === term || label === `${term}_name`) score += 55;
  if (name === term || leaf === term) score += 40;
  if (name.endsWith('_name') && (name.includes(term) || term.includes(name.replace(/_name$/, '')))) score += 30;
  if (/(_description|_detail|_text|_notes?)$/.test(name)) score -= 25;
  if (/(_id|_key|_uuid|_code)$/.test(name)) score -= 15;
  return score;
}

/** Physical column tokens a dimension might reference (leaf of name/expr/sql). */
function dimensionColumnTokens(dimension: DimensionDefinition): string[] {
  return uniqueStrings([
    dimension.name,
    leafName(dimension.name),
    dimension.expr,
    dimension.sql,
  ].filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(/[^A-Za-z0-9_]+/))
    .map((token) => normalizeColumnToken(token))
    .filter((token) => token.length > 1 && !SEMANTIC_STOPWORDS.has(token)));
}

function normalizeColumnToken(value: string): string {
  return value.replace(/["'`]/g, '').trim().toLowerCase();
}

function semanticDimensionAliases(dimension: DimensionDefinition): string[] {
  return uniqueStrings([
    dimension.name,
    dimension.label,
    leafName(dimension.name),
    dimension.name.replace(/[_-]+/g, ' '),
    dimension.label?.replace(/[_-]+/g, ' '),
  ].filter((value): value is string => Boolean(value?.trim()))
    .map((value) => normalizeSemanticText(value))
    .filter((value) => value.length > 1 && !SEMANTIC_STOPWORDS.has(value)));
}

function selectTimeDimension(
  layer: SemanticLayer,
  question: string,
  questionPlan: AnalysisQuestionPlan,
  primaryMetric?: MetricDefinition,
): { name: string; granularity: string } | undefined {
  const granularity = inferTimeGranularity(question, questionPlan);
  if (!granularity) return undefined;
  const timeDimensions = layer.listTimeDimensions();
  if (timeDimensions.length === 0) return undefined;
  const timeTerms = new Set([...questionPlan.timeTerms, ...questionPlan.dimensionTerms].flatMap(tokenize));
  const hit = timeDimensions
    .map((dimension) => ({
      dimension,
      score: scoreSemanticText([
        dimension.name,
        dimension.label,
        dimension.description,
        dimension.domain ?? '',
        ...(dimension.tags ?? []),
      ].join(' '), timeTerms),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.dimension.name.localeCompare(b.dimension.name))[0]?.dimension
    ?? (timeDimensions.length === 1 ? timeDimensions[0] : undefined);
  if (hit) return { name: hit.name, granularity };
  // "each month" names a grain, not a time column. MetricFlow reads such a
  // grain on the metric's own agg_time_dimension (metric_time); dropping it
  // instead returned one all-time total for a per-month question.
  const aggTime = metricAggTimeDimension(layer, primaryMetric);
  return aggTime ? { name: aggTime, granularity } : undefined;
}

/**
 * The metric's agg_time_dimension: declared on the metric, on its semantic
 * model's defaults, or, for a ratio or derived metric, on its first input.
 */
function metricAggTimeDimension(layer: SemanticLayer, metric: MetricDefinition | undefined, depth = 0): string | undefined {
  if (!metric || depth > 2) return undefined;
  const declared = (metric as { aggTimeDimension?: unknown }).aggTimeDimension;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  if (typeof layer.listSemanticModels === 'function') {
    const modelNames = new Set([metric.cube, ...(metric.semanticModelIds ?? [])].filter((name): name is string => Boolean(name)));
    for (const model of layer.listSemanticModels()) {
      if (!modelNames.has(model.name)) continue;
      const aggTime = (model.defaults as { agg_time_dimension?: unknown } | undefined)?.agg_time_dimension;
      if (typeof aggTime === 'string' && aggTime.trim()) return aggTime.trim();
    }
  }
  const typeParams = (metric.typeParams ?? {}) as Record<string, unknown>;
  const inputName = (value: unknown): string | undefined => typeof value === 'string'
    ? value
    : value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string'
      ? (value as { name: string }).name
      : undefined;
  const inputs = [typeParams.numerator, typeParams.denominator, ...(Array.isArray(typeParams.metrics) ? typeParams.metrics : [])]
    .map(inputName)
    .filter((name): name is string => Boolean(name));
  for (const name of inputs) {
    const input = layer.listMetrics().find((candidate) => candidate.name === name);
    const aggTime = metricAggTimeDimension(layer, input, depth + 1);
    if (aggTime) return aggTime;
  }
  return undefined;
}

const DATE_RANGE_WORDS = /\b(?:since|between|before|after|until|from)\s+(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|(?:19|20)\d{2}\b|\d{1,2}[/-]\d{1,2})/i;

function hasUnappliedDateRestriction(question: string, questionPlan: AnalysisQuestionPlan): boolean {
  return questionPlan.timeTerms.some((term) => /^(?:19|20)\d{2}$/.test(term.trim()))
    || /\b(?:in|during|for)\s+(?:(?:fy|q[1-4])\s*)?(?:19|20)\d{2}\b/i.test(question)
    || DATE_RANGE_WORDS.test(question);
}

function inferTimeGranularity(question: string, questionPlan: AnalysisQuestionPlan): string | undefined {
  const text = `${question} ${questionPlan.timeTerms.join(' ')} ${questionPlan.dimensionTerms.join(' ')}`.toLowerCase();
  if (/\b(daily|day|date)\b/.test(text)) return 'day';
  if (/\b(weekly|week)\b/.test(text)) return 'week';
  if (/\b(monthly|month)\b/.test(text)) return 'month';
  if (/\b(quarterly|quarter|q[1-4])\b/.test(text)) return 'quarter';
  if (/\b(yearly|annual|year)\b/.test(text)) return 'year';
  return undefined;
}

export function renderSemanticDqlArtifact(input: SemanticDqlArtifactInput): string {
  const runtimeContract = semanticArtifactRuntimeContract({ filters: input.filters, limit: input.limit });
  return renderSemanticBlockSource({
    name: input.name ?? titleFromQuestion(input.question, input.titleFallback ?? input.metrics[0] ?? 'semantic_query'),
    status: 'draft',
    domain: input.domain,
    description: input.question,
    metrics: input.metrics,
    dimensions: input.dimensions,
    timeDimension: input.timeDimension,
    requestedFilters: input.filters.flatMap(filterToRequestedFilterStrings),
    orderBy: input.orderBy,
    limit: input.limit,
    parameters: runtimeContract.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      default: parameter.default,
      policy: parameter.policy,
      binding: parameter.binding?.kind === 'semantic_filter'
        ? parameter.binding.field
        : parameter.binding?.kind === 'limit'
          ? 'limit'
          : undefined,
    })),
  });
}

function semanticArtifactRuntimeContract(input: {
  filters: SemanticBridgeFilter[];
  limit?: number;
}): { parameters: BlockParameterDefinition[]; values: Record<string, unknown> } {
  const parameters: BlockParameterDefinition[] = [];
  const values: Record<string, unknown> = {};
  const used = new Set<string>();
  const uniqueName = (preferred: string, fallback: string): string => {
    const base = preferred.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}_${suffix++}`;
    used.add(name);
    return name;
  };
  for (const [index, filter] of input.filters.entries()) {
    if (filter.values.length === 0) continue;
    const name = uniqueName(leafName(filter.dimension), `filter_${index + 1}`);
    const multiple = filter.values.length > 1;
    const value = multiple ? [...filter.values] : filter.values[0];
    parameters.push({
      name,
      type: multiple ? 'string[]' : 'string',
      required: false,
      default: value,
      policy: 'dynamic',
      binding: {
        kind: 'semantic_filter',
        field: filter.dimension,
        operator: multiple || filter.operator === 'in' ? 'in' : 'equals',
      },
    });
    values[name] = value;
  }
  if (typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0) {
    const value = Math.floor(input.limit);
    const name = uniqueName('top_n', 'top_n');
    parameters.push({ name, type: 'number', required: false, default: value, policy: 'dynamic', binding: { kind: 'limit' } });
    values[name] = value;
  }
  return { parameters, values };
}

export function semanticDqlArtifactName(input: SemanticDqlArtifactInput): string {
  const metricPart = input.metrics.length === 1
    ? leafName(input.metrics[0] ?? 'semantic_metric').replace(/^total[_-]+/i, '')
    : 'semantic_metrics';
  const grainPart = input.timeDimension ? grainName(input.timeDimension.granularity) : undefined;
  const dimensionPart = input.dimensions.length > 0
    ? ['by', ...input.dimensions.map((dimension) => leafName(dimension))]
    : [];
  const filterPart = input.filters.length > 0
    ? ['for', ...input.filters.flatMap((filter) => [leafName(filter.dimension), ...filter.values.slice(0, 2)])]
    : [];
  const raw = [
    grainPart,
    metricPart,
    ...dimensionPart,
    ...filterPart,
  ].filter((part): part is string => Boolean(part?.trim())).join(' ');
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 80)
    .replace(/_+$/g, '');
  return slug || 'semantic_query';
}

function grainName(granularity: string): string {
  switch (granularity.toLowerCase()) {
    case 'day':
      return 'daily';
    case 'week':
      return 'weekly';
    case 'month':
      return 'monthly';
    case 'quarter':
      return 'quarterly';
    case 'year':
      return 'yearly';
    default:
      return granularity;
  }
}

function filterToRequestedFilterStrings(filter: SemanticBridgeFilter): string[] {
  return filter.values.map((value) =>
    filter.operator === 'equals'
      ? `${filter.dimension}=${value}`
      : `${filter.dimension} ${filter.operator} ${value}`
  );
}

function semanticNameMatches(metric: MetricDefinition, raw: string): boolean {
  const target = normalizeSemanticName(raw);
  return normalizeSemanticName(metric.name) === target
    || normalizeSemanticName(`${metric.cube ?? ''}.${metric.name}`) === target
    || normalizeSemanticName(metric.label) === target;
}

function scoreSemanticText(text: string, terms: Set<string>): number {
  if (terms.size === 0) return 0;
  const haystack = new Set(tokenize(text));
  let score = 0;
  for (const term of terms) {
    if (haystack.has(term)) score += 3;
    else if ([...haystack].some((token) => token.includes(term) || term.includes(token))) score += 1;
  }
  return score;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !SEMANTIC_STOPWORDS.has(token));
}

function normalizeSemanticName(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

function normalizeSemanticText(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function leafName(value: string): string {
  return value.split('.').pop() ?? value;
}

function isTimeGrainTerm(term: string): boolean {
  return /\b(day|date|week|month|quarter|year|daily|weekly|monthly|quarterly|yearly|annual)\b/i.test(term);
}

function titleFromQuestion(question: string, fallback: string): string {
  const clean = question.replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length <= 80 ? clean : `${clean.slice(0, 77)}...`;
}

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cleanFilterValue(value: string | undefined): string {
  return (value ?? '')
    .replace(/^["']|["']$/g, '')
    .replace(/\b(?:channel|category|segment|region|market|product|customer|account|user|team|type)\b$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameFilterValue(left: string, right: string): boolean {
  return normalizeSemanticText(left) === normalizeSemanticText(right);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

const SEMANTIC_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'by', 'for', 'from', 'with', 'show', 'give',
  'me', 'what', 'is', 'are', 'our', 'total', 'all', 'per', 'each',
]);

const GENERIC_METRIC_CONCEPTS = new Set([
  'amount',
  'average',
  'avg',
  'count',
  'kpi',
  'metric',
  'number',
  'sum',
  'total',
  'value',
]);
