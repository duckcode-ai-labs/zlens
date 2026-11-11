import type { RenderedCards } from './vocabulary.js';
import type { AgentMessage, AgentProvider, ProviderRunOptions } from '../providers/types.js';
import { generateStructured } from '../providers/structured-output.js';
import {
  ANALYTICAL_INTENT_JSON_SCHEMA,
  describeIntent,
  intentRefs,
  parseIntent,
  unaccountedInheritedRefs,
  type AnalyticalIntentV1,
  type IntentPredicate,
  type IntentUnresolved,
} from './intent.js';
import { samePhysicalRelation } from './physical-binding.js';
import { priorWithoutValues } from './prior-values.js';
import { normalizeVocabularyText, renderCard, suggestSameGrainColumns, suggestSameRelationFields, trigramSimilarity, type VocabularyEntry, type VocabularyIndex, type VocabularyKind } from './vocabulary.js';

/**
 * THE MODEL'S ONE JOB: say what the question means, in the vocabulary.
 *
 * One structured call. The reply is parsed, every ref is checked against the
 * vocabulary index (and canonicalised when the model wrote a name instead of
 * a ref), roles are checked (a measure ref must be a measure, a group-by
 * must be a key or dimension, a display must be a label), and an inherited
 * clause that vanished must be accounted for. A single bounded corrective
 * call carries the exact problems and the nearest authorized refs back to
 * the model. Every physical call, corrective ones included, is reported
 * through `onDispatch` so the host's one ledger counts it.
 */

export interface ResolveIntentInput {
  /** AI-written SQL is available: a reading that is not over certified blocks or authored semantics returns at once with lane \`ai\`. */
  aiLane?: boolean;
  /** The thread's compacted memory, rendered with the previous analysis. */
  conversation?: { summary?: string; pendingClarification?: string };
  /** Cards already rendered by the pipeline (with rank, pins and header); rendered here only when absent. */
  renderedCards?: RenderedCards;
  question: string;
  vocabulary: VocabularyIndex;
  provider: AgentProvider;
  /** The executed intent of the previous turn, when this turn continues it. */
  prior?: AnalyticalIntentV1;
  /** False when the prior turn was blocked: its question stands, its result does not exist. */
  priorExecuted?: boolean;
  priorAnswerSummary?: string;
  /**
   * Host: the earlier reading's values may not reach this model (RFC 0010 HH-5). The model reads them named by
   * position (prior-values.ts) and its reading gets the real values back before anything else reads it.
   */
  hidePriorValues?: boolean;
  /** Host: skip the full-question clause check (research branches phrase hypotheses, not questions). */
  clauseCoverage?: boolean;
  /**
   * The user's own words, when `question` carries more (a repair appends the
   * engine's message). Every guard that reads the question — coverage,
   * breakdowns, periods, the ledger — reads these, so "order by one of …" in
   * an engine message is never mistaken for a breakdown the user asked for.
   */
  coverageQuestion?: string;
  /** Milliseconds the run can still spend; a timed-out interpreter dispatch is retried once when this allows another. */
  budgetMs?: number;
  /**
   * Whether one more reading call (a correction, a re-ask after retrieval, a retry) still leaves the run time to
   * write the SQL, judged by how long the last reading call took. False ends the reading as failed, so the SQL is
   * drafted from the question itself (new-user test V11 retest: a 83 s reading and a 74 s correction left no time to
   * draft, and the run said the question did not match the project's fields).
   */
  mayDispatchAgain?: (lastDispatchMs: number) => boolean;
  /** The obligations of the original question, when this resolution is a repair of an earlier reading. */
  ledger?: IntentLedger;
  /** Round number for ledger entries (0 = the first resolution, 1 = the pipeline's repair). */
  ledgerRound?: number;
  /** The governed meaning the user picked from a clarification's options, when this turn continues one. */
  selection?: { ref: string; label?: string };
  /** Optional domain briefing / project guidance rendered above the cards. */
  guidance?: string;
  /** Character budget for the vocabulary cards. */
  cardBudget?: number;
  maxAttempts?: number;
  providerOptions?: ProviderRunOptions;
  onDispatch?: (event: { attempt: number; purpose: 'resolve' | 'correct'; raw: string; ms: number; problems?: IntentProblem[]; promptChars?: number }) => void;
  now?: () => number;
  /** Pipeline-owned retrieval for a clause the reading left unresolved: entries not shown before (a named relation's columns, inventory hits), once. */
  expand?: (need: { clauses: string[]; question: string; reading: string }) => Promise<{ vocabulary: VocabularyIndex; cards: string[]; note: string } | undefined>;
}

export interface IntentProblem { path: string; message: string; suggestions?: string[] }

/**
 * What the ORIGINAL question obliged, written down from the first reading and
 * immutable afterwards. A later reading (a schema correction, a guard's
 * re-ask, the pipeline's repair after a refused preparation) may discharge an
 * obligation by binding refs that account for it, or keep it listed as
 * unresolved; it may never silently drop it. "Closest available" is not a
 * discharge: a block stands in for a measure only through its own outputs.
 */
export interface IntentLedger {
  /** Material clauses the first reading declared it could not resolve. */
  clauses: Array<{
    clause: string; kind?: IntentUnresolved['kind']; question?: string; words: string[];
    /**
     * What KIND of output would answer the clause. "which teams he played for"
     * asks for identities: a count of teams uses the same words and answers a
     * different question, so an identity clause is discharged only by a
     * grouping or a displayed label, never by a measure.
     */
    role?: 'identity';
    /** The words that must be accounted for in that role. */
    roleWords?: string[];
  }>;
  /** The first reading's time grouping (a monthly trend is never a ranking). */
  timeGrain?: { ref: string; grain: string };
  /** The first reading's measures by ref (a block may replace one only through its outputs). */
  measures: string[];
  /** Question words no ref of the first reading accounted for (informational; the coverage guards use them). */
  unaccounted: string[];
}

export interface LedgerEntry { clause: string; kind?: string; disposition: 'discharged' | 'unresolved' | 'dropped' | 'restored'; by?: string; round: number }

export type IntentResolution =
  | { status: 'resolved'; intent: AnalyticalIntentV1; attempts: number; problems: IntentProblem[]; ledger?: IntentLedger; ledgerEntries?: LedgerEntry[]; /** `ai`: the reading is not over certified blocks or authored semantics, so AI-written SQL answers it. */ lane?: 'ai' }
  | { status: 'clarify'; intent: AnalyticalIntentV1; question: string; options: string[]; attempts: number; ledger?: IntentLedger; ledgerEntries?: LedgerEntry[]; /** The options are the host's nearest guesses for names the reading used that the project does not hold. */ unmatched?: IntentProblem[] }
  | { status: 'conversation'; intent: AnalyticalIntentV1; reply: string; attempts: number }
  | { status: 'definition'; intent: AnalyticalIntentV1; reply: string; attempts: number }
  | { status: 'failed'; reason: 'provider_error' | 'unparseable' | 'invalid'; detail: string; problems: IntentProblem[]; attempts: number; code?: string };

/**
 * TWO GOVERNED SOURCES. A certified block, or an object a team authored in a
 * semantic layer (a metric, measure, dimension, entity or semantic model), is
 * governed. A dbt column, a relation, or a dimension built from a dbt model's
 * columns because no semantic layer exists is not: nobody vouched for it.
 */
export function isGovernedEntry(entry: VocabularyEntry): boolean {
  if (entry.kind === 'block') return true;
  if (entry.kind === 'metric' || entry.kind === 'measure' || entry.kind === 'dimension' || entry.kind === 'entity' || entry.kind === 'model') return !entry.inventory;
  return false;
}

/**
 * Which lane answers a reading: `governed` when every ref it uses is a
 * certified block or an authored semantic object, `ai` when any ref is a
 * column, a relation, an inventory dimension or something the project does
 * not hold. A reading that names nothing yet stays governed, so a governed
 * default can still supply its measure.
 */
export function readingLane(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): 'governed' | 'ai' {
  const refs = intentRefs(intent);
  // Nothing named yet stays governed (a governed default may supply the
  // measure), unless the reading already says the question is something no
  // governed object models: then only the tables can answer it.
  if (refs.length === 0) return intent.unresolved.some((clause) => clause.material && clause.options.length === 0 && clause.kind !== 'unsupported') ? 'ai' : 'governed';
  return refs.every((ref) => { const entry = vocabulary.resolve(ref); return Boolean(entry && isGovernedEntry(entry)); }) ? 'governed' : 'ai';
}

/**
 * A reading that reached for governed vocabulary and missed earns its one
 * correction, because a certified or semantic answer may be one re-ask away:
 * a misspelt name with a governed suggestion, or a metric, measure, dimension,
 * entity or block that does not exist in a project that has governed objects.
 * A column or relation that does not exist goes straight to AI-written SQL.
 */
function correctsTowardSemantics(intent: AnalyticalIntentV1, problems: IntentProblem[], vocabulary: VocabularyIndex): boolean {
  const invalid = problems.map((problem) => /^(.+?) is not in the vocabulary$/.exec(problem.message)?.[1]).filter((ref): ref is string => Boolean(ref));
  if (invalid.length === 0 || invalid.length !== problems.length) return false;
  const others = intentRefs(intent).filter((ref) => !invalid.includes(ref));
  if (!others.every((ref) => { const entry = vocabulary.resolve(ref); return Boolean(entry && isGovernedEntry(entry)); })) return false;
  const projectHasGoverned = vocabulary.entries.some((entry) => isGovernedEntry(entry));
  return invalid.every((ref) => vocabulary.suggest(ref, 3).some((entry) => isGovernedEntry(entry)) || (projectHasGoverned && /^(metric|measure|dimension|entity|block):/i.test(ref)));
}

const MEASURE_KINDS: VocabularyKind[] = ['metric', 'measure', 'column', 'block'];
const RATIO_KINDS: VocabularyKind[] = ['metric', 'measure', 'column'];
const GROUP_KINDS: VocabularyKind[] = ['dimension', 'entity', 'column'];
const DISPLAY_KINDS: VocabularyKind[] = ['dimension', 'entity', 'column'];
const FILTER_KINDS: VocabularyKind[] = ['dimension', 'entity', 'column'];

export function buildIntentSystemPrompt(input: { cards: string; guidance?: string; hasPrior: boolean; hints?: string[]; selection?: { ref: string; label?: string } }): string {
  return [
    'You are the interpreter for a governed analytics system over a dbt project. You read one question and write down exactly what it means as a JSON AnalyticalIntent. You never write SQL and never invent identifiers: every ref you use must be copied verbatim from the vocabulary below. The host proves and executes what you write.',
    '',
    'RULES',
    '1. IDENTITY IS THE KEY, THE NAME IS THE LABEL. A ranking or breakdown of customers, products, locations or any entity is grouped by that entity\'s key ref (role key) and the human label (role label, e.g. customer_name) goes in `display`. Never group by a name. A display label must belong to the SAME entity as the key (product_name for a product key), never to a finer-grained thing (a supply name beside a product key would multiply the rows).',
    '2. A QUALIFIER RESTRICTS ONLY THE MEASURE IT MODIFIES. "beverage revenue" is the drink-scoped revenue measure (or revenue with a scope predicate on THAT measure), not a global filter. "total revenue and beverage revenue" is two measures.',
    '3. A QUOTED OR PROPER-NAME LITERAL IS A FILTER VALUE on the dimension that holds such values (customer names on customer_name, product names on product_name). Keep the literal exactly as written; the host matches it case-insensitively.',
    '4. PREFER THE GOVERNED DEFINITION. If a metric already expresses the measure the question asks for, use it; only fall back to column refs with an aggregation when no metric fits. A certified block may be named as the ONLY measure ref when the question asks for exactly what the block declares (same measure, same scope, same grain, same ranking); a block-named intent carries NO groupBy, display or filters of its own because the block already fixes them. If you are not sure the block matches exactly, express the analysis with metric and dimension refs instead.',
    '4b. A FACT TABLE MAY KEEP ROWS A DEFINITION DOES NOT COUNT: a participation flag, a soft delete, a test order, a cancelled row. When a relation or a column card says which rows count, either use the metric that already applies that rule, or put the restriction in that measure\'s `scope`. Counting the raw column instead answers a different question at the same confidence.',
    '5. SHAPE. "top/best/highest N" is a ranking: ordering desc on the measure and a limit (default 10 when "top" has no number). "by <thing>" is a breakdown. "how many/what is the total" with no breakdown is a scalar. "X and Y" for one subject is a comparison.',
    '5c. A RATIO OVER RAW COLUMNS. When the project has no metric for a part (a dbt project with no semantic layer), a ratio part may be a `column:` ref with its aggregation: `derived: {"kind":"ratio","numerator":"column:<relation>.<col>","numeratorAggregation":"sum","denominator":"column:<relation>.<col2>","denominatorAggregation":"count_distinct"}` (points per game = sum of points / count_distinct of game ids over the rows that count as games). Never invent a measure name.',
    '5e. A STORED RATE IS NOT AN AVERAGE OF RATES. A column that already holds a percentage or a per-unit rate (field_goal_pct, win_rate, margin_pct) is one row\'s rate: averaging it over many rows weights a player with three attempts like one with three hundred. When the parts exist (made and attempted, wins and games), write the ratio of their sums; use the stored column only when the answer is about one row, or when the project has no parts to divide.',
    '5f. A COMPARISON BETWEEN TWO PERIODS IS TWO SCOPED MEASURES, NEVER A GROUPING. "from 2016 to 2017", "this year versus last": write the SAME measure twice, each with its own period in `scope` and its own `alias` (points_2016, points_2017). Grouping by the period instead returns one row per period per entity and answers a different question. Then, when the question asks for the change, the difference, the growth or the improvement, add ONE more measure `{"change":{"base":"points_2016","comparison":"points_2017","as":"percent"},"alias":"points_change_pct"}` — `as` is "percent" when the question says percentage/percent change and "absolute" otherwise. A superlative over that difference ("improved the most", "biggest increase") orders by that change measure, descending, with the limit the question asks for; a threshold that applies to EACH period is one scoped measure per period with its own threshold filter.',
    '5d. A THRESHOLD ON AN AGGREGATE. "with at least 20 games", "minimum 100 attempts" is a filter on the aggregated measure, not on rows: add that measure (with an alias) and a filter `{"ref":"measure:<index of that measure>","op":"gte","values":[20]}`; it applies after aggregation.',
    '5b. A RATIO OF TWO GOVERNED MEASURES. "average order value", "revenue per order", "X per Y", "share of", "margin %" is a measure with `derived: {"kind":"ratio","numerator":<metric ref>,"denominator":<metric ref>}` and an `alias`, and no `ref` (average order value = the revenue metric / the order-count metric). A governed derived or ratio metric (its card shows `= formula` and `time <dim>`) may be used instead ONLY when it measures the same thing over the same time role as the question: a metric built from lifetime per-customer measures (lifetime spend / lifetime orders, time = the customer\'s first order date) is a cohort average, so "average order value in 2025", "by month", "last quarter" is NEVER that metric; it is the derived ratio of the period\'s revenue and orders. Use the cohort metric only when the question names the cohort itself ("customers first acquired in 2025", "customers who joined in"). "share of ALL", "% of total", "concentration": the denominator is the SAME measure over every row of the period, written `"denominatorScope":"overall"` on the derived ratio (a measure divided by itself without it is 1 for every row).',
    '6. TIME. A time axis ("by month") is a groupBy with role time and a grain, using the time dimension of the SAME model as the measure (an order total is by the orders model\'s time, an order-line revenue by the order line model\'s time). A time window ("last quarter", "in 2025") is `time.window` with an ISO half-open range plus the expression. Measures under one window must share their `time` role (see the cards); when they do not, add an `unresolved` entry with material=true and the two time dimension refs as options instead of choosing. A period inside a `scope` or a filter on a DATE field is written as a period token the host resolves against today — current_month, last_month, this_year, last_year, previous_quarter, ytd, mtd, last_3_months, today, yesterday — or as a partial date ("2025", "2025-03", "2025-Q2") meaning that whole period; never guess today\'s date and never write a word the warehouse would read as a date.',
    '7. CLARIFY ONLY WHAT IS MATERIAL. If two vocabulary entries are both plausible and the answer would differ (for example pretax product revenue vs order total including tax when the question says only "total revenue" and the project defines both), add an `unresolved` entry with material=true, the options as refs, and a one-sentence question. But: a metric whose NAME is the word the question uses ("revenue" is metric revenue, "lifetime spend" is metric lifetime_spend) IS the meaning; clarify only when the question adds a qualifier the vocabulary distinguishes ("gross", "including tax", "order revenue"). Never clarify which of two refs to use when they identify the same entity (a key column on the measure\'s model vs the entity on its own model): pick the one on the measure\'s model. Do not clarify spelling mistakes or obvious paraphrases; resolve them. Never ask whether a dimension or entity is reachable from a measure\'s model, or which join to take: the host proves join paths and grain after you answer. A material clause is only ever a choice between two or more refs, or an empty options list for something this project does not hold.',
    '8. KIND. Greetings, thanks, and questions about what you can do are kind "conversation" with a short `reply`. "What does X mean / how is X defined" is kind "definition" with a `reply` drawn from the vocabulary descriptions. Everything that asks for numbers or rows is kind "analytics". A question about something this project does not hold at all (weather, news, a different business) is kind "analytics" with no measures and one `unresolved` entry {clause: what was asked, options: [], material: true}: never a conversational reply, never a guessed metric.',
    '8b. BUSINESS TERMS ARE THE GOVERNED DEFAULT. When a term in the vocabulary defines a word of the question ("Revenue" defined as product revenue excluding tax), the metric that term names is the meaning; do not treat the word as ambiguous. Only two competing definitions with no governing term are material.',
    '8c. DISPLAY IS THE GRAIN\'S LABEL. A display ref is the name/label of an entity in groupBy (the customer\'s name beside the customer key). Never display an attribute of a finer grain (a supply name when grouping by product): it multiplies the rows.',
    '8d. A NUMERIC COLUMN IS A MEASURE. When the question asks for a quantity that exists only as a numeric column (no metric declares it), use its column: or dimension: ref as a measure with an aggregation (sum, avg, count). Report a clause as not modeled ONLY when no entry of any kind — metric, dimension, column, block, term — matches its words.',
    '9. PROVENANCE. For every ref you use, provenance[ref] is the phrase of the question it came from ("q:<phrase>"), or "inherited" when it is carried from the previous analysis.',
    '11. POPULATION. "including X with no Y", "every store", "all customers, even those with zero orders", "show zeros" means `population: "all"`: every member of the entity in groupBy is a row (grouped by its key ref, role key) and additive measures read 0 where nothing matched. Otherwise omit `population` (only matched members are rows).',
    ...(input.hasPrior ? [
      '10. THIS IS A FOLLOW-UP. The previous executed analysis is given below. Treat the new message as an EDIT of it: keep every clause the message does not change (mark it "inherited"), add or replace what it asks for, and for any prior ref you drop write provenance[ref] = "removed:<why>". "Include X" adds a display or measure and keeps everything else, including scope, ranking and limit. A short correction that repeats a word of the previous analysis ("I need the beverage category", "no, drinks only") without a new measure or a new entity is an EDIT that keeps the previous measures, grain, ranking and limit. Only a message that names a new subject entirely ("what is Ryan Byrd\'s revenue") starts a new analysis; list the dropped refs as removed. When both readings are plausible, ask one bounded clarification instead of choosing.',
    ] : []),
    '',
    'OUTPUT: one JSON object matching this shape, nothing else. `reading` restates the question in one sentence as you understood it.',
    '{"version":1,"kind":"analytics","reading":"...","measures":[{"ref":"metric:...","scope":[{"ref":"dimension:...","op":"eq","values":["..."],"source":"question"}],"aggregation":"sum"},{"derived":{"kind":"ratio","numerator":"metric:...","denominator":"metric:..."},"alias":"..."}],"groupBy":[{"ref":"entity:...","role":"key"},{"ref":"dimension:...","role":"time","grain":"month"}],"display":["dimension:..."],"filters":[{"ref":"dimension:...","op":"eq","values":["literal"],"source":"question"}],"ordering":{"ref":"metric:...","direction":"desc"},"limit":10,"time":{"ref":"dimension:...","window":{"start":"2025-01-01","end":"2026-01-01","expression":"in 2025"}},"expectedShape":"ranking","population":"matching","unresolved":[],"provenance":{"metric:...":"q:phrase"},"reply":"only for conversation/definition"}',
    'Predicates always carry `values` as an array (one element for eq; the literal exactly as written). `scope`, `aggregation`, `derived` and `population` are optional. Omit `ordering`, `limit` and `time` when the question has none.',
    ...(input.selection ? ['', `THE MEANING IS ALREADY CHOSEN. The user picked ${input.selection.ref}${input.selection.label ? ` (${input.selection.label})` : ''} for the ambiguous part of this question. Use that ref: as the measure when it measures something, as the grouping when it names a thing. Do not list that part as unresolved and never ask about it again; read the rest of the question as usual.`] : []),
    ...(input.guidance ? ['', 'PROJECT GUIDANCE', input.guidance] : []),
    ...(input.hints?.length ? ['', 'SPELLING HINTS (question words that match nothing exactly, with the nearest vocabulary; a misspelling resolves to the obvious entry)', ...input.hints.map((hint) => `- ${hint}`)] : []),
    '',
    'VOCABULARY (the only refs that exist)',
    input.cards,
  ].join('\n');
}

/** What the thread settled earlier, and what it is still waiting on. Context for reading an edit; never a source of refs. */
function renderConversation(conversation: { summary?: string; pendingClarification?: string } | undefined): string {
  if (!conversation) return '';
  const lines: string[] = [];
  if (conversation.summary) lines.push(`EARLIER IN THIS CONVERSATION (settled facts, for reading an edit; refs come only from the vocabulary): ${conversation.summary.replace(/\s+/g, ' ').slice(0, 600)}`);
  if (conversation.pendingClarification) lines.push(`A CLARIFICATION IS STILL OPEN: ${conversation.pendingClarification.replace(/\s+/g, ' ').slice(0, 200)}`);
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

function renderPrior(prior: AnalyticalIntentV1, summary?: string, executed = true): string {
  return [
    executed ? 'PREVIOUS ANALYSIS (executed):' : 'PREVIOUS READING (NOT executed: it was blocked, so it produced no rows. Keep its question — its measures, restrictions, period, ranking and limit — but never describe it as a result, and never refer to rows it did not produce):',
    JSON.stringify({
      reading: prior.reading || describeIntent(prior),
      measures: prior.measures, groupBy: prior.groupBy, display: prior.display, filters: prior.filters,
      ordering: prior.ordering ?? null, limit: prior.limit ?? null, time: prior.time ?? null, expectedShape: prior.expectedShape,
    }),
    ...(summary ? [`Its result: ${summary}`] : []),
  ].join('\n');
}

interface Validation { intent: AnalyticalIntentV1; problems: IntentProblem[]
  /** Set when a follow-up replaced every prior measure while naming nothing new. */
  followUpReplacement?: string;
}

/**
 * Canonicalise every ref against the vocabulary, check roles, and report
 * problems with suggestions. A canonicalised ref replaces what the model
 * wrote so downstream code never sees an alias.
 */
export function validateIntentRefs(input: AnalyticalIntentV1, vocabulary: VocabularyIndex, prior?: AnalyticalIntentV1, question?: string, options: { priorExecuted?: boolean } = {}): Validation {
  let intent = input;
  // A period named on a field that is not a date is a VALUE, not a window: a
  // season column holding 2017 answers "in 2017" as an equality. Rewriting it
  // here keeps the restriction the question asked for instead of failing the
  // whole reading on a field the interpreter chose reasonably.
  const wholeYear = (window: { start?: string; end?: string } | undefined): string | undefined => {
    const start = /^(\d{4})-01-01/.exec(window?.start ?? '');
    const end = /^(\d{4})-01-01/.exec(window?.end ?? '');
    return start && end && Number(end[1]) === Number(start[1]) + 1 ? start[1]! : undefined;
  };
  if (intent.time?.ref && intent.time.window) {
    const entry = vocabulary.resolve(intent.time.ref);
    const year = wholeYear(intent.time.window);
    if (entry && !entry.roles.includes('time') && year && !intent.filters.some((filter) => filter.ref === entry.ref)) {
      intent = {
        ...intent,
        filters: [...intent.filters, { ref: entry.ref, op: 'eq', values: [year], source: intent.time.window.expression ? 'question' : 'inherited' }],
        provenance: { ...intent.provenance, [entry.ref]: `${intent.provenance[intent.time.ref] ?? `q:${intent.time.window.expression ?? year}`} (host: ${entry.ref} is not a date, so the period is a value on it)` },
      };
      delete (intent as { time?: unknown }).time;
    }
  }
  const problems: IntentProblem[] = [];
  let followUpReplacement: string | undefined;
  const canonical = (ref: string, kinds: VocabularyKind[], path: string, roleCheck?: (entry: VocabularyEntry) => string | undefined): string => {
    // A ref spelled with its database in front (`column:db.schema.table.col`)
    // names the same entry as its usual spelling when exactly one entry holds
    // that tail. A column keeps at least schema.table.column; a bare field
    // name is never guessed.
    const qualifiedTail = (): VocabularyEntry | undefined => {
      const match = /^([a-z_]+):(.+)$/i.exec(ref);
      if (!match) return undefined;
      const parts = match[2]!.split('.');
      const minParts = match[1]!.toLowerCase() === 'column' ? 3 : 2;
      for (let start = 1; parts.length - start >= minParts; start += 1) {
        const found = vocabulary.resolve(`${match[1]}:${parts.slice(start).join('.')}`, kinds);
        if (found) return found;
      }
      return undefined;
    };
    const entry = vocabulary.resolve(ref, kinds) ?? vocabulary.resolve(ref) ?? qualifiedTail();
    if (!entry) {
      problems.push({ path, message: `${ref} is not in the vocabulary`, suggestions: vocabulary.suggest(ref).map((e) => e.ref) });
      return ref;
    }
    if (!kinds.includes(entry.kind)) {
      problems.push({ path, message: `${entry.ref} is a ${entry.kind}; expected one of ${kinds.join(', ')}`, suggestions: vocabulary.lookup(entry.name, { kinds, limit: 4 }).map((hit) => hit.entry.ref) });
      return entry.ref;
    }
    const roleProblem = roleCheck?.(entry);
    if (roleProblem) problems.push({ path, message: roleProblem, suggestions: vocabulary.lookup(entry.name, { kinds, limit: 4 }).map((hit) => hit.entry.ref) });
    return entry.ref;
  };
  // A predicate on an aggregated measure ("at least 20 games") names the
  // measure (`measure:<index>` or its alias) and is applied after aggregation.
  const aggregateRef = (ref: string): string | undefined => {
    if (/^measure:\d+$/.test(ref)) return ref;
    const at = intent.measures.findIndex((measure) => measure.alias && measure.alias.toLowerCase() === ref.toLowerCase());
    return at >= 0 ? `measure:${at}` : undefined;
  };
  const predicate = (p: IntentPredicate, path: string): IntentPredicate => {
    const aggregate = aggregateRef(p.ref);
    if (aggregate) return { ...p, ref: aggregate, on: 'aggregate' };
    return { ...p, ref: canonical(p.ref, FILTER_KINDS, path) };
  };
  // A dbt-inventory model exposes every numeric column both as a dimension
  // and as a physical column. Aggregating it is a measure over the column:
  // the dimension ref is read as its column ref rather than refused.
  const asMeasureRef = (ref: string, aggregation?: string): string => {
    const entry = vocabulary.resolve(ref);
    if (!entry || entry.kind !== 'dimension' || !entry.physical?.relation || !entry.physical.column) return ref;
    // Counting is a measure over any column; other aggregates need a number.
    const counting = aggregation === 'count' || aggregation === 'count_distinct';
    if (!counting && !entry.roles.includes('numeric')) return ref;
    const column = vocabulary.get(`column:${entry.physical.relation}.${entry.physical.column}`)
      // A bound entry may spell its relation with the database; the column ref is logical.
      ?? vocabulary.entries.find((candidate) => candidate.kind === 'column' && candidate.physical?.column === entry.physical!.column && samePhysicalRelation(candidate.physical?.relation ?? candidate.model, entry.physical!.relation));
    return column ? column.ref : ref;
  };
  // Ordering by a measure's alias ("total_points") names that measure.
  const orderingRef = (ref: string): string => {
    if (/^measure:\d+$/.test(ref)) return ref;
    // An alias of THIS reading outranks a vocabulary entry that happens to
    // share its name: "points_per_game" here is the ratio just composed over
    // the game facts, not the season metric of the same name — and resolving it
    // to the metric left the ranking with nothing to order by.
    const bare = ref.replace(/^(?:metric|measure|column|dimension):/, '').toLowerCase();
    const at = intent.measures.findIndex((measure) => measure.alias && measure.alias.toLowerCase() === bare);
    if (at >= 0) return `measure:${at}`;
    return ref;
  };
  const provenanceNotes: Record<string, string> = {};
  const measures = intent.measures.map((measure, index) => {
    if (measure.derived) {
      // A ratio's parts are governed metrics or measures, or physical columns
      // with an explicit aggregation when the project has no metric for them.
      const columnPart = (ref: string, aggregation: string | undefined, path: string) => canonical(asMeasureRef(ref, aggregation), RATIO_KINDS, path, (entry) =>
        entry.kind === 'column' && !aggregation ? `${entry.ref} is a raw column; a ratio part over a column needs numeratorAggregation/denominatorAggregation` : undefined);
      const numerator = columnPart(measure.derived.numerator, measure.derived.numeratorAggregation, `measures[${index}].derived.numerator`);
      const denominator = columnPart(measure.derived.denominator, measure.derived.denominatorAggregation, `measures[${index}].derived.denominator`);
      const scope = measure.scope?.map((p, at) => predicate(p, `measures[${index}].scope[${at}]`));
      const ref = measure.ref.startsWith('ratio:') ? `ratio:${numerator}/${denominator}` : measure.ref;
      // A measure divided by itself at the same grouping is 1 for every row.
      // "Share of all" means the denominator is the whole period: a name that
      // says so gets the overall denominator; anything else is sent back.
      let denominatorScope = measure.derived.denominatorScope;
      if (numerator === denominator && (measure.derived.numeratorAggregation ?? '') === (measure.derived.denominatorAggregation ?? '') && !denominatorScope) {
        const name = measure.alias ?? '';
        if (/(share|pct|percent|percentage|of_total|of_all|concentration|proportion)/i.test(name)) {
          denominatorScope = 'overall';
          provenanceNotes[`measures[${index}].denominatorScope`] = `host: ${name} divides ${numerator} by itself, so the denominator is the whole period`;
        } else {
          problems.push({ path: `measures[${index}].derived`, message: `${numerator} divided by itself is 1 for every row; a share of the whole period needs "denominatorScope": "overall", a rate needs a different denominator` });
        }
      }
      return { ...measure, ref, derived: { ...measure.derived, kind: 'ratio' as const, numerator, denominator, ...(denominatorScope ? { denominatorScope } : {}) }, ...(scope?.length ? { scope } : {}) };
    }
    // A change names two measures of THIS reading, so its ref is a name the
    // host minted, not a vocabulary id: there is nothing here to canonicalise.
    // The composer proves both aliases exist and refuses when they do not.
    if (measure.change) {
      const aliases = new Set(intent.measures.map((item) => item.alias).filter(Boolean));
      for (const part of [measure.change.base, measure.change.comparison]) {
        if (!aliases.has(part)) problems.push({ path: `measures[${index}].change`, message: `${part} is not the alias of any measure in this reading; give each period its own measure and alias it` });
      }
      return measure;
    }
    const ref = canonical(asMeasureRef(measure.ref, measure.aggregation), MEASURE_KINDS, `measures[${index}].ref`, (entry) =>
      entry.kind === 'column' && !measure.aggregation ? `${entry.ref} is a raw column; a column measure needs an aggregation` : undefined);
    const scope = measure.scope?.map((p, at) => predicate(p, `measures[${index}].scope[${at}]`));
    // A metric that already embodies a restriction ("drink_revenue" is
    // `case when is_drink_item ...`) does not need it repeated as a scope;
    // repeating it would push the measure off the semantic tier for nothing.
    const entry = vocabulary.get(ref);
    const embodied = (p: IntentPredicate) => {
      const column = (vocabulary.get(p.ref)?.name ?? p.ref.split('.').pop() ?? '').toLowerCase();
      const text = `${entry?.expr ?? ''} ${entry?.description ?? ''}`.toLowerCase();
      return Boolean(column) && (p.op === 'is_true' || p.op === 'eq') && text.includes(column);
    };
    const effective = scope?.filter((p) => !embodied(p));
    return { ...measure, ref, ...(effective?.length ? { scope: effective } : {}) };
  });
  // A time axis belongs to the measure's own model: an order total by the
  // order lines' time multiplies orders across lines. When the same-named
  // time dimension exists on the measure's model, rebind to it.
  const measureModels = new Set(measures.flatMap((measure) => measure.change ? [] : measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]).map((ref) => vocabulary.get(ref)?.model).filter((model): model is string => Boolean(model)));
  const rebindTime = (ref: string): string => {
    const entry = vocabulary.get(ref);
    if (!entry || !entry.roles.includes('time') || !entry.model || measureModels.size === 0 || measureModels.has(entry.model)) return ref;
    for (const model of measureModels) {
      const sibling = vocabulary.get(`dimension:${model}.${entry.name}`);
      if (sibling?.roles.includes('time')) return sibling.ref;
      // Otherwise the model's own time axis, when it has exactly one.
      const own = vocabulary.entries.filter((candidate) => candidate.kind === 'dimension' && candidate.model === model && candidate.roles.includes('time') && candidate.name !== 'metric_time');
      if (own.length === 1) return own[0]!.ref;
    }
    return ref;
  };
  // A CONCEPT IS DISCOVERY, NOT AN IDENTITY (A-005). "Customer" bound to a
  // person in Sales and a billing account in Finance must not be grouped by
  // whichever binding is locally convenient: a concept ref in a grouping,
  // display or filter becomes one material clarification listing the
  // bindings with their grain and domain, never a binding chosen here.
  const conceptClauses: IntentUnresolved[] = [];
  const conceptRef = (ref: string): VocabularyEntry | undefined => {
    const entry = vocabulary.get(ref) ?? vocabulary.resolve(ref, ['concept']);
    return entry?.kind === 'concept' ? entry : undefined;
  };
  const dropConcept = (ref: string, where: string): boolean => {
    const entry = conceptRef(ref);
    if (!entry) return false;
    const bindings = (entry.bindings ?? []).filter((binding) => vocabulary.get(binding.entityRef));
    if (!conceptClauses.some((clause) => clause.clause === entry.name)) {
      const described = (entry.bindings ?? []).map((binding) => `${binding.entityRef}${binding.grain ? ` (${binding.grain}${binding.domain ? `, ${binding.domain}` : ''})` : binding.domain ? ` (${binding.domain})` : ''}`).join(', ');
      // ONE BINDING IS NOT A CHOICE. Asking "which of them" with one option
      // stopped the question, and the SQL drafter handed that sentence as its
      // reason declined too. The concept still is not an identity (the binding
      // alone does not say WHICH rows are, say, policy holders), so the clause
      // stays material, with no options, and carries the concept's own
      // definition: the pipeline then asks the tables through a reviewable
      // AI-drafted statement before it says anything is not modeled.
      const definition = (entry.description ?? '').replace(/\s+/g, ' ').trim();
      conceptClauses.push(bindings.length > 1
        ? {
          clause: entry.name, material: true, options: bindings.map((binding) => binding.entityRef),
          question: `"${entry.name}" is a business concept known under several keys — ${described}. Which of them should this ${where} use?`,
        }
        : {
          clause: entry.name, material: true, options: [],
          question: `"${entry.name}" is a business concept${described ? ` bound to ${described}` : ''}${definition ? ` (${definition.slice(0, 240)})` : ''}; no governed field says which rows are ${entry.name.toLowerCase()} for this ${where}`,
        });
    }
    return true;
  };
  intent = {
    ...intent,
    groupBy: intent.groupBy.filter((group) => !dropConcept(group.ref, 'grouping')),
    display: intent.display.filter((ref) => !dropConcept(ref, 'display')),
    filters: intent.filters.filter((p) => !dropConcept(p.ref, 'filter')),
    unresolved: [...intent.unresolved, ...conceptClauses],
  };
  for (const clause of conceptClauses) intent.provenance[`concept:${clause.clause}`] = 'host:a concept names several keys; the binding is a choice, not a default';
  // A BREAKDOWN THE QUESTION DID NOT ASK FOR. "beverage revenue" is a total;
  // a reading that groups it by product answers a different question. When
  // the question carries no breakdown cue and names none of the grouping
  // fields, the grouping is sent back once; a question that says "by",
  // "top", "which", "compare" or names the field keeps it.
  // A certified block that breaks a measure down (its contract groups) named
  // as THE measure of a total question is the same over-reading in block
  // clothing: "beverage revenue" is not "beverage revenue by product".
  const groupingBlocks = intent.measures.flatMap((measure) => {
    const entry = vocabulary.get(measure.ref);
    return entry?.kind === 'block' && (entry.contract?.groupBy?.length ?? 0) > 0 ? [entry] : [];
  });
  if (question && !prior && (intent.groupBy.length > 0 || groupingBlocks.length > 0) && (intent.expectedShape === 'grouped' || intent.expectedShape === 'ranking')) {
    const cue = /\b(by|per|each|across|breakdown|break\s+down|split|top|bottom|rank|ranking|ranked|which|who|whose|list|compare|comparison|versus|vs|trend|over\s+time|monthly|weekly|daily|yearly|quarterly|annual|distribution|highest|lowest|most|least|best|worst|leaders?|leading)\b/i;
    const questionWords = new Set(normalizeVocabularyText(question).split(' ').filter(Boolean).flatMap((word) => [word, singularWord(word)]));
    const namesIt = (texts: Array<string | undefined>) => texts.some((text) => normalizeVocabularyText(text ?? '').split(' ').some((word) => word && (questionWords.has(word) || questionWords.has(singularWord(word)))));
    const named = intent.groupBy.some((group) => { const entry = vocabulary.get(group.ref); return namesIt([entry?.name, entry?.label, ...(entry?.aliases ?? [])]); })
      || groupingBlocks.some((block) => namesIt(block.contract?.groupBy ?? []));
    // A word the reading did not account for may be the breakdown itself,
    // misspelt or in the reader's own words ("scoring leaders", "bevereage
    // catogery"): the guard fires only when every word of the question is
    // spoken for by the measures, the restrictions and the period.
    const scalarIntent: AnalyticalIntentV1 = { ...intent, groupBy: [], display: [], expectedShape: 'scalar' };
    const leftover = unaccountedQuestionWords(question, scalarIntent, vocabulary).filter((word) => !FACET_STOPWORDS.has(word));
    if (!cue.test(question) && !named && leftover.length === 0) {
      const totals = groupingBlocks.flatMap((block) => (block.contract?.measures ?? []).slice(0, 1).flatMap((measure) => vocabulary.lookup(measure.output.replace(/_/g, ' '), { kinds: ['metric', 'measure'], limit: 2, minScore: 0.5 }).map((hit) => hit.entry.ref)));
      problems.push({
        path: groupingBlocks.length && intent.groupBy.length === 0 ? 'measures' : 'groupBy',
        message: `the question asks for a total, not a breakdown: it names no grouping and carries no breakdown word; ${groupingBlocks.length ? `${groupingBlocks.map((block) => block.ref).join(', ')} breaks the measure down by ${groupingBlocks.flatMap((block) => block.contract?.groupBy ?? []).join(', ')}, so read the total from its metric instead` : 'remove the grouping (groupBy: [], expectedShape: "scalar")'} unless the question itself asks for a breakdown`,
        ...(totals.length ? { suggestions: [...new Set(totals)] } : {}),
      });
    }
  }
  const groupBy = intent.groupBy.map((group, index) => ({
    ...group,
    ref: canonical(group.role === 'time' ? rebindTime(canonical(group.ref, GROUP_KINDS, `groupBy[${index}].ref`)) : group.ref, GROUP_KINDS, `groupBy[${index}].ref`, (entry) => {
      if (group.role === 'key' && entry.roles.includes('label')) return `${entry.ref} is a label; group by the entity key and put the label in display`;
      if (group.role === 'time' && !entry.roles.includes('time')) return `${entry.ref} is not a time dimension`;
      return undefined;
    }),
  }));
  // A time-axis problem suggests the DATE fields of the relations the measures
  // read, never the nearest name to the wrong field: "metric is not a time
  // dimension (authorized refs: metric_2, metric_x)" corrects nothing.
  for (const problem of problems) {
    if (!/is not a time dimension$/.test(problem.message)) continue;
    problem.suggestions = timeAxesFor(intent, vocabulary);
  }
  const display = intent.display.map((ref, index) => canonical(ref, DISPLAY_KINDS, `display[${index}]`));
  const filters = intent.filters.map((p, index) => predicate(p, `filters[${index}]`));
  const ordering = intent.ordering
    ? { ...intent.ordering, ref: /^measure:\d+$/.test(orderingRef(intent.ordering.ref)) ? orderingRef(intent.ordering.ref) : canonical(asMeasureRef(intent.ordering.ref), [...MEASURE_KINDS, ...GROUP_KINDS], 'ordering.ref') }
    : undefined;
  let time = intent.time?.ref ? { ...intent.time, ref: canonical(intent.time.ref, ['dimension', 'column'], 'time.ref', (entry) => entry.roles.includes('time') ? undefined : `${entry.ref} is not a time dimension`) } : intent.time;
  let windowDefault: string | undefined;
  if (time?.window && !time.ref) {
    // A window without an axis: the measures' own models decide. Exactly one
    // time dimension across them is the host's default (and is recorded as
    // such); none or several leaves the axis unset, and no tier may then
    // apply the window silently — each refuses instead.
    const axes = new Set<string>();
    for (const model of measureModels) {
      const own = vocabulary.entries.filter((candidate) => candidate.kind === 'dimension' && candidate.model === model && candidate.roles.includes('time') && candidate.name !== 'metric_time');
      if (own.length === 1) axes.add(own[0]!.ref);
      else own.forEach((candidate) => axes.add(candidate.ref));
    }
    if (axes.size === 1) {
      windowDefault = [...axes][0]!;
      time = { ...time, ref: windowDefault };
    }
  }
  const next: AnalyticalIntentV1 = { ...intent, measures, groupBy, display, filters, ...(ordering ? { ordering } : {}), ...(time ? { time } : {}), provenance: { ...intent.provenance, ...provenanceNotes } };
  if (windowDefault) next.provenance = { ...next.provenance, [windowDefault]: `host:time window "${time?.window?.expression ?? `${time?.window?.start}..${time?.window?.end}`}" bound to the measure's own time axis` };
  if (next.population === 'all') {
    // Every member of the grain: the grain must be an entity key with a
    // physical relation to enumerate, and never a time axis. The key is
    // rewritten to the entity's primary owner so the members come from the
    // entity's own relation, not from the fact that references it.
    const keys = next.groupBy.filter((group) => group.role === 'key');
    if (keys.length !== 1) problems.push({ path: 'groupBy', message: 'population "all" needs exactly one entity key in groupBy (role key): the members to include are that entity\'s' });
    else if (next.groupBy.some((group) => group.role === 'time')) problems.push({ path: 'groupBy', message: 'population "all" cannot be combined with a time axis; drop the time groupBy or the population' });
    else {
      const key = keys[0]!;
      const entry = vocabulary.get(key.ref);
      const primary = entry?.kind === 'entity' && entry.entityType !== 'primary'
        ? vocabulary.entries.find((candidate) => candidate.kind === 'entity' && candidate.name === entry.name && candidate.entityType === 'primary' && candidate.physical?.relation)
        : undefined;
      const owner = primary ?? entry;
      if (!owner?.physical?.relation) problems.push({ path: 'groupBy', message: `${key.ref} has no physical relation to enumerate every member from; population "all" needs an entity key with one`, suggestions: vocabulary.entries.filter((candidate) => candidate.kind === 'entity' && candidate.entityType === 'primary' && candidate.physical?.relation).slice(0, 6).map((candidate) => candidate.ref) });
      else if (primary && primary.ref !== key.ref) {
        next.groupBy = next.groupBy.map((group) => group === key ? { ...group, ref: primary.ref } : group);
        next.provenance = { ...next.provenance, [primary.ref]: `host:population "all" enumerates ${primary.ref} from its own relation (was ${key.ref})` };
      }
    }
  }
  if (next.kind === 'analytics' && next.measures.length === 0 && next.unresolved.every((clause) => !clause.material)) {
    problems.push({ path: 'measures', message: 'an analytics intent needs at least one measure ref, or a material unresolved clause explaining what is missing', suggestions: vocabulary.lookup('revenue', { kinds: ['metric', 'block'], limit: 4 }).map((hit) => hit.entry.ref) });
  }
  for (const group of next.groupBy) {
    if (group.role === 'time' && !group.grain) problems.push({ path: 'groupBy', message: `${group.ref} is a time axis and needs a grain` });
  }
  // "Not modeled" is a claim the host checks against the whole vocabulary.
  // A material clause with no options whose words name an authorized entry
  // is sent back with those entries: a numeric column with no metric is
  // still a measure with an aggregation, never a modeling gap.
  for (const clause of next.unresolved) {
    if (!clause.material || clause.options.length > 0 || clause.origin === 'ledger') continue;
    // A clause that asks WHY, or what we SHOULD do, is an operator Ask does not
    // perform, whatever metrics its words happen to name: the coverage proof
    // owns it as an unsupported gap, and sending it back as "is modeled"
    // would make the model re-litigate a question it cannot answer.
    if (clause.kind === 'unsupported' || causalOperatorsIn(clause.clause).length > 0) continue;
    const words = (clause.clause.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((word) => !CLAUSE_STOPWORDS.has(word));
    const hits = new Map<string, VocabularyEntry>();
    for (let i = 0; i < words.length; i += 1) {
      for (const phrase of [words.slice(i, i + 2).join(' '), words[i]!]) {
        for (const hit of vocabulary.lookup(phrase, { limit: 3, minScore: 0.85 })) {
          if (hit.matchedOn !== 'name' && hit.matchedOn !== 'alias') continue;
          if (hit.entry.kind === 'model' || hit.entry.kind === 'relation' || hit.entry.kind === 'entity') continue;
          hits.set(hit.entry.ref, hit.entry);
        }
      }
    }
    if (hits.size === 0) continue;
    const measureLike = [...hits.values()].filter((entry) => entry.kind === 'metric' || entry.kind === 'measure' || entry.kind === 'block' || (entry.kind === 'column' && entry.roles.includes('numeric')) || (entry.kind === 'dimension' && entry.roles.includes('numeric')));
    problems.push({
      path: 'unresolved',
      message: `"${clause.clause}" is modeled: ${[...hits.keys()].join(', ')}. ${measureLike.length ? `Use ${measureLike.map((entry) => entry.ref).join(' or ')} as a measure (a numeric column takes an aggregation such as sum) instead of reporting a gap.` : 'Use these refs instead of reporting a gap.'}`,
      suggestions: [...hits.keys()],
    });
  }
  // A follow-up keeps the previous period unless the message names one: an
  // edit of a 2017 ranking is still about 2017.
  if (prior?.time?.window && next.kind === 'analytics' && !next.time?.window && question !== undefined && !namesPeriod(question)) {
    next.time = { ...(next.time ?? {}), ...prior.time };
    next.provenance[`time:${prior.time.ref ?? 'window'}`] = 'inherited';
  }
  // A previous question that never ran left no executed analysis to edit: its
  // fields are carried as context, not as obligations the follow-up must keep
  // or drop one by one. The widening guard still holds a follow-up to its
  // restrictions; only this bookkeeping is skipped.
  for (const ref of options.priorExecuted === false ? [] : unaccountedInheritedRefs(prior, next)) {
    const entry = vocabulary.get(ref);
    const name = entry?.label ?? entry?.name ?? ref;
    problems.push({ path: 'provenance', message: `the previous analysis used ${name} [${ref}]; keep it (provenance "inherited") or list it as "removed:<why>"` });
  }
  // Display refs must not duplicate group-by refs; a key in display is harmless.
  const grouped = new Set(next.groupBy.map((group) => group.ref));
  next.display = next.display.filter((ref) => !grouped.has(ref));
  // A displayed label must belong to the grain. "Supply cost by product"
  // grouped by the product key with the supply NAME displayed is one row per
  // supply line, not per product: the display changed the grain silently.
  // The host replaces such a label with the grain entity's own label, or
  // drops it, and says so in the provenance.
  const grainModels = new Set<string>();
  for (const group of next.groupBy) {
    if (group.role !== 'key') continue;
    const entry = vocabulary.get(group.ref);
    if (!entry) continue;
    const column = entry.physical?.column ?? entry.name;
    const owners = vocabulary.entries.filter((candidate) => candidate.kind === 'entity' && candidate.model && candidate.roles.includes('key') && [candidate.physical?.column, candidate.name, `${candidate.name}_id`, ...candidate.aliases].includes(column));
    const primary = owners.find((candidate) => /primary/i.test(candidate.description ?? '') || candidate.aliases.includes('primary')) ?? (owners.length === 1 ? owners[0] : undefined);
    if (primary?.model) grainModels.add(primary.model);
    else if (entry.kind === 'entity' && entry.model) grainModels.add(entry.model);
    else if (entry.model && !/_id$/i.test(column)) grainModels.add(entry.model);
  }
  if (grainModels.size) {
    next.display = next.display.flatMap((ref) => {
      const entry = vocabulary.get(ref);
      if (!entry || entry.kind !== 'dimension' || !entry.model || grainModels.has(entry.model) || !entry.roles.includes('label')) return [ref];
      const replacement = [...grainModels].flatMap((model) => vocabulary.entries.filter((candidate) => candidate.kind === 'dimension' && candidate.model === model && candidate.roles.includes('label')))[0];
      next.provenance[ref] = `removed:${entry.name} is an attribute of ${entry.model}, finer than the grain ${[...grainModels].join('/')}${replacement ? `; displayed ${replacement.ref} instead` : ''}`;
      if (replacement && !next.display.includes(replacement.ref) && !grouped.has(replacement.ref)) {
        next.provenance[replacement.ref] = next.provenance[replacement.ref] ?? 'host:label of the grain';
        return [replacement.ref];
      }
      return [];
    });
    next.display = [...new Set(next.display)];
  }
  // A follow-up whose every content word already appears in the previous
  // analysis names nothing new. It is a correction of that analysis, never
  // a replacement of its measures: the interpreter is sent back once.
  if (prior && question && prior.measures.length && !next.measures.some((measure) => prior.measures.some((previous) => previous.ref === measure.ref))) {
    const priorText = normalizeVocabularyText([
      prior.reading, ...Object.values(prior.provenance), ...intentRefs(prior).flatMap((ref) => { const entry = vocabulary.get(ref); return [entry?.name, entry?.label, entry?.description, ...(entry?.aliases ?? [])]; }),
    ].filter(Boolean).join(' '));
    const priorWords = new Set(priorText.split(/\s+/).filter((word) => word.length > 2));
    const content = (question.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((word) => !FOLLOW_UP_STOPWORDS.has(word));
    // A word is known when it belongs to the previous analysis or is a
    // generic classifier word ("category", "breakdown"); both are matched
    // with spelling tolerance, so "bevereage catogery" still names nothing new.
    const near = (word: string, candidate: string) => word === candidate || trigramSimilarity(word, candidate) >= 0.6 || (word.length >= 5 && Math.abs(word.length - candidate.length) <= 2 && editDistance(word, candidate) <= 2);
    const known = (word: string) => [...priorWords].some((candidate) => near(word, candidate)) || FOLLOW_UP_GENERIC_WORDS.some((candidate) => near(word, candidate));
    if (content.length && content.every(known)) {
      followUpReplacement = `every word of this message (${content.join(', ')}) already belongs to the previous analysis, so it corrects that analysis rather than replacing it: keep the previous measures ${prior.measures.map((measure) => measure.ref).join(', ')}, grain, ranking and limit, and apply the correction to them (a scope, a display, a filter); ask one clarification only if two readings remain`;
      problems.push({ path: 'measures', message: followUpReplacement });
    }
  }
  return { intent: next, problems, ...(followUpReplacement ? { followUpReplacement } : {}) };
}

/** Plain Levenshtein distance, for misspellings trigrams miss (transpositions). */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[] = new Array(rows * cols).fill(0);
  for (let i = 0; i < rows; i += 1) table[i * cols] = i;
  for (let j = 0; j < cols; j += 1) table[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i * cols + j] = Math.min(table[(i - 1) * cols + j]! + 1, table[i * cols + j - 1]! + 1, table[(i - 1) * cols + j - 1]! + cost);
    }
  }
  return table[rows * cols - 1]!;
}

const CLAUSE_STOPWORDS = new Set(['the', 'and', 'for', 'per', 'each', 'with', 'from', 'that', 'this', 'what', 'which', 'how', 'many', 'much', 'total', 'show', 'give', 'list', 'top', 'all', 'any']);

/** Classifier words a correction may add without naming a new subject. */
const FOLLOW_UP_GENERIC_WORDS = ['category', 'categories', 'breakdown', 'group', 'groups', 'level', 'levels', 'kind', 'kinds'];
const FOLLOW_UP_STOPWORDS = new Set(['the', 'and', 'for', 'need', 'get', 'want', 'show', 'give', 'please', 'can', 'you', 'now', 'just', 'only', 'also', 'but', 'with', 'from', 'that', 'this', 'what', 'about', 'into', 'them', 'those', 'these', 'not', 'yes', 'okay', 'thanks', 'include', 'add', 'results', 'result', 'again', 'instead', 'actually', 'sorry', 'mean', 'meant']);

/**
 * A vocabulary entry whose NAME is a phrase of the question is the governed
 * default for that phrase. When the model asks which of several readings a
 * word means and exactly one option is named by that word, the question
 * already answered it: take that option, keep the note, stop asking.
 */
export function applyGovernedDefaults(intent: AnalyticalIntentV1, question: string, vocabulary: VocabularyIndex, options: { normalizeScopes?: boolean } = {}): void {
  const normalizedQuestion = ` ${normalizeVocabularyText(question)} `;
  // Words the question spends on the GRAIN ("customers" in "top customers")
  // name the thing being ranked, not a measure: a metric that happens to share
  // that name (a customer count) is never the governed default for it.
  const grainWords = new Set<string>();
  for (const group of intent.groupBy) {
    const entry = vocabulary.get(group.ref);
    for (const word of [entry?.name, entry?.label, entry?.model].map((value) => normalizeVocabularyText(value ?? '')).filter(Boolean)) {
      grainWords.add(word);
      grainWords.add(word.endsWith('s') ? word.slice(0, -1) : `${word}s`);
    }
  }
  for (const clause of intent.unresolved) {
    if (!clause.material) continue;
    // A material clause with at most one distinct option, already used by
    // the intent, is not an ambiguity: the interpreter is asking about
    // something the host proves (reachability, grain), not about meaning.
    // A clause with NO options is the opposite: nothing in the vocabulary
    // answers it, and it stays material so the turn ends as a named gap.
    const distinct = [...new Set(clause.options)];
    if (distinct.length === 1 && intentRefs(intent).includes(distinct[0]!)) {
      clause.material = false;
      clause.question = clause.question ? `${clause.question} (not asked: the host proves reachability and grain)` : undefined;
      continue;
    }
    if (clause.options.length < 2) continue;
    const namedBy = (ref: string) => {
      const entry = vocabulary.get(ref);
      if (!entry) return false;
      const names = [entry.name, entry.label ?? ''].map(normalizeVocabularyText).filter(Boolean);
      if (names.some((name) => grainWords.has(name))) return false;
      return names.some((name) => normalizedQuestion.includes(` ${name} `));
    };
    let named = clause.options.filter(namedBy);
    // CERTIFIED PRECEDENT. When the team certified a block that ranks the
    // same entity the question ranks, the measure that block orders by is
    // the governed reading of "top <entity>": the certification already
    // answered the question the interpreter is asking.
    if (named.length === 0 && intent.groupBy.some((group) => group.role === 'key')) {
      const grainEntities = intent.groupBy.filter((group) => group.role === 'key').map((group) => vocabulary.get(group.ref)).filter((entry): entry is VocabularyEntry => Boolean(entry));
      const grainNames = new Set(grainEntities.flatMap((entry) => [entry.name, entry.model ?? ''].map(normalizeVocabularyText)).filter(Boolean));
      const precedent = vocabulary.entries.filter((entry) => entry.kind === 'block' && entry.certified && entry.contract?.orderBy?.[0] && entry.contract.entities.some((name) => grainNames.has(normalizeVocabularyText(name)) || grainNames.has(normalizeVocabularyText(`${name}s`))));
      const orderedBy = new Set(precedent.map((entry) => normalizeVocabularyText(entry.contract!.orderBy![0]!.column)));
      const byPrecedent = clause.options.filter((ref) => {
        const entry = vocabulary.get(ref);
        return Boolean(entry && (orderedBy.has(normalizeVocabularyText(entry.name)) || orderedBy.has(normalizeVocabularyText(entry.physical?.column ?? ''))));
      });
      if (byPrecedent.length === 1) {
        named = byPrecedent;
        const block = precedent.find((entry) => normalizeVocabularyText(entry.contract!.orderBy![0]!.column) === normalizeVocabularyText(vocabulary.get(byPrecedent[0]!)?.name ?? ''))
          ?? precedent[0]!;
        intent.provenance[byPrecedent[0]!] = intent.provenance[byPrecedent[0]!] ?? `q:${clause.clause} (certified precedent ${block.ref})`;
      }
    }
    // The question may name a metric the model did not list among its options.
    if (named.length === 0) {
      const kinds = new Set(clause.options.map((ref) => vocabulary.get(ref)?.kind).filter(Boolean));
      named = vocabulary.entries.filter((entry) => (kinds.size === 0 || kinds.has(entry.kind)) && (entry.kind === 'metric' || entry.kind === 'measure') && namedBy(entry.ref)).map((entry) => entry.ref);
      if (named.length === 1) clause.options = [...new Set([...clause.options, named[0]!])];
    }
    if (named.length !== 1) continue;
    const chosen = named[0]!;
    clause.material = false;
    clause.question = `Read "${clause.clause}" as ${chosen} because the question names it; say "${clause.options.filter((ref) => ref !== chosen).map((ref) => vocabulary.get(ref)?.label ?? ref).join('" or "')}" for the other reading.`;
    intent.provenance[chosen] = intent.provenance[chosen] ?? `q:${clause.clause} (governed default)`;
    if (!intent.measures.some((measure) => measure.ref === chosen) && vocabulary.get(chosen)?.kind !== 'dimension') {
      const already = intent.measures.find((measure) => clause.options.includes(measure.ref));
      if (already) {
        // The measure the model wrote down is replaced by the governed
        // reading; everything that pointed at it (the ranking order, the
        // provenance) follows, or the answer would silently lose its sort.
        if (intent.ordering?.ref === already.ref) intent.ordering.ref = chosen;
        if (intent.provenance[already.ref] && !intent.provenance[chosen]) intent.provenance[chosen] = intent.provenance[already.ref]!;
        already.ref = chosen;
      } else intent.measures.push({ ref: chosen });
    }
  }
  keepMembersApart(intent, vocabulary);
  bindExactNames(intent, normalizedQuestion, grainWords, vocabulary);
  preferGovernedDefinition(intent, vocabulary);
  // Resolution may still ground literals or apply typed policy effects after
  // this helper returns. The pipeline defers scope lifting to its final
  // pre-prepare normalization; direct callers retain the historical default.
  if (options.normalizeScopes !== false) promoteSoleMeasureScope(intent);
  freezeSuperlativeShape(intent, question);
}

const SUPERLATIVE = /\b(most|best|highest|largest|greatest|lowest|worst|fewest|smallest|least|top|led)\b/i;
/** "Who ARE the top scorers", "which teamS": the question asks for a list. */
const PLURAL_SUBJECT = /\b(who|which|what)\s+(are|were|have)\b|\bwhich\s+[a-z]+s\b|\b(players|teams|customers|users|products|stores|people|ones|scorers|shooters|items|orders|accounts)\b/i;
/**
 * A count the question states outright: "top five", "ten players", "3 stores".
 * A THRESHOLD is not a count — "with at least 20 games" sizes the cohort, not
 * the answer, and reading it as a count is how "who had the best ratio" came
 * back as ten rows.
 */
const COUNT_WORD = /\b(top|first|bottom|last|best|worst)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b|(?<!\b(?:at least|at most|least|most|minimum|maximum|more than|fewer than|less than|over|under|above|below|with|min|max)\s)\b(\d+|two|three|four|five|six|seven|eight|nine|ten|twenty)\s+[a-z]+s\b/i;

/**
 * ONE QUESTION, ONE SHAPE. "Who scored the most points in 2017?" asks for the
 * one who did. The interpreter answers it with ten rows as readily as with
 * one, so the same question asked twice came back in two different shapes —
 * and a reader comparing them cannot tell whether the product changed its mind
 * about the data or only about the presentation. A singular superlative that
 * states no count of its own is therefore one row, decided here rather than
 * per dispatch. A plural subject ("who are the top scorers") and a stated
 * count ("top five") both leave the reading exactly as it was.
 */
export function freezeSuperlativeShape(intent: AnalyticalIntentV1, question: string): void {
  if (intent.kind !== 'analytics' || !intent.ordering || intent.limit === 1) return;
  if (!SUPERLATIVE.test(question) || PLURAL_SUBJECT.test(question) || COUNT_WORD.test(question)) return;
  if (!/\b(who|which|what)\b/i.test(question)) return;
  intent.limit = 1;
  intent.provenance.limit = 'host:the question asks which one, so the answer is one row';
}

const COLUMN_REF = /^column:(.+)\.([^.]+)$/;

/**
 * The single column an aggregate expression reads, seen through the scope a
 * governed definition may wrap it in: `CASE WHEN participated THEN "r"."points"
 * ELSE 0 END` reads `points`. An expression over more than one column has no
 * single column and is never matched.
 */
export function scopedColumnOf(expr: string): { column: string; scoped: boolean } | undefined {
  const wrapped = /^\s*case\s+when\s+(.+?)\s+then\s+(.+?)(?:\s+else\s+0)?\s+end\s*$/is.exec(expr);
  const core = (wrapped?.[2] ?? expr).trim().replace(/"/g, '');
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(core)) return undefined;
  return { column: core.split('.').pop()!, scoped: Boolean(wrapped) };
}

/**
 * A MEANING THE USER ALREADY PICKED. The clarification's options are refs, and
 * the pick is one of them: the reading that follows must carry it, whatever the
 * interpreter wrote. A selection that only reaches the prompt can be ignored by
 * the model, and the turn then asks the same question again.
 */
/**
 * A RESTRICTION THE READING IS UNSURE WHERE TO APPLY IS ASKED. When the
 * interpreter restricts one field with a value while listing other fields that
 * might hold it ("competitor is Splunk": TAGS or CUSTOM_FIELDS), it has guessed
 * where the value lives. Running the guess answers a different question with
 * the same confidence, so the clause becomes material and the user picks the
 * field. A clause the user just decided is never asked again.
 */
export function askWhichFieldHoldsTheRestriction(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, chosen?: string): void {
  if (intent.kind !== 'analytics' || intent.measures.length === 0) return;
  for (const clause of intent.unresolved) {
    if (clause.material || clause.origin === 'ledger' || clause.options.length < 2) continue;
    if (chosen && clause.options.includes(chosen)) continue;
    const fields = clause.options.map((ref) => vocabulary.get(ref));
    if (fields.some((entry) => !entry || !(FILTER_KINDS as readonly string[]).includes(entry.kind) || entry.roles.includes('time') || entry.roles.includes('measure'))) continue;
    const columns = new Set(fields.map((entry) => `${entry!.physical?.relation ?? entry!.model ?? ''}.${entry!.physical?.column ?? entry!.name}`.toLowerCase()));
    if (columns.size < 2) continue;
    const restricted = intent.filters.filter((filter) => clause.options.includes(filter.ref) && filter.values.some((value) => typeof value === 'string' && value.trim().length > 0));
    if (restricted.length !== 1) continue;
    const value = restricted[0]!.values.filter((item): item is string => typeof item === 'string').join(', ');
    clause.material = true;
    clause.question = `Which field holds "${value}" for "${clause.clause}": ${fields.map((entry) => entry!.label ?? entry!.name).join(' or ')}?`;
  }
}

export function applySelectedMeaning(intent: AnalyticalIntentV1, selection: { ref: string; label?: string }, vocabulary: VocabularyIndex): void {
  const entry = vocabulary.get(selection.ref);
  if (!entry || intent.kind !== 'analytics') return;
  let decided: IntentUnresolved | undefined;
  const movedFilters: IntentPredicate[] = [];
  for (const clause of intent.unresolved) {
    if (!clause.options.includes(selection.ref)) continue;
    clause.material = false;
    clause.question = `Read "${clause.clause}" as ${entry.label ?? entry.name}: you chose it.`;
    decided = clause;
    // The options of that clause were alternatives: the ones the user did not
    // pick stop restricting the reading, or the answer keeps the basis they
    // rejected beside the one they chose.
    const rejected = clause.options.filter((option) => option !== selection.ref);
    movedFilters.push(...intent.filters.filter((filter) => rejected.includes(filter.ref)));
    intent.filters = intent.filters.filter((filter) => !rejected.includes(filter.ref));
    intent.groupBy = intent.groupBy.filter((group) => !rejected.includes(group.ref));
    for (const measure of intent.measures) if (measure.scope?.length) measure.scope = measure.scope.filter((scope) => !rejected.includes(scope.ref));
  }
  // A PERIOD BASIS is not a breakdown. Choosing the date a period is measured
  // on rebinds the period to it — with the year the clause names — and never
  // adds a time grouping the question did not ask for.
  if (decided && entry.roles.includes('time')) {
    const year = /\b(19|20)\d{2}\b/.exec(`${decided.clause} ${decided.question ?? ''}`)?.[0];
    intent.time = {
      ref: selection.ref,
      ...(intent.time?.grain ? { grain: intent.time.grain } : {}),
      ...(year ? { window: { start: `${year}-01-01`, end: `${Number(year) + 1}-01-01`, expression: decided.clause } } : intent.time?.window ? { window: intent.time.window } : {}),
    };
    intent.provenance[selection.ref] = 'clarification:the period basis you chose';
    return;
  }
  // A RESTRICTION MOVES WITH THE CHOICE. When the options were the fields a
  // value might live in, the chosen field takes the restriction the rejected
  // one carried; it does not become a breakdown.
  if (decided && movedFilters.length > 0 && (entry.kind === 'column' || entry.kind === 'dimension') && !entry.roles.includes('measure')) {
    for (const filter of movedFilters) {
      const duplicate = intent.filters.some((existing) => existing.ref === selection.ref && existing.op === filter.op && JSON.stringify(existing.values) === JSON.stringify(filter.values));
      if (!duplicate) intent.filters.push({ ...filter, ref: selection.ref, source: 'clarification' });
    }
    intent.provenance[selection.ref] = 'clarification:the field you chose holds the restriction';
    return;
  }
  const used = intentRefs(intent);
  if (used.includes(selection.ref)) return;
  intent.provenance[selection.ref] = intent.provenance[selection.ref] ?? 'clarification:the meaning you chose';
  if (entry.roles.includes('measure') || entry.kind === 'metric' || entry.kind === 'measure') {
    intent.measures.push({ ref: selection.ref });
    if (!intent.ordering && intent.expectedShape === 'ranking') intent.ordering = { ref: selection.ref, direction: 'desc' };
    if (intent.expectedShape === 'ranking' && intent.limit === undefined) intent.limit = 10;
    return;
  }
  if (entry.kind === 'dimension' || entry.kind === 'entity' || entry.kind === 'column') {
    intent.groupBy.push({ ref: selection.ref, role: entry.roles.includes('key') ? 'key' : entry.roles.includes('time') ? 'time' : 'categorical' });
  }
}

/**
 * THE PROJECT'S DEFINITION WINS OVER THE RAW COLUMN. A measure written as an
 * aggregation of a physical column is replaced by the governed metric that
 * defines exactly that aggregate of that column on that relation. This matters
 * beyond tidiness: a fact table keeps rows its definitions exclude (a player
 * who did not play, a cancelled order), so counting the column itself answers a
 * different question with the same confidence. A scoped definition says so in
 * the reading. Nothing happens when the project declares no such metric, or
 * declares several.
 */
export function preferGovernedDefinition(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): void {
  const governedFor = (ref: string, aggregation: string | undefined): VocabularyEntry | undefined => {
    const match = COLUMN_REF.exec(ref);
    if (!match || !aggregation) return undefined;
    const [, relation, column] = match;
    const found = vocabulary.entries.filter((entry) => {
      if (entry.kind !== 'metric' && entry.kind !== 'measure') return false;
      if (entry.derived || entry.engineOnly || !entry.physical || entry.physical.relation !== relation) return false;
      if ((entry.physical.aggregate ?? '') !== aggregation) return false;
      const read = scopedColumnOf(entry.physical.expr ?? entry.physical.column ?? '');
      return read?.column.toLowerCase() === column!.toLowerCase();
    });
    return found.length === 1 ? found[0] : undefined;
  };
  const rewrite = (ref: string, aggregation: string | undefined, alias: string | undefined): { ref: string; drops: boolean } => {
    const target = governedFor(ref, aggregation);
    if (!target || intentRefs(intent).includes(target.ref)) return { ref, drops: false };
    intent.provenance[target.ref] = `${intent.provenance[ref] ?? `q:${target.name}`} (governed default: ${target.label ?? target.name} defines this column)`;
    delete intent.provenance[ref];
    if (intent.ordering?.ref === ref) intent.ordering.ref = target.ref;
    const read = scopedColumnOf(target.physical!.expr ?? '');
    if (read?.scoped) {
      const note = `${alias ?? target.label ?? target.name} is the governed ${target.label ?? target.name}, which counts only the rows its definition includes`;
      if (!intent.reading.includes(note)) intent.reading = `${intent.reading.replace(/[.\s]+$/, '')}; ${note}.`;
    }
    return { ref: target.ref, drops: true };
  };
  for (const measure of intent.measures) {
    if (measure.derived) {
      const numerator = rewrite(measure.derived.numerator, measure.derived.numeratorAggregation, measure.alias);
      const denominator = rewrite(measure.derived.denominator, measure.derived.denominatorAggregation, measure.alias);
      measure.derived.numerator = numerator.ref;
      measure.derived.denominator = denominator.ref;
      if (numerator.drops) delete measure.derived.numeratorAggregation;
      if (denominator.drops) delete measure.derived.denominatorAggregation;
      if (measure.ref.startsWith('ratio:')) measure.ref = `ratio:${measure.derived.numerator}/${measure.derived.denominator}`;
      continue;
    }
    const bound = rewrite(measure.ref, measure.aggregation, measure.alias);
    if (!bound.drops) continue;
    measure.ref = bound.ref;
    delete measure.aggregation;
  }
}

/**
 * A MATCH THAT COVERS SEVERAL MEMBERS KEEPS THEM APART.
 *
 * "Curry's performance" is two players in this data, and a text match with no
 * grouping adds them together: one row, 3,002 points, belonging to nobody. A
 * partial or multi-valued match on a label therefore groups by that member's
 * key (and displays the label), so each member the filter caught is its own
 * row and the reader can see which ones were caught.
 */
export function keepMembersApart(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): void {
  if (intent.kind !== 'analytics' || intent.groupBy.some((group) => group.role === 'key')) return;
  const broad = intent.filters.find((filter) => {
    if (filter.on === 'aggregate') return false;
    const multiple = filter.op === 'contains' || (filter.op === 'in' && filter.values.length > 1);
    if (!multiple || !filter.values.some((value) => typeof value === 'string')) return false;
    const entry = vocabulary.get(filter.ref);
    return Boolean(entry && (entry.kind === 'dimension' || entry.kind === 'column') && !entry.roles.includes('time') && !entry.roles.includes('numeric') && !entry.roles.includes('boolean'));
  });
  if (!broad) return;
  const entry = vocabulary.get(broad.ref)!;
  if (intent.groupBy.some((group) => group.ref === broad.ref)) return;
  const relation = entry.physical?.relation ?? entry.model;
  const stem = (entry.physical?.column ?? entry.name).replace(/_(name|label|title|description)$/i, '');
  // The key of the same thing on the same relation, when the project has one.
  const key = vocabulary.entries.find((candidate) =>
    (candidate.kind === 'dimension' || candidate.kind === 'column' || candidate.kind === 'entity')
    && (candidate.physical?.relation ?? candidate.model) === relation
    && [`${stem}_id`, `${stem}_key`, `${stem}id`].includes((candidate.physical?.column ?? candidate.name).toLowerCase()));
  const grouped = key ?? entry;
  intent.groupBy.push({ ref: grouped.ref, role: key ? 'key' : 'categorical' });
  if (key && !intent.display.includes(entry.ref)) intent.display.push(entry.ref);
  intent.provenance[grouped.ref] = `host: ${JSON.stringify(String(broad.values[0]))} can match several members, so each one is its own row`;
  const note = `${entry.label ?? entry.name} matched by text can cover several members; each one is a row of its own`;
  if (!intent.reading.includes('several members')) intent.reading = `${intent.reading.replace(/[.\s]+$/, '')}; ${note}.`;
}

/** Words that qualify a money measure away from its plain named reading. */
const MEASURE_QUALIFIERS = ['gross', 'including', 'incl', 'tax', 'after tax', 'net', 'order total', 'lifetime', 'ltv'];

/**
 * THE NAME WINS. A question word that exactly names a metric ("revenue")
 * means that metric, unless the question qualifies it ("gross", "including
 * tax", "order total"). A confidently chosen sibling (order_total for
 * "how much revenue do we have") is replaced by the named metric and the
 * provenance says so. Nothing happens when the question names no metric,
 * names several, or already names the chosen one.
 */
export function bindExactNames(intent: AnalyticalIntentV1, normalizedQuestion: string, grainWords: Set<string>, vocabulary: VocabularyIndex): void {
  if (MEASURE_QUALIFIERS.some((qualifier) => normalizedQuestion.includes(` ${qualifier} `))) return;
  const namesOf = (entry: VocabularyEntry) => [entry.name, entry.label ?? '', ...entry.aliases].map(normalizeVocabularyText).filter((name) => name && !grainWords.has(name));
  const namedByQuestion = (entry: VocabularyEntry | undefined) => Boolean(entry && namesOf(entry).some((name) => normalizedQuestion.includes(` ${name} `)));
  // A word that names an entity or a model ("customers") is the thing being
  // measured, never the measure, whether or not the intent groups by it.
  const entityWords = new Set<string>();
  for (const entry of vocabulary.entries) {
    for (const word of [entry.kind === 'entity' ? entry.name : '', entry.kind === 'entity' ? entry.label ?? '' : '', entry.model ?? ''].map((value) => normalizeVocabularyText(value)).filter(Boolean)) {
      entityWords.add(word);
      entityWords.add(word.endsWith('s') ? word.slice(0, -1) : `${word}s`);
    }
  }
  const exactByName = (entry: VocabularyEntry) => {
    const name = normalizeVocabularyText(entry.name);
    return normalizedQuestion.includes(` ${name} `) && !grainWords.has(name) && !entityWords.has(name);
  };
  // A metric outranks a measure of the same name (the metric wraps it).
  const namedMetrics = vocabulary.entries.filter((entry) => entry.kind === 'metric' && exactByName(entry));
  const named = namedMetrics.length ? namedMetrics : vocabulary.entries.filter((entry) => entry.kind === 'measure' && exactByName(entry));
  if (named.length !== 1) return;
  const target = named[0]!;
  // A ratio, derived or windowed metric names a formula, not a base measure:
  // the interpreter's period-versus-lifetime reading of it stands (rule 5b).
  if (target.derived || target.engineOnly || (target.metricType && target.metricType !== 'simple')) return;
  const used = new Set(intentRefs(intent));
  if (used.has(target.ref)) return;
  // The word is spent when the chosen measure's own name carries it:
  // "beverage revenue" read as drink_revenue has used "revenue".
  const targetWords = normalizeVocabularyText(target.name).split(' ').filter(Boolean);
  const absorbs = (entry: VocabularyEntry) => {
    const words = new Set(namesOf(entry).flatMap((name) => name.split(' ')));
    return targetWords.every((word) => words.has(word));
  };
  // The period's own relation outranks the name. "Total points" in a CALENDAR
  // question is the fact dated by that calendar, not the season rollup of the
  // same name: rebinding the measure off the relation that carries the window
  // leaves a reading no engine can compose, or a different population.
  // The period may be a window, or a date restriction written on the measures
  // themselves ("points in 2016" and "points in 2017" as two scoped measures).
  const datePredicate = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])]
    .find((predicate) => vocabulary.get(predicate.ref)?.roles.includes('time'));
  const timeRelation = (intent.time?.window && intent.time.ref ? vocabulary.get(intent.time.ref)?.physical?.relation : undefined)
    ?? (datePredicate ? vocabulary.get(datePredicate.ref)?.physical?.relation : undefined);
  const rebind = (ref: string): string => {
    const entry = vocabulary.get(ref);
    if (!entry || (entry.kind !== 'metric' && entry.kind !== 'measure') || namedByQuestion(entry) || absorbs(entry)) return ref;
    // ... unless the named metric carries a date of its own: then the period
    // follows it there (an order line's revenue has the order line's date), and
    // only a metric with no time axis at all would strand the window.
    const targetHasOwnTime = Boolean(target.physical?.relation) && vocabulary.entries.some((candidate) =>
      candidate.kind === 'dimension' && candidate.roles.includes('time') && (candidate.physical?.relation ?? candidate.model) === target.physical!.relation);
    if (timeRelation && entry.physical?.relation === timeRelation && target.physical?.relation !== timeRelation && !targetHasOwnTime) return ref;
    intent.provenance[target.ref] = `${intent.provenance[ref] ?? `q:${target.name}`} (governed default: the question names the metric "${target.name}")`;
    // The reading line stays honest about what was measured.
    const measuredAs = `measured as ${target.label ?? target.name} because the question names the metric "${target.name}"`;
    if (!intent.reading.includes(measuredAs)) intent.reading = `${intent.reading.replace(/[.\s]+$/, '')}; ${measuredAs}.`;
    if (intent.ordering?.ref === ref) intent.ordering.ref = target.ref;
    return target.ref;
  };
  for (const measure of intent.measures) {
    if (measure.derived) {
      measure.derived.numerator = rebind(measure.derived.numerator);
      measure.derived.denominator = rebind(measure.derived.denominator);
      if (measure.ref.startsWith('ratio:')) measure.ref = `ratio:${measure.derived.numerator}/${measure.derived.denominator}`;
      continue;
    }
    measure.ref = rebind(measure.ref);
  }
}

/**
 * A restriction on the only measure restricts the population: "beverage
 * revenue by product" lists the products that sold beverages, not every
 * product with a zero. The numbers are the same either way; the rows are
 * not. An explicit `population: 'all'` keeps the zeros; a ratio keeps its
 * parts' scopes because each part restricts its own aggregate.
 */
/** Predicate identity keeps type and operator semantics intact. Sets are order
 * independent; range bounds and ordered operators are deliberately not. */
function normalizedPredicateKey(predicate: IntentPredicate): string {
  const value = (item: string | number | boolean) => `${typeof item}:${String(item)}`;
  const values = predicate.op === 'in' || predicate.op === 'not_in'
    ? [...new Set(predicate.values.map(value))].sort((left, right) => left.localeCompare(right))
    : predicate.values.map(value);
  return JSON.stringify([predicate.ref, predicate.op, values, predicate.on ?? null]);
}

/**
 * Final scope normalization runs after grounding and policy effects, when all
 * transformations are visible. A calculated output is not a reason to leave
 * a shared year/member restriction attached to every base metric: walk its
 * dependency graph to the measures it actually reads, then lift only a
 * predicate each leaf carries. Cycles and unknown aliases are intentionally
 * left untouched rather than guessed through.
 */
export function normalizeEffectiveIntent(intent: AnalyticalIntentV1): void {
  if (intent.kind !== 'analytics' || intent.population === 'all' || intent.measures.length === 0) return;
  const byAlias = new Map<string, number>();
  const byRef = new Map<string, number[]>();
  for (const [index, measure] of intent.measures.entries()) {
    if (measure.alias) byAlias.set(measure.alias, index);
    const indices = byRef.get(measure.ref) ?? [];
    indices.push(index);
    byRef.set(measure.ref, indices);
  }
  type LeafWalk = { leaves: number[]; complete: boolean };
  const leaves = (index: number, visiting = new Set<number>()): LeafWalk => {
    if (visiting.has(index)) return { leaves: [], complete: false };
    const measure = intent.measures[index];
    if (!measure) return { leaves: [], complete: false };
    const next = new Set(visiting).add(index);
    if (measure.change) {
      const children = [byAlias.get(measure.change.base), byAlias.get(measure.change.comparison)];
      if (children.some((child) => child === undefined)) return { leaves: [], complete: false };
      const walked = children.map((child) => leaves(child!, next));
      return { leaves: walked.flatMap((child) => child.leaves), complete: walked.every((child) => child.complete) };
    }
    if (measure.derived) {
      const children = [measure.derived.numerator, measure.derived.denominator]
        .flatMap((ref) => (byRef.get(ref) ?? []).filter((child) => child !== index))
        .map((child) => leaves(child, next));
      const nonstandardScopes = measure.derived as unknown as { numeratorScope?: unknown; denominatorScope?: unknown };
      if (nonstandardScopes.numeratorScope !== undefined || nonstandardScopes.denominatorScope !== undefined) {
        if (JSON.stringify(nonstandardScopes.numeratorScope) !== JSON.stringify(nonstandardScopes.denominatorScope)) return { leaves: [], complete: false };
      }
      // A ratio can be the only declared measure. Its own scope is then the
      // only concrete scope to normalize; its ratio parts remain separate
      // when they have different scopes in explicitly declared measures.
      return children.length
        ? { leaves: children.flatMap((child) => child.leaves), complete: children.every((child) => child.complete) }
        : { leaves: [index], complete: true };
    }
    return { leaves: [index], complete: true };
  };
  const walked = intent.measures.map((_, index) => leaves(index));
  // A graph with a cycle, a missing comparison alias, or a non-equivalent
  // embedded ratio scope has no proven common leaf set. Leave every scope as
  // written rather than widening the population through a partial graph.
  if (!walked.every((result) => result.complete)) return;
  const leafIndexes = [...new Set(walked.flatMap((result) => result.leaves))];
  if (leafIndexes.length === 0) return;
  const first = intent.measures[leafIndexes[0]!]?.scope ?? [];
  if (first.length === 0) return;
  const shared = first.filter((predicate) => {
    const key = normalizedPredicateKey(predicate);
    return leafIndexes.every((index) => (intent.measures[index]?.scope ?? []).some((other) => normalizedPredicateKey(other) === key));
  });
  if (shared.length === 0) return;
  const sharedKeys = new Set(shared.map(normalizedPredicateKey));
  for (const index of leafIndexes) {
    const measure = intent.measures[index]!;
    const rest = (measure.scope ?? []).filter((predicate) => !sharedKeys.has(normalizedPredicateKey(predicate)));
    if (rest.length) measure.scope = rest;
    else delete measure.scope;
  }
  const existing = new Set(intent.filters.map(normalizedPredicateKey));
  for (const predicate of shared) {
    if (!existing.has(normalizedPredicateKey(predicate))) intent.filters.push(predicate);
    const filterKey = `filter:${predicate.ref}`;
    if (!intent.provenance[filterKey]) {
      const hasCalculatedOutput = intent.measures.some((measure) => measure.change || measure.derived);
      if (!hasCalculatedOutput) {
        // Retain the longstanding plain-measure receipts. They remain exact:
        // one scoped measure defines the population, while a shared scope
        // across plain measures defines the population those measures share.
        intent.provenance[filterKey] = leafIndexes.length === 1
          ? `host:the restriction on the only measure (${intent.measures[leafIndexes[0]!]!.ref}) restricts the population`
          : 'host:a restriction every measure carries restricts the population';
      } else {
        const reads = leafIndexes.map((index) => intent.measures[index]!.alias ?? intent.measures[index]!.ref).join(', ');
        intent.provenance[filterKey] = `host:the same restriction applies to every underlying measure (${reads})`;
      }
    }
  }
}

/** Backward-compatible name used by callers and existing plans. */
export function promoteSoleMeasureScope(intent: AnalyticalIntentV1): void {
  normalizeEffectiveIntent(intent);
}

/**
 * Question words that name a vocabulary entry the intent does not use. Not a
 * refusal (the interpreter may have read them correctly as prose) but a
 * warning the reader sees beside the answer: "the question said beverage;
 * this reading does not use anything named beverage".
 */
const IDENTIFIER_TOKENS = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;

/** Column-like identifiers (`is_drink_item`) a vocabulary entry's own text names. */
function definitionIdentifiers(entry: VocabularyEntry): string[] {
  const text = [entry.description ?? '', entry.expr ?? '', entry.physical?.expr ?? '', ...(entry.columns ?? []), ...(entry.contract?.staticScope ?? []).map((scope) => scope.column)].join(' ').toLowerCase();
  return [...new Set(text.match(IDENTIFIER_TOKENS) ?? [])];
}

// Coverage statements are trust claims, so a metric description is not proof
// that it enforced a facet. These are the SQL/control words that can occur in
// a definition without naming a business field. Everything else is extracted
// as the leaf of a qualified identifier (`schema.table.participated` becomes
// `participated`) and is evidence only when it belongs to a measure the
// reading actually used.
const EXPRESSION_KEYWORDS = new Set([
  'and', 'as', 'asc', 'avg', 'by', 'case', 'cast', 'coalesce', 'count', 'date',
  'desc', 'distinct', 'else', 'end', 'false', 'from', 'in', 'is', 'max', 'min',
  'not', 'null', 'nullif', 'or', 'over', 'partition', 'sum', 'then', 'true',
  'when', 'where', 'window',
]);
const SQL_IDENTIFIER_PATH = /(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))*/g;

/** Leaf field tokens from an authored/compiled measure expression, never its prose description. */
function expressionFacetTokens(expression: string | undefined): string[] {
  if (!expression) return [];
  const tokens = new Set<string>();
  for (const match of expression.matchAll(SQL_IDENTIFIER_PATH)) {
    const leaf = match[0]!.split(/\s*\.\s*/).at(-1)!.replace(/^"|"$/g, '').replace(/""/g, '"');
    for (const word of normalizeVocabularyText(leaf).split(' ')) {
      if (word.length > 1 && !EXPRESSION_KEYWORDS.has(word)) tokens.add(word);
    }
  }
  return [...tokens];
}

/**
 * Facets a used measure structurally embodies. A physical expression is the
 * relational compiler's bound definition; a stored-column lineage entry is
 * dbt provenance for that one output column. Neither source lets free-form
 * descriptions discharge a question restriction.
 */
function embodiedMeasureFacetTokens(entry: VocabularyEntry, vocabulary: VocabularyIndex): string[] {
  const tokens = new Set<string>([
    ...expressionFacetTokens(entry.expr),
    ...expressionFacetTokens(entry.physical?.expr),
    ...(entry.contract?.staticScope ?? []).flatMap((scope) => expressionFacetTokens(scope.column)),
  ]);
  const relation = entry.physical?.relation;
  const column = entry.physical?.column ?? lastColumnOf(entry.physical?.expr ?? entry.expr);
  const lineage = relation && column
    ? vocabulary.get(`relation:${relation}`)?.columnLineage?.[column.toLowerCase()] ?? []
    : [];
  for (const upstream of lineage) for (const token of expressionFacetTokens(upstream)) tokens.add(token);
  return [...tokens];
}

/** The column a simple aggregate reads: `SUM("s"."t"."wins")` → wins; a formula over several columns names none. */
function lastColumnOf(expr: string | undefined): string | undefined {
  if (!expr) return undefined;
  const inner = /^\s*(?:sum|avg|min|max|count|count_distinct)\s*\(\s*(?:distinct\s+)?([^()]+?)\s*\)\s*$/i.exec(expr)?.[1] ?? expr.trim();
  const match = /^(?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)*"?([A-Za-z_][A-Za-z0-9_]*)"?$/.exec(inner.trim());
  return match?.[1];
}

/** The date fields a time breakdown of these measures could use: those on the measures' own relations first, then any. */
export function timeAxesFor(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string[] {
  const relationOf = (entry: VocabularyEntry | undefined) => (entry?.physical?.relation ?? entry?.model ?? '').replace(/"/g, '').toLowerCase();
  const measureRelations = new Set(intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]).map((ref) => relationOf(vocabulary.get(ref) ?? vocabulary.resolve(ref))).filter(Boolean));
  const dated = vocabulary.entries.filter((entry) => (entry.kind === 'dimension' || entry.kind === 'column') && entry.roles.includes('time'));
  const own = dated.filter((entry) => measureRelations.has(relationOf(entry)));
  return [...new Set([...own, ...dated].map((entry) => entry.ref))].slice(0, 6);
}

export function uncoveredQuestionTerms(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string[] {
  const used = new Set(intentRefs(intent));
  const usedIdentifiers = new Set([...used].flatMap((ref) => {
    const entry = vocabulary.get(ref);
    if (!entry) return [];
    // LINEAGE: the column a used measure reads is computed, upstream in dbt,
    // from other columns (`wins` = SUM(CASE WHEN team_won …) in the season
    // model). Those identifiers are what the question may have named — for
    // THAT column only, never for every column the model touches.
    const relation = (entry.physical?.relation ?? (entry.kind === 'column' ? ref.slice(ref.indexOf(':') + 1).split('.').slice(0, -1).join('.') : entry.model) ?? '').replace(/"/g, '');
    const column = (entry.physical?.column ?? (entry.kind === 'column' ? entry.name : lastColumnOf(entry.physical?.expr ?? entry.expr)) ?? '').replace(/"/g, '').toLowerCase();
    const lineage = relation && column ? vocabulary.get(`relation:${relation}`)?.columnLineage?.[column] ?? [] : [];
    return [entry.name.toLowerCase(), ...(entry.physical?.column ? [entry.physical.column.toLowerCase()] : []), ...definitionIdentifiers(entry), ...lineage.map((item) => item.toLowerCase())];
  }));
  // The reading's own names count: a measure aliased `losses` over
  // SUM(team_lost) is the losses the question asked for.
  const aliases = intent.measures.flatMap((measure) => [measure.alias ?? '', measure.change?.base ?? '']).filter(Boolean);
  const usedText = [...[...used].map((ref) => `${ref} ${vocabulary.get(ref)?.name ?? ''} ${vocabulary.get(ref)?.label ?? ''} ${(vocabulary.get(ref)?.aliases ?? []).join(' ')} ${vocabulary.get(ref)?.description ?? ''}`), ...aliases].join(' ').toLowerCase();
  const out: string[] = [];
  for (const word of new Set(question.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])) {
    if (['what', 'which', 'show', 'give', 'list', 'have', 'with', 'from', 'that', 'this', 'each', 'many', 'much', 'total', 'both', 'need', 'please', 'could', 'would', 'should', 'about', 'their', 'there', 'than', 'then', 'into', 'over', 'category', 'product', 'products', 'customer', 'customers'].includes(word)) continue;
    const hits = vocabulary.lookup(word, { limit: 3, minScore: 0.97 }).filter((hit) => hit.matchedOn === 'name' || hit.matchedOn === 'alias');
    if (!hits.length) continue;
    const stem = word.replace(/s$/, '');
    if (usedText.includes(stem)) continue;
    if (hits.some((hit) => used.has(hit.entry.ref))) continue;
    // SATISFIED THROUGH LINEAGE: a column the used measure's own expression
    // embodies (`wins` = SUM(CASE WHEN team_won THEN 1 ELSE 0 END)) is what
    // the question named, under the metric's name.
    if (usedIdentifiers.has(word) || usedIdentifiers.has(stem)) continue;
    if (hits.some((hit) => { const column = hit.entry.physical?.column?.toLowerCase(); return Boolean(column && usedIdentifiers.has(column)); })) continue;
    // A business term or block is covered when its own definition names a
    // column the used measures embody ("beverage": filter on is_drink_item;
    // drink_revenue's expression is a case on is_drink_item).
    if (hits.some((hit) => (hit.entry.kind === 'term' || hit.entry.kind === 'block') && definitionIdentifiers(hit.entry).some((identifier) => usedIdentifiers.has(identifier)))) continue;
    out.push(word);
  }
  return out;
}

/**
 * What an uncovered word means. A word the question RESTRICTS on ("where
 * team_won = true", "with at least", "only home games") names a condition
 * the reading did not apply: UNSATISFIED. A word merely mentioned is a
 * lexical miss and nothing more: UNCERTAIN — it may be covered under
 * another name, and it is reported as a question, not as a dropped clause.
 */
export function coverageStates(question: string, uncovered: string[]): Array<{ word: string; state: 'unsatisfied' | 'uncertain' }> {
  const text = question.toLowerCase();
  return uncovered.map((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const restricts = new RegExp(`\\b(where|with|only|having|among|excluding|without|whose|when|if)\\s+(?:\\w+\\s+){0,3}${escaped}\\b|\\b${escaped}\\s*(=|==|!=|<>|>=|<=|>|<|\\bis\\b|\\bequals?\\b|\\b(?:true|false)\\b)`, 'i');
    return { word, state: restricts.test(text) ? 'unsatisfied' : 'uncertain' };
  });
}

/** Question words that match nothing exactly, with the nearest vocabulary: the deterministic pre-lookup. */
export function spellingHints(question: string, vocabulary: VocabularyIndex): string[] {
  const hints: string[] = [];
  for (const word of new Set(question.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])) {
    const exact = vocabulary.lookup(word, { limit: 1, minScore: 0.97 });
    if (exact.length) continue;
    const near = vocabulary.lookup(word, { limit: 3, minScore: 0.55 }).filter((hit) => hit.matchedOn === 'fuzzy');
    if (near.length) hints.push(`"${word}" ~ ${near.map((hit) => `${hit.entry.ref}${hit.entry.label ? ` (${hit.entry.label})` : ''}`).join(', ')}`);
  }
  return hints;
}

/**
 * The correction re-ask is THE DISCOVERY PATH, step two: the one bounded
 * same-snapshot expansion. A suggested ref the first cards had no room for
 * is sent back WITH its card, so the model reads the object rather than a
 * bare identifier it has never seen.
 */
/** The re-ask after retrieval: the entries the clause's words name, and how a count, an amount and a status read from raw columns. */
function expansionMessage(clauses: string[], cards: string[]): string {
  return [
    `You left ${clauses.map((clause) => `"${clause}"`).join(', ')} unresolved. These entries exist, are authorized, and were not shown before:`,
    ...cards,
    'Read the clauses with them and resend the complete JSON object. Rules: a COUNT of things is `column:<relation>.<key column>` with aggregation count (a count of opportunities is the count of the opportunity key); an AMOUNT is its numeric column with aggregation sum; the rows that count ("lost", "won", "open") are a `scope` predicate on the outcome, stage or status column with the value as the question says it — the host grounds the stored value; a date breakdown is a groupBy with role time on the relation\'s date column; a fiscal period is a filter on the fiscal column when one exists. Keep unresolved ONLY what these entries do not cover.',
  ].join('\n');
}

function correctionMessage(problems: IntentProblem[], cardFor?: (ref: string) => string | undefined): string {
  const unseen = new Map<string, string>();
  for (const ref of problems.flatMap((problem) => problem.suggestions ?? [])) {
    if (unseen.has(ref)) continue;
    const card = cardFor?.(ref);
    if (card) unseen.set(ref, card);
  }
  return [
    'Your intent had problems. Fix ONLY these and resend the complete JSON object:',
    ...problems.map((problem) => `- ${problem.path}: ${problem.message}${problem.suggestions?.length ? ` (authorized refs: ${problem.suggestions.join(', ')})` : ''}`),
    ...(unseen.size ? ['Entries you were not shown before (they exist and are authorized):', ...unseen.values()] : []),
  ].join('\n');
}

/**
 * Measures under one time window must share a time role: each metric
 * aggregates over its own time dimension (a customer count over the first
 * order date, revenue over the order date), and "in 2025" means different
 * things for them. One role is bound as the window's axis (and said so);
 * several become one bounded clarification, unless the question already
 * named the axis itself. Never applied silently.
 */
export function proveTimeRoles(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): void {
  if (!intent.time?.window) return;
  const label = (ref: string) => vocabulary.get(ref)?.label ?? vocabulary.get(ref)?.name ?? ref;
  // A time role is a time MEANING: the same-named dimension on two models
  // (an order date on orders and on order lines) is one role, represented
  // by the first measure's ref.
  const roleName = (ref: string) => vocabulary.get(ref)?.name ?? ref.split('.').pop() ?? ref;
  const roles = new Map<string, string[]>();
  const representative = new Map<string, string>();
  for (const measure of intent.measures) {
    for (const ref of measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]) {
      const role = vocabulary.get(ref)?.timeRef;
      if (!role) continue;
      const name = roleName(role);
      if (!representative.has(name)) representative.set(name, role);
      roles.set(representative.get(name)!, [...(roles.get(representative.get(name)!) ?? []), label(ref)]);
    }
  }
  if (roles.size === 0) return;
  const expression = intent.time.window.expression ?? `${intent.time.window.start}..${intent.time.window.end}`;
  const current = intent.time.ref;
  const hostChosen = Boolean(current && (intent.provenance[current] ?? '').startsWith('host:'));
  const explicit = Boolean(current && !hostChosen && vocabulary.get(current)?.name !== 'metric_time');
  if (roles.size === 1) {
    const [role] = [...roles.keys()] as [string];
    // An axis with the same meaning (same name on another model) already there stays.
    if (current && roleName(current) === roleName(role) && vocabulary.get(current)?.name !== 'metric_time') return;
    if (!explicit && current !== role) {
      intent.time = { ...intent.time, ref: role };
      intent.provenance = { ...intent.provenance, [role]: `host:time window "${expression}" applied on the measures' time role ${label(role)}` };
    }
    return;
  }
  if (explicit) {
    intent.provenance = { ...intent.provenance, [current!]: `${intent.provenance[current!] ?? 'q:time'}; host:time window "${expression}" applies on ${label(current!)} to every measure (their own time roles differ: ${[...roles.entries()].map(([role, names]) => `${label(role)} for ${names.join(', ')}`).join('; ')})` };
    return;
  }
  if (intent.unresolved.some((clause) => clause.options.some((option) => roles.has(option)))) return;
  if (hostChosen && current) {
    delete intent.provenance[current];
    intent.time = { ...intent.time, ref: undefined };
  }
  intent.unresolved.push({
    clause: expression,
    options: [...roles.keys()],
    material: true,
    question: `"${expression}" means a different time for these measures: ${[...roles.entries()].map(([role, names]) => `${label(role)} (${names.join(', ')})`).join(' or ')}. Which time should the window apply to?`,
  });
}

const CAUSAL_OPERATORS = ['why', 'because', 'driver', 'drivers', 'reason', 'reasons', 'invest', 'investment', 'recommend', 'recommendation', 'recommendations', 'should', 'decide', 'decision', 'forecast', 'predict', 'prediction', 'projection'];

const PREDICTIVE_PHRASES = [/\blikely to\b/, /\blikelihood\b/, /\bprobability of\b/, /\bchances? (?:of|to|that)\b/, /\bnext (?:season|year|quarter|month|week|game)\b/, /\bgoing to (?!be (?:the )?(?:top|best))\w+/, /\bwill (?:get|be|win|lose|score|churn|leave|buy)\b/];

/** The forecast phrases a question carries ("most likely to", "next season", "will churn"). */
export function predictiveOperatorsIn(question: string): string[] {
  const text = normalizeVocabularyText(question);
  return PREDICTIVE_PHRASES.map((pattern) => pattern.exec(text)?.[0]).filter((phrase): phrase is string => Boolean(phrase));
}

/** The causal or decision words a question carries (why, drivers, should, invest...). */
export function causalOperatorsIn(question: string): string[] {
  const words = normalizeVocabularyText(question).split(' ').filter(Boolean);
  return CAUSAL_OPERATORS.filter((word) => words.includes(word));
}
const BREAKDOWN_STOP = new Set(['day', 'week', 'month', 'quarter', 'year', 'date', 'time', 'period', 'each', 'the', 'total', 'far', 'now', 'default', 'itself', 'category', 'type', 'name']);

/**
 * FULL-QUESTION APPLICABILITY. A question that asks WHY, or what to DO, asks
 * for an operation Ask does not perform on governed data; a breakdown "by
 * <noun>" that nothing in the intent or the vocabulary accounts for asks for
 * a model the project does not have. Either is a material clause: the turn
 * ends as a named gap and nothing executes, instead of an adjacent trend
 * being served as the answer.
 */
export function proveClauseCoverage(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): void {
  if (intent.kind !== 'analytics') return;
  if (intent.unresolved.some((clause) => clause.material)) return;
  const words = normalizeVocabularyText(question).split(' ').filter(Boolean);
  const operators = causalOperatorsIn(question);
  if (operators.length > 0) {
    intent.unresolved.push({
      clause: operators.join(', '),
      options: [],
      material: true,
      kind: 'unsupported',
      question: `Explaining why something happened or recommending what to do (${operators.join(', ')}) is not something Ask computes from governed data; Research can investigate the drivers.`,
    });
  }
  // A breakdown the interpreter dropped: "by <noun>" with no categorical or
  // key grouping standing for it (a time grouping cannot stand for "region").
  // A GROUPING MUST STAND FOR THE BREAKDOWN IT IS READ AS. "By sales region"
  // grouped by a tags field is not a breakdown by region: the head noun of the
  // phrase has to be accounted for by the grouping field itself. When nothing
  // in the project is named for it, the breakdown is not modeled, whatever
  // field the reading chose instead.
  const categorical = intent.groupBy.filter((group) => group.role !== 'time');
  if (categorical.length > 0) {
    const groupingWords = new Set<string>();
    for (const group of categorical) {
      const entry = vocabulary.get(group.ref);
      for (const text of [entry?.name, entry?.label, entry?.model, ...(entry?.aliases ?? []), entry?.description ?? '', group.ref]) {
        for (const word of normalizeVocabularyText(text ?? '').split(' ')) if (word) { groupingWords.add(word); groupingWords.add(singularWord(word)); }
      }
    }
    const PHRASE_STOP = new Set(['for', 'in', 'and', 'or', 'where', 'with', 'during', 'over', 'from', 'of', 'to', 'than', 'vs', 'versus', 'against', 'the', 'a', 'an', 'on', 'at', 'since', 'between', 'last', 'this', 'each']);
    for (const match of question.toLowerCase().matchAll(/\b(?:by|per|across|for each)\s+([a-z][a-z_]*(?:\s+[a-z][a-z_]*){0,2})/g)) {
      const words: string[] = [];
      for (const word of match[1]!.split(/\s+/)) { if (PHRASE_STOP.has(word)) break; words.push(word); }
      const noun = words[words.length - 1];
      if (!noun || BREAKDOWN_STOP.has(noun)) continue;
      if (groupingWords.has(noun) || groupingWords.has(singularWord(noun))) continue;
      if (vocabulary.lookup(noun, { limit: 1, minScore: 0.55 }).length > 0) continue;
      // The reading answers with a stand-in: the rows are delivered, and the
      // answer says plainly that nothing is named for the breakdown and which
      // field stood in for it, so the reader judges the substitution.
      const phrase = words.join(' ');
      const standIn = categorical.map((group) => vocabulary.get(group.ref)?.label ?? vocabulary.get(group.ref)?.name ?? group.ref.split('.').pop()).join(', ');
      intent.unresolved.push({ clause: `by ${phrase}`, options: [], material: false, kind: 'not_modeled', question: `Nothing in this project is named "${phrase}"; the answer is broken down by ${standIn} in its place.` });
      return;
    }
  }
  if (!intent.groupBy.some((group) => group.role !== 'time')) {
    const unaccounted = new Set(unaccountedQuestionWords(question, intent, vocabulary));
    for (const match of question.toLowerCase().matchAll(/\b(?:by|per|across|for each)\s+([a-z][a-z_]+)/g)) {
      const noun = match[1]!;
      if (BREAKDOWN_STOP.has(noun) || !unaccounted.has(noun) && !unaccounted.has(noun.replace(/s$/, ''))) continue;
      if (vocabulary.lookup(noun, { limit: 1, minScore: 0.55 }).length > 0) continue;
      intent.unresolved.push({ clause: `by ${noun}`, options: [], material: true, kind: 'not_modeled', question: `This project has no "${noun}" to break the answer down by.` });
      return;
    }
  }
}

/** An intent whose only content is what it left unresolved. */
function isBareIntent(intent: AnalyticalIntentV1): boolean {
  return intent.measures.length === 0 && intent.groupBy.length === 0 && intent.display.length === 0 && intent.filters.length === 0 && !intent.time && !intent.ordering && !intent.limit;
}

const QUESTION_STOPWORDS = new Set([...CLAUSE_STOPWORDS, ...FOLLOW_UP_STOPWORDS, 'our', 'overall', 'whats', 'does', 'did', 'are', 'was', 'were', 'have', 'has', 'much', 'many', 'number', 'amount', 'sum', 'total', 'totals', 'please', 'tell', 'find', 'out', 'like', 'would']);

/**
 * Question words neither a stopword nor part of any ref the intent uses
 * (name, label, alias, description words): what the intent has not
 * accounted for.
 */
const YEAR_WORD = /^(?:19|20)\d{2}$/;
const PERIOD_WORDS = /\b(?:(?:19|20)\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|today|yesterday|week|month|quarter|year|season|ytd|mtd|qtd|all[- ]time|lifetime|overall|ever|since|until|before|after|between|last|past|recent|latest|current|this|now)\b/i;
/** Whether a message names a period of its own (a year, a month, a relative window, "all time"). */
export function namesPeriod(question: string): boolean {
  return PERIOD_WORDS.test(question);
}

/** The years a question names that the intent's window, filters or scopes do not account for. */
export function droppedYears(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string[] {
  return unaccountedQuestionWords(question, intent, vocabulary).filter((word) => YEAR_WORD.test(word));
}

const GRAIN_OF_WORD: Record<string, string> = { day: 'day', daily: 'day', week: 'week', weekly: 'week', month: 'month', monthly: 'month', quarter: 'quarter', quarterly: 'quarter' };

/** A breakdown grain the question asks for ("by month", "monthly", "weekly") that the reading carries no time grouping for. */
export function droppedGrain(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string | undefined {
  if (intent.groupBy.some((group) => group.role === 'time' && group.grain)) return undefined;
  const unaccounted = unaccountedQuestionWords(question, intent, vocabulary);
  // A named period is not automatically a requested breakdown. "Current
  // versus previous month" needs two scalar period branches; treating the
  // word "month" as "by month" blocks the comparison before semantic
  // preparation. Require the grammar that actually asks for a series.
  const breakdown = /\b(?:by|per|each)\s+(day|week|month|quarter)\b|\b(daily|weekly|monthly|quarterly)\b/i.exec(question);
  const word = (breakdown?.[1] ?? breakdown?.[2])?.toLowerCase();
  if (!word || !unaccounted.includes(word)) return undefined;
  return word ? GRAIN_OF_WORD[word] : undefined;
}

/**
 * The words an intent accounts for: its refs' names, labels, aliases and
 * descriptions, its grains, its window and its filter values. With
 * `blockThroughContract`, a block accounts only for its own contract (name,
 * outputs, measures), never for its description or examples: "closest
 * available" is not accounting for a question.
 */
export function coveredWords(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, options: { blockThroughContract?: boolean } = {}): Set<string> {
  const covered = new Set<string>();
  for (const ref of intentRefs(intent)) {
    const entry = vocabulary.get(ref);
    const texts = options.blockThroughContract && entry?.kind === 'block'
      ? [entry.name, ...(entry.contract?.outputs ?? []), ...(entry.contract?.measures.map((measure) => measure.output) ?? [])]
      : [entry?.name, entry?.label, entry?.model, ...(entry?.aliases ?? []), entry?.description ?? '', ref];
    for (const text of texts) {
      for (const word of normalizeVocabularyText(text ?? '').split(' ')) if (word) { covered.add(word); covered.add(singularWord(word)); }
    }
  }
  const GRAIN_WORDS: Record<string, string[]> = { day: ['day', 'daily'], week: ['week', 'weekly'], month: ['month', 'monthly'], quarter: ['quarter', 'quarterly'], year: ['year', 'yearly', 'annual', 'annually'] };
  for (const grain of [...intent.groupBy.map((group) => group.grain), intent.time?.grain]) for (const word of GRAIN_WORDS[grain ?? ''] ?? []) covered.add(word);
  if (intent.time?.window) {
    for (const word of normalizeVocabularyText(intent.time.window.expression ?? '').split(' ')) if (word) covered.add(word);
    const start = Number(intent.time.window.start.slice(0, 4));
    const end = Number(intent.time.window.end.slice(0, 4));
    for (let year = start; year <= end; year += 1) covered.add(String(year));
  }
  for (const predicate of [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])]) {
    for (const value of predicate.values) for (const word of normalizeVocabularyText(String(value)).split(' ')) if (word) covered.add(word);
  }
  // A measure's aggregation accounts for the word that asked for it: "count"
  // in "lost opportunities count" is the count of the opportunity key.
  const AGGREGATION_WORDS: Record<string, string[]> = { count: ['count', 'counts', 'number'], count_distinct: ['count', 'counts', 'number', 'distinct', 'unique'], sum: ['sum', 'total', 'totals'], avg: ['average', 'avg', 'mean'], min: ['minimum', 'min', 'lowest', 'earliest'], max: ['maximum', 'max', 'highest', 'latest'], median: ['median'] };
  for (const measure of intent.measures) for (const word of AGGREGATION_WORDS[measure.aggregation ?? ''] ?? []) covered.add(word);
  return covered;
}

export function unaccountedQuestionWords(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string[] {
  const covered = coveredWords(intent, vocabulary);
  const out: string[] = [];
  for (const word of normalizeVocabularyText(question).split(' ')) {
    // A year is a clause of its own; other numbers are not words.
    if (word.length < 3 || QUESTION_STOPWORDS.has(word) || (/^\d+$/.test(word) && !YEAR_WORD.test(word))) continue;
    if (covered.has(word) || covered.has(singularWord(word))) continue;
    out.push(word);
  }
  return [...new Set(out)];
}

const singularWord = (word: string): string => word.replace(/ies$/, 'y').replace(/(ses|xes|shes|ches)$/, (m) => m.slice(0, -2)).replace(/s$/, '');

const CLAUSE_WORDS = (text: string) => (normalizeVocabularyText(text).split(' ').filter((word) => word.length > 2 && !QUESTION_STOPWORDS.has(word)));

/** The obligations of the original question, from its first analytics reading. */
/**
 * What a follow-up quietly stopped restricting. "Add rebounds for those same
 * players" after a top-ten ranking of 2017 is still those ten players: a
 * reading that keeps the measures but loses the period, the threshold, the
 * ranking or the limit has answered a different, larger question. The words
 * that ask for the wider population ("all", "every", "overall") make it the
 * user's choice instead.
 */
const CALENDAR_WORDS = /\b(calendar\d*|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|quarter|month(?:ly)?|week(?:ly)?|day|daily)\b/i;
/**
 * The basis a period is measured on is part of its meaning. "Calendar 2017"
 * is the dates 2017-01-01 to 2017-12-31; a season, fiscal or cohort field
 * that happens to hold 2017 is a different population, and a repo's
 * description of that field is advisory text the reader never sees. When a
 * question asks for a calendar period and the reading restricts a field with
 * no date role instead, this names the date dimensions that would honour it.
 */
export function calendarBasisProblem(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): { field: string; dates: string[]; measuresAt: string[]; fieldsAt: string[] } | undefined {
  if (intent.kind !== 'analytics' || !CALENDAR_WORDS.test(question)) return undefined;
  const yearish = (values: unknown[]) => values.some((value) => /^(?:19|20)\d{2}$/.test(String(value)));
  const restrictions = [
    ...intent.filters.filter((filter) => filter.on !== 'aggregate' && !/^measure:\d+$/.test(filter.ref)),
    ...intent.measures.flatMap((measure) => measure.scope ?? []),
  ];
  const offending = restrictions.find((predicate) => {
    const entry = vocabulary.resolve(predicate.ref);
    return entry && !entry.roles.includes('time') && yearish(predicate.values);
  });
  const timeRef = intent.time?.ref ? vocabulary.resolve(intent.time.ref) : undefined;
  const field = offending?.ref ?? (timeRef && !timeRef.roles.includes('time') ? intent.time!.ref! : undefined);
  if (!field) return undefined;
  const dated = (kind: 'dimension' | 'column') => vocabulary.entries.filter((entry) => entry.kind === kind && entry.roles.includes('time')).map((entry) => entry.ref);
  const dimensions = dated('dimension');
  const dates = (dimensions.length ? dimensions : dated('column')).slice(0, 6);
  // The measures must live where the date lives: the numeric columns of each
  // date's relation are what a calendar reading aggregates.
  const relations = new Set(dates.map((ref) => vocabulary.get(ref)?.physical?.relation).filter((relation): relation is string => Boolean(relation)));
  // The measures the reading took from elsewhere, matched to the date
  // relation's own columns by name; then the rest of that relation's columns.
  const measureRefs = intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]);
  const matched = [...relations].flatMap((relation) => suggestSameGrainColumns(vocabulary, measureRefs, relation)).map((item) => `${item.to} (${item.aggregation}, for ${item.from})`);
  const rest = vocabulary.entries
    .filter((entry) => entry.kind === 'column' && relations.has(entry.physical?.relation ?? entry.model ?? '') && !entry.roles.includes('time') && !entry.roles.includes('label'))
    .map((entry) => entry.ref);
  const measuresAt = [...matched, ...rest.filter((ref) => !matched.some((item) => item.startsWith(ref)))].slice(0, 14);
  // The identity and the restrictions must move with the measures: a player
  // dimension defined on the season table cannot group a game-dated metric.
  const fields = [...intent.groupBy.map((group) => group.ref), ...intent.display, ...intent.filters.filter((filter) => filter.on !== 'aggregate').map((filter) => filter.ref)];
  const fieldsAt = [...relations].flatMap((relation) => suggestSameRelationFields(vocabulary, fields, relation)).map((item) => `${item.to} (for ${item.from})`).slice(0, 8);
  return { field, dates, measuresAt, fieldsAt };
}

const RELATIVE_PERIOD = /\b(?:this|current|present|ongoing|latest|most recent)\s+(season|year|month|quarter|week|period)\b|\b(?:year to date|ytd)\b|\bso far this\s+(season|year|month|quarter)\b/i;

/**
 * A RELATIVE PERIOD IS A POPULATION, NOT A COLUMN. "this season", "the current
 * quarter" names one anchor every row must share. A project whose period is a
 * stored value (a source season, a fiscal label) has no mapping from today's
 * date to that value, and the latest value present in a snapshot is a
 * different claim from the current one. A reading that answers by SELECTING
 * the period beside each row (the maximum season per player) restricts
 * nothing: every row keeps its own anchor and the answer covers all history at
 * full confidence.
 */
export function relativePeriodProblem(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): { phrase: string; unit: string; fields: string[] } | undefined {
  if (intent.kind !== 'analytics') return undefined;
  const match = RELATIVE_PERIOD.exec(question);
  if (!match) return undefined;
  const unit = (match[1] ?? match[2] ?? 'period').toLowerCase();
  // The calendar defines a day, a week, a month, a quarter and a year, so a
  // window resolves those. It defines no season, no fiscal period and no
  // campaign: a window invented for one of those is world knowledge, not this
  // project's — and it silently answers for dates the project never described.
  const CALENDAR_UNITS = new Set(['day', 'week', 'month', 'quarter', 'year']);
  if (intent.time?.window && CALENDAR_UNITS.has(unit)) return undefined;
  const names = (entry: VocabularyEntry | undefined) => normalizeVocabularyText(`${entry?.name ?? ''} ${entry?.label ?? ''}`).split(' ');
  const periodish = (ref: string) => {
    const entry = vocabulary.resolve(ref);
    return Boolean(entry && (entry.roles.includes('time') || names(entry).includes(unit)));
  };
  const restricts = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])]
    .filter((predicate) => predicate.on !== 'aggregate' && !/^measure:\d+$/.test(predicate.ref));
  // A period the question did not name is an anchor the reading invented: the
  // project holds no mapping from today to a stored season, so "2025" here
  // came from nowhere and returns no rows (or the wrong ones) with full
  // confidence. Only a value the question itself carries discharges this.
  const asked = normalizeVocabularyText(question).split(' ');
  const named = (predicate: { values: unknown[] }) => predicate.values.some((value) => asked.includes(normalizeVocabularyText(String(value))));
  if (restricts.some((predicate) => periodish(predicate.ref) && named(predicate))) return undefined;
  const fields = vocabulary.entries
    .filter((entry) => (entry.kind === 'dimension' || entry.kind === 'column') && (entry.roles.includes('time') || names(entry).includes(unit)))
    .map((entry) => entry.ref).slice(0, 6);
  return { phrase: match[0], unit, fields };
}

const CHANGE_WORDS = /\b(percentage change|percent change|change|changed|difference|growth|grew|increase|increased|decrease|decreased|improve|improved|improvement|decline|declined|drop|dropped|fell|rose)\b/i;

/**
 * THE OUTPUT THE QUESTION ASKED FOR. "Show the percentage change" is a column,
 * not a turn of phrase: a reading that returns the two totals and says it shows
 * the change has claimed something nothing computed. A time breakdown answers
 * "how did it change" on its own, and a measure whose own name carries the word
 * (a growth metric) has already accounted for it; anything else owes a change
 * measure.
 */
export function droppedChange(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string | undefined {
  if (intent.kind !== 'analytics' || intent.measures.length === 0) return undefined;
  if (intent.measures.some((measure) => measure.change)) return undefined;
  if (intent.groupBy.some((group) => group.role === 'time' && group.grain)) return undefined;
  const unaccounted = unaccountedQuestionWords(question, intent, vocabulary);
  const asked = unaccounted.find((word) => CHANGE_WORDS.test(word));
  if (!asked) return undefined;
  // Two measures to compare, or nothing to subtract.
  const comparable = intent.measures.filter((measure) => measure.alias && !measure.derived && !measure.change);
  return comparable.length >= 2 ? asked : undefined;
}

const FACET_LIST = /\b(?:including|include|includes|covering|along with|as well as)\b\s+(.{3,160})$/i;
const FACET_STOPWORDS = new Set(['his', 'her', 'their', 'its', 'our', 'my', 'your', 'the', 'a', 'an', 'and', 'or', 'also', 'other', 'any', 'all', 'each', 'every', 'some', 'please', 'data', 'details', 'detail', 'information', 'info', 'stats', 'numbers', 'only', 'just', 'rows', 'row', 'records', 'record', 'values', 'value', 'include', 'including', 'with', 'from', 'for', 'that', 'this', 'those', 'these']);

/**
 * EACH FACET THE QUESTION LISTED IS ANSWERED OR NAMED. "A complete profile of
 * X, including his career, teams and achievements" is three requests; a table
 * of season points answers one of them, and calling that a complete profile is
 * the claim that does the damage. A facet counts as carried when a ref the
 * reading uses is named for it, or a used measure's bound expression/static
 * scope or dbt lineage structurally embodies it. A description that happens to
 * mention a word is not the same as an output that answers or restricts it.
 */
/** A crude stem: "participating", "participated" and "participation" are one word to a coverage check. */
export function facetStem(word: string): string {
  const base = singularWord(word.toLowerCase());
  return base.replace(/(ation|ating|ated|ings?|ers?|ed|es|ly)$/, '').replace(/(.)\1$/, '$1') || base;
}

/**
 * The parts a question listed that the executed reading carries nothing for.
 * A part is covered by any ref the reading uses (name, label, alias), a used
 * measure's structurally bound definition or lineage, a restriction a POLICY
 * added for it, by a concept whose name or synonyms say it, or by a grain —
 * compared by stem, so a requirement spelled "participating" is met by a
 * filter or measure definition on "participated".
 */
export function unmetFacets(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, options: { policyTexts?: string[] } = {}): string[] {
  if (intent.kind !== 'analytics' || intent.measures.length === 0) return [];
  const tail = FACET_LIST.exec(question)?.[1];
  if (!tail) return [];
  const named = new Set<string>();
  const add = (text: string | undefined) => { for (const word of normalizeVocabularyText(text ?? '').split(' ')) if (word) { named.add(word); named.add(singularWord(word)); named.add(facetStem(word)); } };
  for (const ref of intentRefs(intent)) {
    const entry = vocabulary.get(ref);
    for (const text of [entry?.name, entry?.label, ...(entry?.aliases ?? [])]) add(text);
  }
  // Definitions count only for measures the reading uses. This is narrowly
  // stronger than the name check above: accepted evidence is the bound
  // expression/static scope or dbt lineage, never a metric description.
  const measureRefs = new Set<string>();
  for (const measure of intent.measures) {
    if (measure.change) continue;
    if (measure.derived) {
      measureRefs.add(measure.derived.numerator);
      measureRefs.add(measure.derived.denominator);
    } else measureRefs.add(measure.ref);
  }
  for (const ref of measureRefs) {
    const entry = vocabulary.get(ref);
    if (!entry) continue;
    for (const token of embodiedMeasureFacetTokens(entry, vocabulary)) add(token);
  }
  for (const text of options.policyTexts ?? []) add(text);
  for (const entry of vocabulary.entries) if (entry.kind === 'concept') { add(entry.name); for (const alias of entry.aliases) add(alias); }
  for (const grain of [...intent.groupBy.map((group) => group.grain), intent.time?.grain]) if (grain) named.add(grain);
  const facets = tail.split(/,| and | plus /i).map((facet) => facet.trim().replace(/[.?!]+$/, '')).filter(Boolean);
  const unmet: string[] = [];
  for (const facet of facets) {
    const words = normalizeVocabularyText(facet).split(' ').filter((word) => word.length > 2 && !FACET_STOPWORDS.has(word));
    if (words.length === 0) continue;
    if (words.every((word) => named.has(word) || named.has(singularWord(word)) || named.has(facetStem(word)))) continue;
    unmet.push(facet);
  }
  return unmet.slice(0, 4);
}

export function widenedPopulation(question: string, intent: AnalyticalIntentV1, prior: AnalyticalIntentV1 | undefined): string[] {
  if (!prior || intent.kind !== 'analytics' || prior.kind !== 'analytics') return [];
  if (/\b(all|every|overall|entire|whole|any)\b/i.test(question)) return [];
  const removed = (ref: string) => (intent.provenance[ref] ?? '').startsWith('removed');
  const priorMeasures = prior.measures.map((measure) => measure.ref);
  // A message that names a new subject drops the prior measures on purpose;
  // the provenance rule already holds it to account for them.
  if (priorMeasures.length > 0 && priorMeasures.every((ref) => removed(ref))) return [];
  const restricted = new Set([
    ...intent.filters.map((filter) => filter.ref),
    ...intent.measures.flatMap((measure) => (measure.scope ?? []).map((scope) => scope.ref)),
    ...(intent.time?.ref ? [intent.time.ref] : []),
  ]);
  // A message that adds a restriction of its own ("what about Ryan Byrd")
  // asks a DIFFERENT question, not a wider one; only a reading that restricts
  // strictly less than the analysis it edits has widened.
  const priorRestricted = new Set([
    ...prior.filters.map((filter) => filter.ref),
    ...prior.measures.flatMap((measure) => (measure.scope ?? []).map((scope) => scope.ref)),
    ...(prior.time?.ref ? [prior.time.ref] : []),
  ]);
  if ([...restricted].some((ref) => !priorRestricted.has(ref))) return [];
  const lost: string[] = [];
  for (const filter of prior.filters) {
    if (filter.on === 'aggregate') { if (!intent.filters.some((next) => next.on === 'aggregate')) lost.push(`the threshold "${filter.ref} ${filter.op} ${filter.values.join(', ')}"`); continue; }
    if (!restricted.has(filter.ref) && !removed(filter.ref)) lost.push(`the restriction on ${filter.ref}`);
  }
  // A period may be written as a window, or as date restrictions on the
  // measures themselves — "July revenue and August revenue" restricts the same
  // axis twice. Only a reading that restricts that axis NOWHERE has widened.
  const restrictsPriorAxis = prior.time?.ref
    ? [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])].some((predicate) => predicate.ref === prior.time!.ref)
    : false;
  if (prior.time?.window && !intent.time?.window && !restrictsPriorAxis) lost.push('the period');
  if (prior.limit !== undefined && intent.limit === undefined) lost.push(`the limit of ${prior.limit}`);
  if (prior.ordering && !intent.ordering) lost.push('the ranking');
  return lost;
}

/**
 * The words of a clause that name a thing rather than a measurement, when the
 * clause asks WHICH ones ("which teams he played for", "list the products").
 * Those words are answered by identities, and a measure of the same name
 * ("teams played" as a count) does not answer them.
 */
const IDENTITY_ASK = /\b(which|who|whom|whose|list|name)\b/i;
export function identityClauseWords(clause: string, vocabulary: VocabularyIndex): string[] {
  if (!IDENTITY_ASK.test(clause) || /\bhow many\b/i.test(clause)) return [];
  const identities = new Set<string>();
  for (const entry of vocabulary.entries) {
    if (entry.kind !== 'entity' && entry.kind !== 'dimension' && entry.kind !== 'model' && entry.kind !== 'relation') continue;
    for (const name of [entry.name, entry.label ?? '', ...entry.aliases]) {
      const word = normalizeVocabularyText(name);
      if (word && !word.includes(' ')) { identities.add(word); identities.add(singularWord(word)); }
    }
  }
  return [...new Set(CLAUSE_WORDS(clause).filter((word) => identities.has(word) || identities.has(singularWord(word))))];
}

export function buildLedger(question: string, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): IntentLedger {
  const time = intent.groupBy.find((group) => group.role === 'time' && group.grain);
  return {
    clauses: intent.unresolved.filter((clause) => clause.material).map((clause) => {
      const roleWords = identityClauseWords(clause.clause, vocabulary);
      return { clause: clause.clause, ...(clause.kind ? { kind: clause.kind } : {}), ...(clause.question ? { question: clause.question } : {}), words: CLAUSE_WORDS(clause.clause), ...(roleWords.length ? { role: 'identity' as const, roleWords } : {}) };
    }),
    ...(time?.grain ? { timeGrain: { ref: time.ref, grain: time.grain } } : {}),
    measures: intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]),
    unaccounted: unaccountedQuestionWords(question, intent, vocabulary),
  };
}

/** Words of a ledger clause that the intent now accounts for (a block only through its contract). */
function accountedWords(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): Set<string> {
  return coveredWords(intent, vocabulary, { blockThroughContract: true });
}

/**
 * Hold a later reading to the ledger. A clause is discharged when the reading
 * binds refs that account for its words, kept when it is still listed as
 * unresolved, and dropped otherwise. A first-reading monthly grain that the
 * later reading lost, or a measure the later reading replaced by a block that
 * does not carry it, is a drop too.
 */
export function auditLedger(question: string, intent: AnalyticalIntentV1, ledger: IntentLedger, vocabulary: VocabularyIndex): { entries: Omit<LedgerEntry, 'round'>[]; dropped: IntentLedger['clauses'] } {
  const entries: Omit<LedgerEntry, 'round'>[] = [];
  const dropped: IntentLedger['clauses'] = [];
  const covered = accountedWords(intent, vocabulary);
  // An identity clause is answered by what the rows ARE, so only the refs that
  // identify a row count: a grouping, a displayed label, a filtered member.
  const identityCovered = new Set<string>();
  for (const ref of [...intent.groupBy.map((group) => group.ref), ...intent.display, ...intent.filters.map((filter) => filter.ref)]) {
    const entry = vocabulary.get(ref);
    if (!entry || entry.roles.includes('measure')) continue;
    for (const text of [entry.name, entry.label ?? '', entry.model ?? '', ...entry.aliases]) {
      for (const word of normalizeVocabularyText(text).split(' ')) if (word) { identityCovered.add(word); identityCovered.add(singularWord(word)); }
    }
  }
  const listed = new Set(intent.unresolved.filter((clause) => clause.material).map((clause) => normalizeVocabularyText(clause.clause)));
  for (const item of ledger.clauses) {
    const words = item.words.filter((word) => !/^\d+$/.test(word));
    const identity = item.role === 'identity' && (item.roleWords ?? []).length > 0;
    const discharged = identity
      ? (item.roleWords ?? []).every((word) => identityCovered.has(word) || identityCovered.has(singularWord(word)))
      : words.length > 0 && words.every((word) => covered.has(word) || covered.has(singularWord(word)));
    if (discharged) { entries.push({ clause: item.clause, kind: item.kind, disposition: 'discharged', by: 'refs' }); continue; }
    const stillListed = listed.has(normalizeVocabularyText(item.clause)) || intent.unresolved.some((clause) => clause.material && words.some((word) => normalizeVocabularyText(clause.clause).includes(word)));
    if (stillListed) { entries.push({ clause: item.clause, kind: item.kind, disposition: 'unresolved' }); continue; }
    entries.push({ clause: item.clause, kind: item.kind, disposition: 'dropped' });
    dropped.push(item);
  }
  if (ledger.timeGrain && !intent.groupBy.some((group) => group.role === 'time' && group.grain === ledger.timeGrain!.grain)) {
    const clause = `by ${ledger.timeGrain.grain}`;
    entries.push({ clause, kind: 'not_modeled', disposition: 'dropped' });
    dropped.push({ clause, kind: 'not_modeled', question: `The question asked for a ${ledger.timeGrain.grain} breakdown; a reading without that grain does not answer it.`, words: [ledger.timeGrain.grain] });
  }
  const blocks = intent.measures.map((measure) => vocabulary.get(measure.ref)).filter((entry): entry is VocabularyEntry => entry?.kind === 'block');
  if (blocks.length > 0 && ledger.measures.length > 0) {
    for (const ref of ledger.measures) {
      if (intentRefs(intent).includes(ref)) continue;
      const entry = vocabulary.get(ref);
      if (!entry || entry.kind === 'block') continue;
      const name = normalizeVocabularyText(entry.physical?.column ?? entry.name);
      const carried = blocks.some((block) => [...(block.contract?.outputs ?? []), ...(block.contract?.measures.map((measure) => measure.sourceColumn ?? measure.output) ?? [])].some((column) => normalizeVocabularyText(column) === name));
      if (carried) continue;
      const clause = entry.label ?? entry.name;
      entries.push({ clause, disposition: 'dropped' });
      dropped.push({ clause, question: `The question was read as ${clause}; the block ${blocks.map((block) => block.name).join(', ')} does not carry it, so it does not answer the question.`, words: CLAUSE_WORDS(clause) });
    }
  }
  void question;
  return { entries, dropped };
}

/**
 * The question back to the user for an open clause. A clause the reading already wrote as a question ("best player —
 * which stat should define 'best' (total points, …)?") is asked as written, never wrapped in another question
 * (new-user test V11 retest, Q16: 'Which did you mean for "best player — which stat should define …?"?').
 */
export function clauseQuestion(clause: string): string {
  const asked = clause.trim();
  if (!/\?\s*$/.test(asked)) return `Which did you mean for "${asked}"?`;
  const tail = asked.split(/\s[—–-]\s/).pop()!.trim();
  return `${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
}

/** A retry after a provider timeout needs room for one more full dispatch (the subscription CLI's 60 s) plus 15 s for the rest of the turn. */
const PROVIDER_TIMEOUT_RETRY_BUDGET_MS = 75_000;

export async function resolveIntent(input: ResolveIntentInput): Promise<IntentResolution> {
  const maxAttempts = Math.max(1, Math.min(3, input.maxAttempts ?? 2));
  let timeoutRetried = false;
  const now = input.now ?? (() => Date.now());
  const asked = input.coverageQuestion ?? input.question;
  const seeds = input.question.split(/[^A-Za-z0-9_']+/).filter((word) => word.length > 2);
  const cards = input.renderedCards?.text ?? input.vocabulary.renderCards({ maxChars: input.cardBudget ?? 24_000, seeds });
  const system = buildIntentSystemPrompt({ cards, guidance: input.guidance, hasPrior: Boolean(input.prior), hints: spellingHints(input.question, input.vocabulary), ...(input.selection ? { selection: input.selection } : {}) });
  const shownRefs = new Set((input.renderedCards?.refs ?? []).map((ref) => ref.toLowerCase()));
  const unseenCard = (ref: string): string | undefined => {
    if (!input.renderedCards || shownRefs.has(ref.toLowerCase())) return undefined;
    const entry = input.vocabulary.get(ref);
    return entry ? renderCard(entry) : undefined;
  };
  // Outside the privacy boundary the model reads the earlier reading with its values named by position.
  const shownPrior = input.hidePriorValues && input.prior ? priorWithoutValues(input.prior) : undefined;
  const messages: AgentMessage[] = [
    { role: 'system', content: system },
    ...(input.prior ? [{ role: 'user' as const, content: `${renderPrior(shownPrior?.prior ?? input.prior, input.priorExecuted === false ? undefined : input.priorAnswerSummary, input.priorExecuted !== false)}${renderConversation(input.conversation)}` }] : []),
    { role: 'user', content: `QUESTION: ${input.question}` },
  ];
  let attempts = 0;
  let lastProblems: IntentProblem[] = [];
  let lastIntent: AnalyticalIntentV1 | undefined;
  let lastDetail = '';
  let ledger: IntentLedger | undefined = input.ledger;
  const ledgerEntries: LedgerEntry[] = [];
  const round = input.ledgerRound ?? 0;
  let ledgerCorrected = false;
  // Whether this call wrote the ledger from a reading made before a retrieval
  // expansion showed the interpreter the fields it was missing.
  let ledgerBuiltHere = false;
  let expanded = false;
  // A retrieval expansion (columns fetched for a relation the reading named)
  // is not one of the model's attempts: the re-ask after it is one more turn,
  // like the retry after a provider timeout. Under a 90 s run budget the
  // interpreter otherwise spends its only correction on the retrieval fix.
  // How long the last reading call took, and whether the run stopped reading to keep its time for the SQL.
  let lastDispatchMs = 0;
  let outOfTime = false;
  while (attempts < maxAttempts + (timeoutRetried ? 1 : 0) + (expanded ? 1 : 0)) {
    if (attempts > 0 && input.mayDispatchAgain && !input.mayDispatchAgain(lastDispatchMs)) { outOfTime = true; break; }
    attempts += 1;
    const started = now();
    const reply = await generateStructured(input.provider, messages, ANALYTICAL_INTENT_JSON_SCHEMA, input.providerOptions);
    lastDispatchMs = now() - started;
    input.onDispatch?.({ attempt: attempts, purpose: attempts === 1 ? 'resolve' : 'correct', raw: reply.raw, ms: lastDispatchMs, promptChars: messages.reduce((sum, message) => sum + message.content.length, 0), ...(attempts > 1 && lastProblems.length ? { problems: lastProblems } : {}) });
    if (reply.error === 'provider_error') {
      // A provider that timed out, or exited with an empty reply, is retried
      // exactly once, on the same run and request, when the budget can hold
      // another full dispatch — before anything has executed. A quota, a
      // missing CLI or any other provider failure ends the turn; a
      // governance refusal never reaches this branch.
      if ((reply.code === 'provider_timeout' || reply.code === 'provider_exit') && !timeoutRetried && (input.budgetMs ?? 0) > PROVIDER_TIMEOUT_RETRY_BUDGET_MS) {
        timeoutRetried = true;
        lastDetail = reply.detail ?? 'provider timeout';
        continue;
      }
      return { status: 'failed', reason: 'provider_error', detail: reply.detail ?? 'provider error', problems: [], attempts, ...(reply.code ? { code: reply.code } : {}) };
    }
    if (reply.error) {
      lastDetail = reply.detail ?? reply.error;
      messages.push({ role: 'assistant', content: reply.raw || '(empty)' }, { role: 'user', content: 'That was not a single JSON object matching the schema. Reply with ONLY the JSON object.' });
      continue;
    }
    const parsed = parseIntent(reply.json);
    if (!parsed.intent) {
      lastProblems = parsed.errors;
      lastDetail = parsed.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
      messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: correctionMessage(parsed.errors, unseenCard) });
      continue;
    }
    // The earlier values the model read by position are the real ones again before anything reads its reading.
    if (shownPrior) parsed.intent = shownPrior.restoreIntent(parsed.intent);
    if (parsed.intent.kind === 'conversation') {
      // A why/should question over the previous analysis is not small talk:
      // a conversational reply would judge or explain from rows it cannot
      // compute, so it ends as the unsupported gap the analysis deserves,
      // naming what the previous reading can still answer.
      const operators = causalOperatorsIn(asked);
      if (input.prior && operators.length > 0) {
        const question = `Explaining why something happened or recommending what to do (${operators.join(', ')}) is not something Ask computes from governed data; Research can investigate the drivers.`;
        // The measurable part is the previous analysis, so its reading stays:
        // the interpreter's sentence about a judgment is not a reading of data.
        const intent: AnalyticalIntentV1 = { ...input.prior, reading: input.prior.reading, unresolved: [{ clause: operators.join(', '), options: [], material: true, kind: 'unsupported', question }] };
        return { status: 'clarify', intent, question, options: [], attempts };
      }
      return { status: 'conversation', intent: parsed.intent, reply: parsed.intent.reply ?? parsed.intent.reading, attempts };
    }
    if (parsed.intent.kind === 'definition') return { status: 'definition', intent: parsed.intent, reply: parsed.intent.reply ?? parsed.intent.reading, attempts };
    // The first analytics reading of the original question writes the ledger;
    // every later reading is held to it.
    if (!ledger) { ledger = buildLedger(asked, parsed.intent, input.vocabulary); ledgerBuiltHere = true; }
    else {
      const audit = auditLedger(asked, parsed.intent, ledger, input.vocabulary);
      ledgerEntries.push(...audit.entries.map((entry) => ({ ...entry, round })));
      if (audit.dropped.length > 0) {
        if (!ledgerCorrected && attempts < maxAttempts) {
          ledgerCorrected = true;
          lastDetail = `the reading dropped what the question asked for: ${audit.dropped.map((item) => item.clause).join('; ')}`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `Your reading dropped part of the question: ${audit.dropped.map((item) => `"${item.clause}"`).join(', ')}. A correction may bind these to governed refs that actually carry them, or keep them listed in unresolved as material with no options; it may not replace them with the closest available block or measure. Resend the COMPLETE JSON intent.` });
          continue;
        }
        // A second drop: the obligations come back as material clauses, so
        // the turn ends in the gap the question deserved, never in a
        // substitute answer.
        for (const item of audit.dropped) {
          parsed.intent.unresolved.push({ clause: item.clause, options: [], material: true, kind: item.kind ?? 'not_modeled', origin: 'ledger', question: item.question ?? `"${item.clause}" is something the project does not model as asked.` });
          ledgerEntries.push({ clause: item.clause, kind: item.kind, disposition: 'restored', round });
        }
      }
    }
    // The follow-up guard sends the interpreter back once. When its second
    // reading still replaces the previous analysis with words that name
    // nothing new, both readings are plausible and the user decides.
    // A turn that carries a chosen meaning is not editing the previous turn's
    // reading; it is finishing this one. Holding its repair to the refs the
    // selection replaced rejects exactly the plan the engine asked for.
    // A CHOSEN FIELD REPLACES THE ONE THAT DID NOT EXIST. When the user picked
    // a field for a restriction and the reading still names a field the
    // project does not hold for it (the model invents the same name again),
    // the single invented restriction is rebound to the chosen field here, so
    // the choice is applied rather than asked about a second time.
    if (input.selection) {
      const chosen = input.vocabulary.get(input.selection.ref);
      if (chosen && (chosen.kind === 'column' || chosen.kind === 'dimension' || chosen.kind === 'entity') && !chosen.roles.includes('measure')) {
        const invented = (ref: string) => !input.vocabulary.resolve(ref);
        const restrictions = [
          ...parsed.intent.filters.filter((filter) => filter.on !== 'aggregate' && invented(filter.ref)),
          ...parsed.intent.measures.flatMap((measure) => (measure.scope ?? []).filter((scope) => invented(scope.ref))),
        ];
        if (restrictions.length === 1) {
          restrictions[0]!.ref = chosen.ref;
          parsed.intent.provenance[chosen.ref] = 'clarification:the field you chose holds the restriction';
        }
      }
    }
    const validation = validateIntentRefs(parsed.intent, input.vocabulary, input.selection ? undefined : input.prior, asked, { priorExecuted: input.priorExecuted });
    // A READING OVER TABLES NOBODY GOVERNS IS ANSWERED BY AI-WRITTEN SQL. No
    // correction rounds, no "which field" or "which period" questions about
    // columns: the reading travels to the drafter as a hint, the drafter picks
    // the tables and fields, and the answer says what it assumed. Only a
    // reading one spelling away from authored semantics is corrected first.
    // A question the reading itself asked between real alternatives stays a
    // question: the drafter must not pick one of two meanings the user gave.
    const choice = validation.intent.unresolved.some((clause) => clause.material && clause.kind !== 'unsupported' && clause.options.length >= 2);
    if (input.aiLane && !choice && validation.intent.kind === 'analytics' && readingLane(validation.intent, input.vocabulary) === 'ai'
      && !(attempts < maxAttempts && correctsTowardSemantics(validation.intent, validation.problems, input.vocabulary))) {
      return { status: 'resolved', intent: validation.intent, attempts, problems: validation.problems, lane: 'ai', ...(ledger ? { ledger, ledgerEntries } : {}) };
    }
    if (validation.followUpReplacement && attempts > 1 && input.prior) {
      const options = [...new Set([...input.prior.measures.map((measure) => measure.ref), ...validation.intent.measures.map((measure) => measure.ref)])];
      const label = (ref: string) => input.vocabulary.get(ref)?.label ?? input.vocabulary.get(ref)?.name ?? ref;
      const clarify: AnalyticalIntentV1 = { ...validation.intent, unresolved: [{ clause: input.question, options, material: true, question: `Keep the previous analysis (${input.prior.measures.map((measure) => label(measure.ref)).join(', ')}) and apply this as a correction, or switch to ${validation.intent.measures.map((measure) => label(measure.ref)).join(', ')}?` }] };
      return { status: 'clarify', intent: clarify, question: clarify.unresolved[0]!.question!, options, attempts };
    }
    if (validation.followUpReplacement && attempts > 1) validation.problems = validation.problems.filter((problem) => problem.message !== validation.followUpReplacement);
    // A model can name a conventional Salesforce/raw-column ref that was not
    // rendered because the manifest only documented a prefix of a wide
    // relation.  That is discovery work, not evidence that the field is
    // absent.  Re-describe the admitted partial relation once, then let the
    // normal correction path revalidate the new vocabulary.  A complete
    // relation intentionally skips this branch so its real compatible fields
    // remain the correction suggestions.
    const invalidPartialRelations = (() => {
      const refs = validation.problems
        .map((problem) => /^(.+?) is not in the vocabulary$/.exec(problem.message)?.[1])
        .filter((ref): ref is string => Boolean(ref));
      const named = new Map<string, string>();
      for (const ref of refs) {
        const raw = ref.replace(/^(?:column|dimension|entity|metric|measure):/i, '').toLowerCase();
        const relation = input.vocabulary.entries
          .filter((entry) => entry.kind === 'relation' && entry.physical?.binding?.columnCompleteness !== 'complete')
          .map((entry) => ({ entry, names: [entry.model ?? '', entry.name, ...entry.aliases, ...(entry.physical?.binding?.aliases ?? [])] }))
          // The model may put the database in front (`db.schema.table.column`); the
          // relation is still named by the tail once leading parts are dropped.
          .filter(({ names }) => {
            const parts = raw.split('.');
            const tails = parts.map((_, index) => parts.slice(index).join('.')).filter((tail) => tail.includes('.'));
            return names.some((name) => name && tails.some((tail) => tail === name.toLowerCase() || tail.startsWith(`${name.toLowerCase()}.`)));
          })
          .sort((left, right) => Math.max(...right.names.map((name) => name.length)) - Math.max(...left.names.map((name) => name.length)))[0]?.entry;
        if (relation) named.set(relation.ref, relation.physical?.binding?.logicalRelation ?? relation.model ?? relation.name);
      }
      return [...named.values()].slice(0, 3);
    })();
    if (!expanded && input.expand && invalidPartialRelations.length > 0 && attempts <= maxAttempts) {
      expanded = true;
      const found = await input.expand({ clauses: invalidPartialRelations, question: input.question, reading: validation.intent.reading });
      if (found && found.cards.length > 0) {
        input = { ...input, vocabulary: found.vocabulary };
        // THE LEDGER IS WRITTEN BY THE INFORMED READING. The reading it was
        // taken from could not see these fields and listed what they answer
        // as unanswerable; holding the next reading, which can see them, to
        // those clauses restores stale obligations as material and blocks a
        // correct answer. The next reading writes the ledger again.
        if (ledgerBuiltHere) { ledger = undefined; ledgerBuiltHere = false; }
        lastDetail = `the reading named fields on partial relation${invalidPartialRelations.length === 1 ? '' : 's'} ${invalidPartialRelations.join(', ')}; their current columns were retrieved`;
        messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: expansionMessage(invalidPartialRelations, found.cards) });
        continue;
      }
    }
    // RETRIEVE, THEN RE-ASK: a material clause with no options while the
    // reading names a relation (or words the inventory holds) is a retrieval
    // gap first. Once.
    const openClauses = validation.intent.kind === 'analytics' ? validation.intent.unresolved.filter((clause) => clause.material && clause.options.length === 0 && clause.kind !== 'unsupported').map((clause) => clause.clause) : [];
    if (!expanded && input.expand && openClauses.length > 0 && attempts <= maxAttempts) {
      expanded = true;
      const found = await input.expand({ clauses: openClauses, question: input.question, reading: validation.intent.reading });
      if (found && found.cards.length > 0) {
        input = { ...input, vocabulary: found.vocabulary };
        // THE LEDGER IS WRITTEN BY THE INFORMED READING. The reading it was
        // taken from could not see these fields and listed what they answer
        // as unanswerable; holding the next reading, which can see them, to
        // those clauses restores stale obligations as material and blocks a
        // correct answer. The next reading writes the ledger again.
        if (ledgerBuiltHere) { ledger = undefined; ledgerBuiltHere = false; }
        lastDetail = `the reading left "${openClauses.join('; ')}" unresolved; entries not shown before were found`;
        messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: expansionMessage(openClauses, found.cards) });
        continue;
      }
    }
    const bare = isBareIntent(parsed.intent);
    const askedQuestions = new Map(validation.intent.unresolved.map((clause) => [clause, clause.question]));
    if (input.selection) applySelectedMeaning(validation.intent, input.selection, input.vocabulary);
    applyGovernedDefaults(validation.intent, asked, input.vocabulary, { normalizeScopes: false });
    askWhichFieldHoldsTheRestriction(validation.intent, input.vocabulary, input.selection?.ref);
    proveTimeRoles(validation.intent, input.vocabulary);
    if (input.clauseCoverage !== false) proveClauseCoverage(asked, validation.intent, input.vocabulary);
    // NO PARTIAL ANSWERS. When the interpreter wrote down nothing but a
    // clarification and the governed default supplied the only measure, the
    // rest of the question (a time axis, a grain, a member) is still
    // unaccounted for. The interpreter is sent back once for the complete
    // intent; if it still returns nothing else, the user is asked, never
    // served a scalar for a breakdown.
    if (bare && validation.problems.length === 0) {
      const defaulted = validation.intent.unresolved.filter((clause) => !clause.material && askedQuestions.get(clause) !== clause.question && clause.question?.startsWith('Read "'));
      if (defaulted.length > 0) {
        const leftover = unaccountedQuestionWords(asked, validation.intent, input.vocabulary);
        if (leftover.length > 0) {
          if (attempts < maxAttempts) {
            lastDetail = `the question also says "${leftover.join(' ')}"; the intent must carry it`;
            messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The governed default reads ${defaulted.map((clause) => `"${clause.clause}" as ${validation.intent.measures.map((measure) => measure.ref).join(', ')}`).join('; ')}. Your intent carried nothing else, but the question also says "${leftover.join(' ')}". Resend the COMPLETE JSON intent: measures [${validation.intent.measures.map((measure) => measure.ref).join(', ')}] plus every other clause the question asks for (a groupBy time axis with its grain, a breakdown, a filter, an ordering, a limit), with unresolved: [].` });
            continue;
          }
          for (const clause of defaulted) { clause.material = true; clause.question = askedQuestions.get(clause) ?? clause.question; }
        }
      }
    }
    // NO PARTIAL ANSWERS, the period edition: a year the question names must
    // be a window (or a filter) on the intent. The interpreter is sent back
    // once for it; a second reading without it ends as a gap that names the
    // window-less reading rather than an all-time total posing as the year.
    if (validation.problems.length === 0 && validation.intent.kind === 'analytics' && !validation.intent.unresolved.some((clause) => clause.material)) {
      // NO PARTIAL ANSWERS, the grain edition: "by month" is a time grouping,
      // never a scalar over the period. One re-ask, then a material clause.
      // A calendar period is dates, never a season or fiscal field that holds
      // the same number: one correction naming the date dimensions, then a
      // clarification. A wrong period is a wrong population.
      const basis = calendarBasisProblem(asked, validation.intent, input.vocabulary);
      if (basis) {
        const fieldEntry = input.vocabulary.get(basis.field);
        const fieldName = fieldEntry?.label ?? fieldEntry?.name ?? basis.field;
        const described = fieldEntry?.description ? ` (${fieldEntry.description.replace(/[.\s]+$/, '')})` : '';
        if (attempts < maxAttempts && basis.dates.length > 0) {
          lastDetail = `the question asks for a calendar period; the reading restricts ${basis.field}, which is not a date`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The question asks for a CALENDAR period, but your reading restricts ${basis.field}${described}, which is not a date and may hold a different population for the same number. Resend the COMPLETE intent with the period as a time window (or a date filter) on a date dimension: ${basis.dates.join(', ')}. The measures must come from that date's own relation (a metric defined on another table cannot be restricted by this date): aggregate its columns instead${basis.measuresAt.length ? `, for example ${basis.measuresAt.join(', ')} with an aggregation` : ''}. The grouping, the display and every filter must come from that relation too${basis.fieldsAt.length ? `: ${basis.fieldsAt.join(', ')}` : ''}. If none of them can express the question, list the period as a material unresolved clause instead.` });
          continue;
        }
        return {
          status: 'clarify', intent: validation.intent, attempts, options: basis.dates.slice(0, 4),
          question: basis.dates.length
            ? `The question asks for a calendar period, but ${fieldName}${described} is not a date. Which date should the period be measured on, or did you mean the ${fieldName} value?`
            : `The question asks for a calendar period, but this project only models ${fieldName}${described}, which is not a date. Should the answer use the ${fieldName} value instead?`,
          ...(ledger ? { ledger, ledgerEntries } : {}),
        };
      }
      // A relative period ("this season") must restrict the rows. One
      // correction, then the turn says why it cannot be resolved here instead
      // of answering over all history.
      const relative = relativePeriodProblem(asked, validation.intent, input.vocabulary);
      if (relative) {
        if (attempts < maxAttempts) {
          lastDetail = `the question asks for "${relative.phrase}"; the reading restricts no period`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The question asks for "${relative.phrase}". That names a POPULATION: every row of the answer must fall in one and the same period. Your reading restricts none — selecting the period beside each row (its maximum, its latest value) leaves every row with its own, so the answer would cover all of history. Resend the COMPLETE intent with a time window, or a filter that pins one period${relative.fields.length ? ` on one of ${relative.fields.join(', ')}` : ''}. If this project holds no mapping from today to that period, resend the intent with NO period restriction at all and no unresolved clause: the host will then ask which period was meant, rather than answering over all of history.` });
          continue;
        }
        validation.intent.unresolved.push({
          clause: relative.phrase, options: [], material: true, kind: 'not_modeled', origin: 'ledger',
          question: `"${relative.phrase}" cannot be resolved from this project: its ${relative.unit} is a stored value with no mapping to today's date, and the latest ${relative.unit} the data holds is a different claim from the current one. Name the ${relative.unit} you mean, or ask for the latest ${relative.unit} in the data.`,
        });
      }
      // A follow-up may not quietly answer a wider population than the one it
      // is editing: one correction, then the turn ends in a clarification.
      const widened = widenedPopulation(asked, validation.intent, input.prior);
      if (widened.length > 0) {
        if (attempts < maxAttempts) {
          lastDetail = `the previous analysis restricted this to ${widened.join(', ')}; the reading dropped it`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `Your reading drops ${widened.join(', ')} from the previous analysis, so it would answer for a larger population than the one the message is editing. Resend the COMPLETE intent keeping it, or list it in provenance as "removed:<why>" if the message really asks for the wider population.` });
          continue;
        }
        return {
          status: 'clarify', intent: validation.intent, attempts, options: [],
          question: `The previous analysis was restricted to ${widened.join(', ')}. Should this question keep that, or apply to every row?`,
          ...(ledger ? { ledger, ledgerEntries } : {}),
        };
      }
      // The change the question asked for is a column of the answer.
      const change = droppedChange(asked, validation.intent, input.vocabulary);
      if (change) {
        const aliases = validation.intent.measures.filter((measure) => measure.alias && !measure.derived && !measure.change).map((measure) => measure.alias!);
        if (attempts < maxAttempts) {
          lastDetail = `the question asks for the ${change}; the reading returns the parts and never computes it`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The question asks for the ${change}, and your reading returns ${aliases.join(' and ')} without it. Resend the COMPLETE intent with one more measure that computes it: {"change":{"base":"${aliases[0]}","comparison":"${aliases[1]}","as":"${/percent|percentage/i.test(asked) ? 'percent' : 'absolute'}"},"alias":"<name>"}. If the answer ranks by that difference, order by it and keep the limit.` });
          continue;
        }
        validation.intent.unresolved.push({ clause: change, options: [], material: true, kind: 'not_modeled', origin: 'ledger', question: `The question asked for the ${change} between the periods; this reading returns ${aliases.join(' and ')} and never computes it, so it was not answered as if it had.` });
      }
      const grain = droppedGrain(asked, validation.intent, input.vocabulary);
      if (grain) {
        if (attempts < maxAttempts) {
          lastDetail = `the question asks for a ${grain} breakdown; the reading carries no time grouping`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The question asks for a ${grain} breakdown, but your intent has no groupBy with role "time" and grain "${grain}". Resend the COMPLETE JSON intent with that time grouping on the measures' time dimension, keeping every other clause.` });
          continue;
        }
        validation.intent.unresolved.push({ clause: `by ${grain}`, options: [], material: true, kind: 'not_modeled', origin: 'ledger', question: `The question asked for a ${grain} breakdown; a reading without that grain does not answer it.` });
      }
      const years = droppedYears(asked, validation.intent, input.vocabulary);
      if (years.length > 0) {
        if (attempts < maxAttempts) {
          lastDetail = `the question names the period ${years.join(', ')}; the intent carries no time window for it`;
          messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The question names the period "${years.join(', ')}", but your intent carries no time window or filter for it. Resend the COMPLETE JSON intent with time.window covering ${years.join(', ')} (start and end dates, and the expression) on the measures' time dimension, keeping every other clause.` });
          continue;
        }
        validation.intent.unresolved.push({ clause: years.join(', '), options: [], material: true, kind: 'not_modeled', question: `The period "${years.join(', ')}" could not be applied to this reading, so it was not answered as an all-time total.` });
      }
    }
    const material = validation.intent.unresolved.find((clause) => clause.material);
    // The question already chose the basis: "calendar 2017" is the date
    // dimension among the options, not a question back to the user.
    if (material && validation.problems.length === 0 && attempts < maxAttempts && CALENDAR_WORDS.test(asked)) {
      const dates = material.options.filter((ref) => input.vocabulary.resolve(ref)?.roles.includes('time'));
      if (dates.length === 1) {
        const basis = calendarBasisProblem(asked, { ...validation.intent, unresolved: [] }, input.vocabulary);
        lastDetail = `the question names a calendar period; ${dates[0]} is the date dimension among the options`;
        messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: `The question says CALENDAR, so "${material.clause}" is not open: use ${dates[0]} as the period (a time window with its bounds) and remove that unresolved clause. The measures must come from ${dates[0]}'s own relation: aggregate its columns${basis?.measuresAt.length ? `, for example ${basis.measuresAt.join(', ')} with an aggregation` : ''}; a metric defined on another table cannot be restricted by this date. Group, display and filter on that relation too${basis?.fieldsAt.length ? `: ${basis.fieldsAt.join(', ')}` : ''}. Resend the COMPLETE intent.` });
        continue;
      }
    }
    if (validation.problems.length === 0 || (material && validation.problems.every((problem) => problem.path === 'measures'))) {
      if (material) {
        return { status: 'clarify', intent: validation.intent, question: material.question ?? clauseQuestion(material.clause), options: material.options, attempts, ...(ledger ? { ledger, ledgerEntries } : {}) };
      }
      return { status: 'resolved', intent: validation.intent, attempts, problems: [], ...(ledger ? { ledger, ledgerEntries } : {}) };
    }
    lastProblems = validation.problems;
    lastIntent = validation.intent;
    lastDetail = validation.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
    messages.push({ role: 'assistant', content: reply.raw }, { role: 'user', content: correctionMessage(validation.problems, unseenCard) });
  }
  // OUT OF TIME TO CORRECT: the reading so far is not used (it still needed a correction, or a retrieval), and the
  // caller drafts the SQL from the question; a question back to the user built from a half-corrected reading is not
  // what was asked.
  if (outOfTime) {
    return { status: 'failed', reason: lastIntent || lastProblems.length ? 'invalid' : 'unparseable', detail: `no time was left to correct the reading${lastDetail ? ` (${lastDetail})` : ''}`, problems: lastProblems, attempts, code: 'reading_out_of_time' };
  }
  // A reading that only failed to account for the PREVIOUS analysis's clauses
  // is not a broken reading, it is an ambiguous continuation: ask which
  // population the user meant instead of reporting an internal problem.
  if (lastProblems.length > 0 && lastProblems.every((problem) => problem.path === 'provenance') && lastIntent) {
    const clause = lastProblems.map((problem) => problem.message.replace(/^the previous analysis used /, '').replace(/\s*\[[^\]]*\]/, '').replace(/; keep it.*$/, '')).join(', ');
    return {
      status: 'clarify', intent: lastIntent, attempts, options: [],
      question: `The previous analysis also used ${clause}. Should this question keep that, or apply without it?`,
    };
  }
  // A reading that keeps naming the wrong field for a place the host can name
  // the right candidates for is a question, not a dead end: "which date should
  // the monthly breakdown use?" with the dates as options.
  // The options must be things that can stand where the reading used the
  // missing ref: a field for a filter, a measure for a measure. A table offered
  // for a filter cannot be applied, so choosing it only asks the same question
  // again. Fields close to the invented name are offered too
  // (COMPETITOR_INVOLVED → COMPETITOR_C).
  const kindsForPath = (path: string): VocabularyKind[] => /^measures\[\d+\]\.scope|^filters/.test(path) ? [...FILTER_KINDS] : /^measures/.test(path) ? [...MEASURE_KINDS] : /^groupBy/.test(path) ? [...GROUP_KINDS] : /^display/.test(path) ? [...DISPLAY_KINDS] : [];
  const fitting = (problem: IntentProblem): string[] => {
    const kinds = kindsForPath(problem.path);
    if (kinds.length === 0) return problem.suggestions ?? [];
    const missing = /^(.+?) is not in the vocabulary$/.exec(problem.message)?.[1];
    const leaf = missing?.replace(/^[a-z_]+:/i, '').split('.').pop()?.replace(/_/g, ' ');
    const fromName = leaf ? input.vocabulary.lookup(leaf, { kinds, limit: 4 }).map((hit) => hit.entry.ref) : [];
    return [...new Set([...(problem.suggestions ?? []).filter((ref) => { const entry = input.vocabulary.get(ref); return entry ? kinds.includes(entry.kind) : false; }), ...fromName])];
  };
  if (lastIntent && lastProblems.length > 0 && lastProblems.every((problem) => fitting(problem).length > 0)) {
    const options = [...new Set(lastProblems.flatMap((problem) => fitting(problem)))].slice(0, 6);
    const label = (ref: string) => input.vocabulary.get(ref)?.label ?? input.vocabulary.get(ref)?.name ?? ref;
    const question = `${lastProblems.map((problem) => `For ${problem.path}, the reading used something that ${problem.message.replace(/^\S+ /, '')}`).join('; ')}. Which of these should it use: ${options.map(label).join(', ')}?`;
    return { status: 'clarify', intent: { ...lastIntent, unresolved: [...lastIntent.unresolved, { clause: lastProblems.map((problem) => problem.path).join(', '), options, material: true, question }] }, question, options, attempts, unmatched: lastProblems, ...(ledger ? { ledger, ledgerEntries } : {}) };
  }
  return { status: 'failed', reason: lastProblems.length ? 'invalid' : 'unparseable', detail: lastDetail, problems: lastProblems, attempts };
}

export { intentRefs };
