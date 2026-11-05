/**
 * Semantic-metric matching (spec 17, part C).
 *
 * The answer-loop already has a `semantic_layer` tier in its route order
 * (certified → business_context → semantic_layer → dbt_manifest → generated →
 * refuse). The miss it fixes here: matching a clear metric question to a governed
 * metric was purely string-based (FTS token overlap), so "what is our total
 * revenue" did not connect to a revenue-family metric like `cumulative_revenue`,
 * `food_revenue`, or `lifetime_spend` — no metric is literally named "revenue" —
 * and the loop refused instead of routing to the semantic tier.
 *
 * `matchSemanticMetric` ranks candidate metric KG nodes against the question
 * using:
 *   - a synonym/family expansion of the question's measure terms (revenue ⇄
 *     spend/sales/income/arr; orders ⇄ purchases; ...), and of each metric's
 *     searchable text (name + synonyms + label + description + tags),
 *   - lexical token overlap blended through the spec-11 `hybridRank`
 *     (small non-zero alpha by default when lexical signal exists),
 *   - a strong boost when a measure FAMILY (e.g. "revenue") is shared between
 *     the question and the metric, which is what makes "total revenue" reach the
 *     revenue family even though the exact word never appears in a metric name.
 *
 * It returns the single best metric only when the score clears a confidence
 * threshold, so genuinely ad-hoc questions ("median order value by region")
 * still fall through to generated SQL, and questions with no measure at all
 * still refuse honestly.
 */

import { defaultEmbeddingProvider, hybridRank, type EmbeddingProvider } from '../embeddings/provider.js';
import type { KGNode } from '../kg/types.js';
import type { SemanticLayer } from '@zlens/core';
import { tableName } from '@zlens/core';

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/** Stopwords that should never count toward a measure/metric match. */
const STOPWORDS = new Set([
  'what', 'whats', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'our', 'my', 'we',
  'of', 'for', 'in', 'on', 'to', 'by', 'and', 'or', 'show', 'me', 'give', 'tell',
  'how', 'much', 'many', 'this', 'that', 'these', 'those', 'do', 'does', 'did',
  'total', 'overall', 'current', 'all', 'per', 'each', 'value', 'amount', 'number',
  'count', 'sum', 'average', 'avg', 'get', 'find', 'whole', 'entire',
]);

/**
 * Seed measure synonym families. Each family maps a canonical measure to the set
 * of words that signal it. A question and a metric "share a family" when any word
 * from the question and any word from the metric resolve to the same family.
 *
 * This hardcoded list only SEEDS common cross-vocabulary synonyms (revenue⇄sales,
 * customer⇄user). The real family set is built PER PROJECT from the actual metric
 * pool by {@link buildMeasureFamilies}, so a project's own measure vocabulary —
 * `tax`, `discount`, `shipping`, `freight`, whatever this warehouse names its
 * measures — self-registers as a family without ever touching this file. The old
 * behavior (fixed 9-family list) silently dropped every measure not in the list:
 * "region tax by product" scored `familyBoost = 0` and fell below threshold even
 * though a `tax_amount` metric existed.
 */
const SEED_MEASURE_FAMILIES: Record<string, string[]> = {
  revenue: ['revenue', 'revenues', 'sales', 'income', 'turnover', 'earnings', 'gmv', 'arr', 'mrr', 'bookings', 'topline'],
  spend: ['spend', 'spending', 'spent', 'cost', 'costs', 'expense', 'expenses', 'cogs'],
  profit: ['profit', 'profits', 'margin', 'margins', 'gross', 'net', 'ebitda'],
  orders: ['order', 'orders', 'purchase', 'purchases', 'transaction', 'transactions', 'checkout', 'checkouts'],
  customers: ['customer', 'customers', 'user', 'users', 'account', 'accounts', 'buyer', 'buyers', 'shopper', 'shoppers'],
  churn: ['churn', 'churned', 'attrition', 'cancel', 'cancellation', 'cancellations', 'logo'],
  retention: ['retention', 'retained', 'renewal', 'renewals'],
  quantity: ['quantity', 'units', 'volume', 'qty'],
  aov: ['aov', 'basket'],
};

/**
 * Backward-compatible alias: the seed families are the default family map used by
 * helpers that don't have a project metric pool in scope (e.g. the fallback
 * `buildGovernedMetricFirstSql` gate). Question↔metric matching in
 * `matchSemanticMetric` uses a project-derived map instead.
 */
const MEASURE_FAMILIES = SEED_MEASURE_FAMILIES;

/** A word that is too generic to be a distinctive per-project family on its own. */
const GENERIC_FAMILY_TOKENS = new Set([
  'amount', 'total', 'value', 'count', 'sum', 'avg', 'average', 'number', 'num',
  'rate', 'ratio', 'pct', 'percent', 'percentage', 'metric', 'measure', 'kpi',
  'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'annual', 'ytd', 'mtd',
]);

/**
 * Build the measure-family map for a specific project by merging the seed
 * synonyms with a family for each distinctive token in the metric pool's names.
 * A metric named `tax_amount` contributes the `tax` family; `avg_discount_rate`
 * contributes `discount`. Generic tokens (`amount`, `rate`, `total`) never become
 * families — they'd match everything. Seed families win when a token already
 * belongs to one (so `sales` stays in `revenue`, not its own family).
 */
export function buildMeasureFamilies(metrics: KGNode[]): Record<string, string[]> {
  const families: Record<string, string[]> = {};
  for (const [family, words] of Object.entries(SEED_MEASURE_FAMILIES)) families[family] = [...words];
  const seeded = new Set(Object.values(SEED_MEASURE_FAMILIES).flat());
  for (const metric of metrics) {
    if (metric.kind !== 'metric') continue;
    // Only the metric NAME/label defines what it MEASURES — not its backing table
    // (see metricFamilyText). Tokenize the same way so `avg_tax_rate` → tax.
    for (const token of tokenize(metricFamilyText(metric))) {
      if (token.length < 3) continue;
      if (seeded.has(token) || GENERIC_FAMILY_TOKENS.has(token) || STOPWORDS.has(token)) continue;
      (families[token] ??= [token]);
    }
  }
  return families;
}

/**
 * Row/record-listing intent. A question asking to ENUMERATE rows or identifiers
 * ("list the 5 most recent orders with their ids") is not a metric question even
 * though it names a measure entity ("orders") — it wants raw rows, so it should
 * fall through to grounded generated SQL, not a governed aggregate. Conservative:
 * only the clearest listing signals, so true aggregate questions ("how many
 * orders", "total revenue", "average order value") are never suppressed.
 */
const ROW_REQUEST_RE = /\b(list|listing|rows?|records?|individual|line[\s-]?items?|ids?)\b/i;
const RECENCY_RE = /\b(most\s+recent|latest|newest|oldest|last\s+\d+)\b/i;

function looksLikeRowRequest(question: string): boolean {
  return ROW_REQUEST_RE.test(question) || RECENCY_RE.test(question);
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/** Content tokens (stopwords stripped) used for measure/family signal. */
function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

/** The measure families a set of words resolves to (against a given family map). */
function familiesFor(words: Iterable<string>, familyMap: Record<string, string[]> = MEASURE_FAMILIES): Set<string> {
  const set = new Set<string>(words);
  const families = new Set<string>();
  for (const [family, members] of Object.entries(familyMap)) {
    if (members.some((member) => set.has(member))) families.add(family);
  }
  return families;
}

function buildFamilyLookup(familyMap: Record<string, string[]>): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  for (const [family, members] of Object.entries(familyMap)) {
    for (const member of members) {
      const current = lookup.get(member) ?? [];
      if (!current.includes(family)) current.push(family);
      lookup.set(member, current);
    }
  }
  return lookup;
}

function familiesForWithLookup(words: Iterable<string>, lookup: Map<string, string[]>): Set<string> {
  const result = new Set<string>();
  for (const word of words) for (const family of lookup.get(word) ?? []) result.add(family);
  return result;
}

/** Searchable text for a metric KG node: name, synonyms, label, description, tags. */
function metricSearchText(metric: KGNode): string {
  return [
    metric.name,
    metric.name.replace(/[_.]+/g, ' '),
    metric.description ?? '',
    metric.llmContext ?? '',
    ...(metric.tags ?? []),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Text used ONLY for measure-FAMILY detection: the metric's name + explicit
 * tags, but NOT its free-form description or `llmContext`. Those fields carry
 * business prose and `table:`/`sql:` lines, so
 * including it wrongly assigns a metric to the family of its backing TABLE (a
 * `tax_paid` measure on the `orders` table would falsely read as the "orders"
 * family). Family must reflect what the metric MEASURES, i.e. its name/label.
 */
function metricFamilyText(metric: KGNode): string {
  return [metric.name, metric.name.replace(/[_.]+/g, ' '), ...(metric.tags ?? [])]
    .filter(Boolean)
    .join(' ');
}

/** The measure families a metric KG node resolves to (revenue, orders, ...). */
export function metricFamilies(metric: KGNode): Set<string> {
  return familiesFor(contentTokens(metricFamilyText(metric)));
}

export interface MetricMatch {
  metric: KGNode;
  /** Blended relevance in [0, 1]. */
  score: number;
  /** The shared measure family that justified the match, if any. */
  family?: string;
  /** Why this candidate was safe to advance into semantic compilation. */
  basis?: 'name' | 'family' | 'description' | 'embedding';
}

export interface MatchSemanticMetricOptions {
  /**
   * Confidence threshold. A match below this is treated as "no confident metric"
   * so ad-hoc questions still fall through to generated SQL. Default 0.3.
   */
  threshold?: number;
  /**
   * Executability signal (composable natively OR a full semantic runtime is
   * active). Non-executable metrics are DEMOTED (x0.6) rather than excluded:
   * an acronym-sibling that ZLens can actually run should win a lexical tie, but
   * a strong direct match on a runtime-only metric still surfaces so the
   * honest "requires a semantic runtime" path can explain itself instead of a
   * lookalike silently answering with the wrong number.
   */
  canExecute?: (metricName: string) => boolean;
  /** Vector-similarity weight; defaults to a small conservative blend. */
  alpha?: number;
  provider?: EmbeddingProvider;
  /**
   * The planner's isolated MEASURE terms for the question (from
   * `requestedShape.measures` / `metricTerms`). When supplied, the measure/family
   * signal is scored against these instead of every content word in the question,
   * so a group-by dimension ("... by product") can't be mistaken for a measure and
   * pull in a dimension-named metric like `product_count`. Falls back to all
   * content tokens when empty, preserving the old behavior for bare callers.
   */
  measureTerms?: string[];
  /**
   * Ordered metric identities returned by the immutable snapshot's vector lane.
   * This is a retrieval shortlist, not a model guess: callers supply only IDs
   * from their already-frozen catalog snapshot.  Names are accepted for legacy
   * KG callers that do not expose a stable node id.
   */
  vectorMetricShortlist?: readonly string[];
}

export const DEFAULT_METRIC_MATCH_EMBEDDING_ALPHA = 0.18;
/** Vector-only metric grounding must clear this similarity floor. */
export const VECTOR_ONLY_METRIC_SCORE_FLOOR = 0.86;
/** Vector-only leader must exceed the runner-up by this separation margin. */
export const VECTOR_ONLY_METRIC_SEPARATION_MARGIN = 0.06;

/** Hybrid ranking stays bounded even for enterprise catalogs. */
const MAX_HYBRID_METRIC_CANDIDATES = 96;
/**
 * Reserve a quarter of the bounded window for the caller's snapshot vector
 * lane.  Without this, 96 weak lexical candidates can starve a strongly
 * ranked vector target before embeddings are even evaluated.
 */
const VECTOR_SHORTLIST_RESERVED_CANDIDATES = 24;

/**
 * Embedding weight once a REAL (project-configured) embedder is supplied.
 *
 * The 0.18 default is calibrated for the offline hashed-token provider, whose
 * "similarity" is token-hash overlap — barely better than the lexical score it
 * is blended with, so it must stay a light tie-breaker. A real embedder carries
 * actual meaning (acronym ⇄ expansion, synonym ⇄ synonym), which is exactly the
 * signal the lexical pass cannot produce, so it earns a much larger share.
 */
export const REAL_PROVIDER_METRIC_MATCH_ALPHA = 0.4;

/** True when `provider` produces real semantic vectors rather than token hashes. */
export function isRealEmbeddingProvider(provider: EmbeddingProvider | undefined): provider is EmbeddingProvider {
  return Boolean(provider) && !provider!.id.includes('hashed-token');
}

/**
 * Match options for a host that has resolved the project's embedder.
 *
 * Returns `{}` for a missing or hashed provider so the offline default is
 * preserved exactly — matching stays deterministic for tests, CI, and projects
 * that never configured `ai.embeddings`, and no metric definition is sent
 * anywhere the project did not opt into.
 */
export function semanticMetricEmbeddingOptions(
  provider: EmbeddingProvider | undefined,
): Pick<MatchSemanticMetricOptions, 'provider' | 'alpha'> {
  if (!isRealEmbeddingProvider(provider)) return {};
  return { provider, alpha: REAL_PROVIDER_METRIC_MATCH_ALPHA };
}

/**
 * Pick the single best governed metric for a question, or `null` when no metric
 * clears the confidence bar. Deterministic + offline by default because the
 * default provider is the hashed-token embedding.
 *
 * Scoring per candidate metric:
 *   base   = lexical token overlap fraction (question content tokens present in
 *            the metric's searchable text), in [0, 1]
 *   family = +0.6 when the question and metric share a measure family
 *   name   = +0.25 when a question content token appears in the metric NAME
 *            (so "food revenue" prefers `food_revenue` over `drink_revenue`)
 * The blended FTS score is fed to `hybridRank` so spec-11 embeddings can refine
 * it when a provider/alpha is supplied.
 */
export async function matchSemanticMetric(
  question: string,
  metrics: KGNode[],
  options: MatchSemanticMetricOptions = {},
): Promise<MetricMatch | null> {
  const candidates = metrics.filter((m) => m.kind === 'metric');
  if (candidates.length === 0) return null;

  // A row/record-listing question wants raw rows, not a governed aggregate —
  // let it fall through to grounded generated SQL even if it names a measure.
  if (looksLikeRowRequest(question)) return null;

  // Lowered from 0.34: a project-derived family match (buildMeasureFamilies) now
  // lifts in-vocabulary measures like `tax`/`discount` that the old fixed list
  // dropped, and the name/family guard below keeps precision (a bare
  // description-only overlap with no name hit and no family never wins).
  const threshold = options.threshold ?? 0.3;
  // Build the family map from THIS project's metric pool so the warehouse's own
  // measure vocabulary self-registers as families (see buildMeasureFamilies).
  const familyMap = buildMeasureFamilies(candidates);
  const familyLookup = buildFamilyLookup(familyMap);
  // Score the measure signal against the planner's isolated measure terms when
  // available; otherwise fall back to all content tokens (bare callers). This is
  // what keeps "region tax by product" scoring `tax_amount`, not `product_count`.
  const measureSignal = (options.measureTerms ?? [])
    .flatMap((term) => contentTokens(term));
  const qContent = new Set(measureSignal.length > 0 ? measureSignal : contentTokens(question));
  if (qContent.size === 0) return null;
  const qFamilies = familiesForWithLookup(qContent, familyLookup);

  // A measure question must carry at least one content word OR a measure family;
  // a bare "what is this" carries neither and should not match a metric.
  const items = candidates.map((metric) => {
    const text = metricSearchText(metric).toLowerCase();
    // Normalize underscores/dots the SAME way metricSearchText (:99) and
    // metricFamilyText (:116) already do, so an underscored metric name — the
    // standard dbt/MetricFlow convention, e.g. `avg_tax_rate` — tokenizes to
    // {avg, tax, rate} and can actually earn the name-match boost below. Without
    // this, `tokenize('avg_tax_rate')` stays one glued token and the boost never
    // fires for the most common naming style (the docstring's own example).
    // Match singular and plural as the same word. "how many orders" reduces to
    // the measure term "order", while the metric is named `orders` — a bare
    // token comparison scored zero on the name, so a plain count question lost
    // to `order_total` (a sum of money) purely on word form.
    const nameTokens = new Set<string>();
    for (const token of tokenize(metric.name.replace(/[_.]+/g, ' '))) {
      nameTokens.add(token);
      const singular = token.replace(/ies$/, 'y').replace(/s$/, '');
      if (singular.length > 1) nameTokens.add(singular);
      nameTokens.add(`${token}s`);
    }
    // Family is derived from the metric's name/label only (not its `table:`), so a
    // measure is never mis-assigned to the family of the relation it sits on.
    const metricFams = familiesForWithLookup(contentTokens(metricFamilyText(metric)), familyLookup);

    let overlap = 0;
    let nameHit = 0;
    for (const token of qContent) {
      if (text.includes(token)) overlap += 1;
      if (nameTokens.has(token)) nameHit += 1;
    }
    const lexical = overlap / qContent.size;
    // Fraction of question content tokens present in the metric NAME — this is
    // what separates `food_revenue` from `cumulative_revenue` for "food revenue".
    const nameFraction = nameHit / qContent.size;

    let sharedFamily: string | undefined;
    for (const family of qFamilies) {
      if (metricFams.has(family)) {
        sharedFamily = family;
        break;
      }
    }

    // Blend the signals on a fixed budget so no single component saturates the
    // clamp and hides a more specific name match.
    const familyBoost = sharedFamily ? 0.45 : 0;
    const fts = clamp01(0.35 * lexical + familyBoost + 0.35 * nameFraction);
    // Precision guard: a candidate is only a genuine metric hit when the question
    // touches the metric's NAME or shares a measure family — a pure description
    // overlap (e.g. the word "monthly" appearing in a metric's prose) is not.
    const descriptionTokens = new Set(contentTokens(metric.description ?? ''));
    let descriptionHits = 0;
    for (const token of qContent) if (descriptionTokens.has(token)) descriptionHits += 1;
    // Descriptions/examples are a recall source, not an automatic answer. Require
    // at least two distinctive measure tokens before they can advance a metric to
    // compiler validation; a single generic prose word remains insufficient.
    //
    // But the count rule is unsatisfiable for a ONE-token question, which is the
    // shape a domain acronym always takes. "BCM" against a metric named
    // `billed_consumption_monthly` and described "Billed consumption (BCM)…"
    // scored 0 on name and family, needed two hits it could never have, and came
    // back null — the metric was unreachable by the term people actually use.
    //
    // The real concern behind the rule is GENERICNESS, not count: "monthly"
    // appearing in prose proves nothing. So a lone token grounds only when it is
    // distinctive — not a stopword, not a generic measure word, and long enough
    // to be a real term rather than an initial.
    const distinctiveDescriptionHit = qContent.size === 1
      && [...qContent].some((token) =>
        descriptionTokens.has(token)
        && token.length >= 3
        && !GENERIC_FAMILY_TOKENS.has(token)
        && !STOPWORDS.has(token));
    const descriptionGrounded = (qContent.size >= 2
      && descriptionHits >= 2
      && descriptionHits / qContent.size >= 0.6)
      || distinctiveDescriptionHit;
    const grounded = nameHit > 0 || Boolean(sharedFamily) || descriptionGrounded;
    const basis = nameHit > 0
      ? 'name' as const
      : sharedFamily
        ? 'family' as const
        : descriptionGrounded
          ? 'description' as const
          : undefined;
    return { metric, text: metricSearchText(metric), ftsScore: fts, family: sharedFamily, grounded, basis };
  });

  // Never embed an entire enterprise metric catalog. The deterministic pass
  // above examines every metric for correctness, then hands only the strongest
  // grounded candidates to the expensive hybrid ranker. This removes the old
  // 400-row correctness cap without replacing it with a 7,000-vector latency
  // cliff.
  // Executability is a TIE-BREAKER, never an intent override. When the
  // best-matched metric is runtime-only and an executable sibling scores
  // within ~15%, prefer the executable one (an acronym-tie should pick the
  // metric ZLens can actually run). But when the runtime-only metric is the
  // CLEAR match — "consumption % by customer" wanting a ratio metric — it
  // must win and flow to the honest requires-runtime path; demoting it would
  // silently answer with the WRONG metric, which is worse than any refusal.
  const executabilityAdjusted = (() => {
    if (!options.canExecute) return items;
    const canExecute = options.canExecute;
    const byScore = [...items].sort((left, right) => right.ftsScore - left.ftsScore || left.metric.name.localeCompare(right.metric.name));
    const top = byScore[0];
    if (!top || canExecute(top.metric.name)) return items;
    const executableRival = byScore.find((entry) => entry !== top && canExecute(entry.metric.name) && entry.ftsScore >= top.ftsScore * 0.85);
    if (!executableRival) return items;
    // Near-tie: nudge the executable rival ahead of the runtime-only leader.
    return items.map((entry) => entry === executableRival
      ? { ...entry, ftsScore: Math.max(entry.ftsScore, top.ftsScore * 1.01) }
      : entry);
  })();
  // P1.1 — ADMIT A BOUNDED VECTOR SHORTLIST.
  //
  // This filter used to be `grounded || ftsScore > 0`, which removed every
  // zero-lexical-overlap candidate BEFORE embeddings ran. That is backwards:
  // no shared keyword is precisely the case embeddings exist to solve, so a
  // domain acronym or a synonym ("sales" for revenue) was discarded before the
  // lane that could recognise it ever saw it. Measured on the fixture catalog:
  // FTS `customers` returns no metrics at all, while the vector lane carries
  // every one of them.
  //
  // The bounded window retains lexical priority, but it reserves capacity for
  // the request-scoped vector shortlist before the lexical slice is applied.
  // Nothing else about admission moves: authorization, domain, lifecycle, and
  // privacy filters have already run above.
  const lexical = executabilityAdjusted
    .filter((entry) => entry.grounded || entry.ftsScore > 0)
    .sort((left, right) => right.ftsScore - left.ftsScore || left.metric.name.localeCompare(right.metric.name));
  const vectorOnlyPool = executabilityAdjusted
    .filter((entry) => !entry.grounded && entry.ftsScore <= 0);
  const directCatalogBound = candidates.length <= MAX_HYBRID_METRIC_CANDIDATES;
  const requestedVectorOrder = new Map(
    (options.vectorMetricShortlist ?? []).map((identity, index) => [identity.trim().toLowerCase(), index]),
  );
  // A catalog larger than the direct bound must use the snapshot vector lane.
  // Alphabetical admission was a hidden recall cliff: candidate #97 could be
  // semantically perfect yet never reach embeddings.  No compatible snapshot
  // shortlist means vector-only grounding is unresolved, not guessed.
  const vectorShortlist = directCatalogBound
    ? []
    : executabilityAdjusted
        .filter((entry) => metricVectorRank(entry.metric, requestedVectorOrder) !== undefined)
        .sort((left, right) =>
          (metricVectorRank(left.metric, requestedVectorOrder) ?? Number.MAX_SAFE_INTEGER)
          - (metricVectorRank(right.metric, requestedVectorOrder) ?? Number.MAX_SAFE_INTEGER)
          || left.metric.name.localeCompare(right.metric.name));
  const rankedCandidates = directCatalogBound
    ? [...lexical, ...vectorOnlyPool]
    : (() => {
        // Allocate the vector lane FIRST.  A shortlisted item may have a weak
        // lexical score too, so reserve against the full shortlist rather than
        // only zero-lexical entries; otherwise a weak keyword hit can still
        // fall behind an alphabetically ordered 96-item lexical window.
        const reservedVector = vectorShortlist.slice(0, VECTOR_SHORTLIST_RESERVED_CANDIDATES);
        const reservedIds = new Set(reservedVector.map((entry) => metricVectorIdentity(entry.metric)));
        const lexicalCapacity = Math.max(0, MAX_HYBRID_METRIC_CANDIDATES - reservedVector.length);
        const selectedLexical = lexical
          .filter((entry) => !reservedIds.has(metricVectorIdentity(entry.metric)))
          .slice(0, lexicalCapacity);
        const remaining = Math.max(0, MAX_HYBRID_METRIC_CANDIDATES - reservedVector.length - selectedLexical.length);
        const additionalVector = vectorShortlist
          .slice(reservedVector.length, reservedVector.length + remaining);
        return [...selectedLexical, ...reservedVector, ...additionalVector];
      })();
  if (rankedCandidates.length === 0) return null;
  // Retrieval must not silently send enterprise metric definitions to a remote
  // provider merely because an ambient API key exists. Hosts may opt into an
  // explicit provider; the default remains local and deterministic.
  const provider = options.provider ?? defaultEmbeddingProvider();
  const ranked = await hybridRank(
    question,
    rankedCandidates.map((entry) => ({ item: entry, text: entry.text, ftsScore: entry.ftsScore })),
    {
      // Embedding weight is no longer gated on a lexical hit. Zeroing alpha
      // when nothing matched lexically meant embeddings could only REFINE a
      // keyword hit and could never CREATE a match, which made the vector lane
      // useless in the one case it exists for.
      alpha: options.alpha ?? DEFAULT_METRIC_MATCH_EMBEDDING_ALPHA,
      provider,
    },
  );

  // Name-proximity tie-breaker. Sibling metrics that share the question's
  // measure token score identically ("BCM" hits total_bcm AND percent_mom_bcm
  // with the same name fraction + family), and the old alphabetical fallback
  // then picked percent_mom_bcm — a month-over-month ratio — for a plain
  // "top customers for BCM" ask. Among near-tied leaders, prefer the metric
  // whose NAME carries the fewest tokens the question never said: the user's
  // mention is closest to the base metric, and every unrequested modifier
  // (percent, mom, forecast, prior…) is evidence of a more specific intent
  // the question did not express.
  // "Never said" must be measured against what the USER said, not against the
  // planner's reduced measure terms.
  //
  // The planner strips qualifiers — "drink revenue" and "beverage revenue" both
  // reduce to measures:["revenue"] — and Ask passes only those terms as the
  // measure signal. `qContent` was therefore {revenue}, so this tie-breaker
  // charged `drink_revenue` an extra for the word "drink" that the question DID
  // contain, and the generic `revenue` won. Block AI, which passes the bare
  // prompt, kept the qualifier and picked `drink_revenue` — the same question
  // resolving to different metrics depending on the surface.
  //
  // Scoring still runs on the measure terms (that is what keeps "region tax by
  // product" on tax_amount rather than product_count), and only this
  // near-tie ordering consults the full question.
  const spokenTokens = new Set([...qContent, ...contentTokens(question)]);
  const nameDistance = (metric: KGNode): number => {
    let extras = 0;
    for (const token of tokenize(metric.name.replace(/[_.]+/g, ' '))) {
      if (!spokenTokens.has(token) && !STOPWORDS.has(token)) extras += 1;
    }
    return extras;
  };
  const leader = ranked[0];
  const bestByProximity = leader
    ? ranked
        .filter((entry) => entry.score >= leader.score * 0.98)
        .sort((left, right) =>
          nameDistance(left.item.metric) - nameDistance(right.item.metric)
          || right.score - left.score
          || left.item.metric.name.localeCompare(right.item.metric.name))[0]
    : undefined;
  if (bestByProximity && bestByProximity !== leader) {
    const index = ranked.indexOf(bestByProximity);
    ranked.splice(index, 1);
    ranked.unshift(bestByProximity);
  }

  const best = ranked[0];
  if (!best) return null;
  const second = ranked[1];
  const realEmbeddingProvider = !provider.id.includes('hashed-token');
  const embeddingGrounded = !best.item.grounded
    && realEmbeddingProvider
    && best.vectorScore >= VECTOR_ONLY_METRIC_SCORE_FLOOR
    && best.vectorScore - (second?.vectorScore ?? 0) >= VECTOR_ONLY_METRIC_SEPARATION_MARGIN;
  if ((!best.item.grounded || best.score < threshold) && !embeddingGrounded) return null;
  return {
    metric: best.item.metric,
    score: embeddingGrounded ? best.vectorScore : best.score,
    family: best.item.family,
    basis: embeddingGrounded ? 'embedding' : best.item.basis,
  };
}

function metricVectorIdentity(metric: KGNode): string {
  return (metric.nodeId || metric.name).trim().toLowerCase();
}

function metricVectorRank(metric: KGNode, order: Map<string, number>): number | undefined {
  return order.get(metricVectorIdentity(metric)) ?? order.get(metric.name.trim().toLowerCase());
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Parse a metric KG node's governed definition: the aggregate `sql:` expression
 * and its `table:` relation, stored on `llmContext`. Returns undefined when the
 * `sql:` is not an aggregate expression (a bare metric-name reference) or there is
 * no table — those are not directly executable.
 */
export function parseMetricDefinition(
  metric: KGNode,
  semanticLayer?: SemanticLayer,
): { expr: string; table: string } | undefined {
  // Prefer the STRUCTURED metric definition from the semantic layer when
  // available — no fragile text parsing. Fall back to reading the KG node's
  // llmContext blob for manifest-native metrics that carry no structured def.
  if (semanticLayer) {
    const structured = structuredMetricDefinition(metric, semanticLayer);
    if (structured) return structured;
  }
  const context = metric.llmContext ?? '';
  const expr = context.match(/(?:^|\n)\s*sql:\s*(.+?)\s*(?:\n|$)/i)?.[1]?.trim();
  const table = context.match(/(?:^|\n)\s*table:\s*(.+?)\s*(?:\n|$)/i)?.[1]?.trim();
  if (!expr || !table || !looksLikeExecutableMetricExpr(expr)) return undefined;
  return { expr, table };
}

/**
 * A metric expression is only executable when it is a real aggregate/function call
 * with a NON-EMPTY argument — SUM(x), COUNT(*), AVG(order_total). The old bare
 * `/[()]/` presence test accepted degenerate exprs like `COUNT()` / `()`, which
 * synthesize a hollow `SELECT COUNT() AS x` that errors or returns a meaningless
 * value. Require an identifier head, `(`, then at least one non-`)` argument char
 * (or `*`), so degenerate exprs fall through to honest refusal / generation instead.
 */
function looksLikeExecutableMetricExpr(expr: string): boolean {
  return /[A-Za-z_][A-Za-z0-9_]*\s*\(\s*(?:\*|[^)\s])/.test(expr);
}

/** Look up a metric's structured {expr, table} from the semantic layer by name/leaf. */
function structuredMetricDefinition(
  metric: KGNode,
  semanticLayer: SemanticLayer,
): { expr: string; table: string } | undefined {
  const candidates = [metric.name, metric.name.split('.').pop() ?? metric.name];
  for (const name of candidates) {
    const def = semanticLayer.getMetric(name);
    // Trim the structured definition (the blob path already trims); an untrimmed
    // `table: '  '` would synthesize a broken `FROM   `. Require a real executable
    // aggregate expression, same gate as the blob path.
    const sql = def?.sql?.trim();
    const table = def?.table?.trim();
    if (sql && table && looksLikeExecutableMetricExpr(sql)) {
      return { expr: sql, table };
    }
  }
  return undefined;
}

/**
 * Deterministic, offline-safe governed SQL for a matched metric (spec 17, part C):
 * a single read-only `SELECT <expr> AS <alias> FROM <table>` synthesised from the
 * metric's governed definition. Returns undefined when the definition is too thin
 * to execute, preserving honest refusal.
 */
export function metricToGovernedSql(metric: KGNode, semanticLayer?: SemanticLayer): string | undefined {
  const def = parseMetricDefinition(metric, semanticLayer);
  if (!def) return undefined;
  const alias = metric.name.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'metric_value';
  return `SELECT ${def.expr} AS ${alias}\nFROM ${def.table}`;
}

/**
 * Resolve a matched metric to executable governed SQL. dbt's semantic layer splits
 * a metric from its measure: a derived MetricFlow metric (e.g. `revenue`, type=simple
 * over measure `revenue`) carries no `table:`/`sql:` of its own — the aggregate lives
 * on the backing measure node (`order_item.revenue` → `SUM(product_price)` over
 * `order_items`). When the matched metric is itself synthesizable we use it directly;
 * otherwise we fall back to a sibling whose LEAF name matches (`revenue` ⇒
 * `<model>.revenue`). No fuzzy family guessing — precise resolution or nothing.
 */
export function resolveGovernedMetricSql(
  metric: KGNode,
  pool: KGNode[],
  semanticLayer?: SemanticLayer,
): { sql: string; metric: KGNode } | undefined {
  const resolved = resolveGovernedMetricDefinition(metric, pool, semanticLayer);
  return resolved ? { sql: metricToGovernedSql(resolved.metric, semanticLayer)!, metric: resolved.metric } : undefined;
}

/** Resolve a metric (or its leaf-named sibling measure) to an executable definition. */
export function resolveGovernedMetricDefinition(
  metric: KGNode,
  pool: KGNode[],
  semanticLayer?: SemanticLayer,
): { def: { expr: string; table: string }; metric: KGNode } | undefined {
  const direct = parseMetricDefinition(metric, semanticLayer);
  if (direct) return { def: direct, metric };
  const leaf = metric.name.split('.').pop()?.toLowerCase();
  if (!leaf) return undefined;
  const leafSibling = pool
    .filter((node) => node.nodeId !== metric.nodeId && node.name.split('.').pop()?.toLowerCase() === leaf)
    .sort((a, b) => a.name.length - b.name.length)
    .find((node) => parseMetricDefinition(node, semanticLayer));
  if (!leafSibling) return undefined;
  return { def: parseMetricDefinition(leafSibling, semanticLayer)!, metric: leafSibling };
}

export interface GovernedMetricFirstResult {
  sql: string;
  metric: KGNode;
  dimensions: string[];
}

/**
 * Tier 2 of the governed answer hierarchy (certified blocks → semantic-layer
 * metrics + dimensions → generated SQL): deterministically synthesize executable
 * SQL for a confidently matched metric WHEN its governed definition can express
 * the question's full requested shape — a scalar KPI, or a group-by whose
 * requested dimensions ALL resolve to real columns on the metric's own table
 * (verified against the runtime schema). Precise-or-nothing: any unresolvable
 * dimension, explicit filter, extra measure, or per-group top-N returns
 * undefined so the question falls through to generation, where the metric still
 * grounds the prompt as context.
 */
export function buildGovernedMetricFirstSql(input: {
  metric: KGNode;
  pool: KGNode[];
  requestedShape: {
    dimensions: string[];
    measures: string[];
    filters: string[];
    topN?: { n: number; scope: 'overall' | 'per_group' };
    rankingDirection?: 'top' | 'bottom';
  };
  schemaTables: Array<{ relation: string; name?: string; columns: Array<{ name: string }> }>;
  semanticLayer?: SemanticLayer;
}): GovernedMetricFirstResult | undefined {
  const { requestedShape } = input;
  // Conservative gates: ONE measure family (the planner expands a single ask
  // into variants — 'revenue'/'total'/'total_revenue' — so count families, not
  // terms), no explicit filter values (value binding stays with generation),
  // and no per-group ranking.
  const families = new Set(
    requestedShape.measures
      .map((measure) => measureFamilyOf(measure))
      .filter((family): family is string => Boolean(family)),
  );
  if (families.size > 1) return undefined;
  if (requestedShape.filters.length > 0) return undefined;
  if (requestedShape.topN?.scope === 'per_group') return undefined;
  const resolved = resolveGovernedMetricDefinition(input.metric, input.pool, input.semanticLayer);
  if (!resolved) return undefined;
  const alias = resolved.metric.name.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'metric_value';

  if (requestedShape.dimensions.length === 0) {
    return {
      sql: `SELECT ${resolved.def.expr} AS ${alias}\nFROM ${resolved.def.table}`,
      metric: resolved.metric,
      dimensions: [],
    };
  }

  const table = findSchemaTable(resolved.def.table, input.schemaTables);
  if (!table) return undefined;
  const columns: string[] = [];
  for (const dimension of requestedShape.dimensions) {
    const column = resolveDimensionColumn(dimension, table.columns);
    if (!column) return undefined;
    if (!columns.includes(column)) columns.push(column);
  }
  const direction = requestedShape.rankingDirection === 'bottom' ? 'ASC' : 'DESC';
  const limit = requestedShape.topN?.n;
  return {
    sql: [
      `SELECT ${columns.join(', ')}, ${resolved.def.expr} AS ${alias}`,
      `FROM ${resolved.def.table}`,
      `GROUP BY ${columns.join(', ')}`,
      `ORDER BY ${alias} ${direction}`,
      ...(limit ? [`LIMIT ${limit}`] : []),
    ].join('\n'),
    metric: resolved.metric,
    dimensions: columns,
  };
}

/** Resolve a measure term to its synonym family (undefined for generic words like 'total'). */
function measureFamilyOf(term: string): string | undefined {
  const tokens = term.toLowerCase().match(TOKEN_RE) ?? [];
  for (const [family, words] of Object.entries(MEASURE_FAMILIES)) {
    if (tokens.some((token) => words.includes(token))) return family;
  }
  return undefined;
}

function findSchemaTable(
  table: string,
  schemaTables: Array<{ relation: string; name?: string; columns: Array<{ name: string }> }>,
): { relation: string; columns: Array<{ name: string }> } | undefined {
  const target = table.toLowerCase();
  const targetLeaf = tableName(target) || target;
  return schemaTables.find((candidate) => {
    const relation = candidate.relation.toLowerCase();
    const name = candidate.name?.toLowerCase();
    return relation === target
      || tableName(relation) === targetLeaf
      || name === target
      || name === targetLeaf;
  });
}

/** Map a requested dimension term to a real column on the metric's table (exact-ish only). */
function resolveDimensionColumn(dimension: string, columns: Array<{ name: string }>): string | undefined {
  const term = dimension.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const singular = term.replace(/s$/, '');
  const candidates = [term, singular, `${term}_name`, `${singular}_name`];
  for (const candidate of candidates) {
    const hit = columns.find((column) => column.name.toLowerCase() === candidate);
    if (hit) return hit.name;
  }
  const suffixHit = columns.find((column) => {
    const name = column.name.toLowerCase();
    return name.endsWith(`_${singular}`) || name.endsWith(`_${term}`);
  });
  return suffixHit?.name;
}
