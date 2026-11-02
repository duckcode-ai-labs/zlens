import { parseIntent, type AnalyticalIntentV1 } from './intent.js';
import { isGovernedEntry, validateIntentRefs } from './resolve-intent.js';
import type { VocabularyEntry, VocabularyIndex } from './vocabulary.js';

/**
 * READ A QUESTION BY THE SEMANTIC LAYER'S OWN WORDS.
 *
 * "Claims filed by region" says a metric (by its label) and a dimension (by
 * its label) and nothing else. Asking a model to choose a route for it lets
 * the same question come back governed one run and AI-written the next. When
 * every content word of the question is a governed metric or dimension, named
 * by label, name or synonym, and each names exactly one entry, the reading is
 * settled here, and it overrides whatever the model answered. Certified-first still holds: the reading
 * goes through the same tiers, and a certified block that entails it wins.
 *
 * Anything else keeps the model-driven path: more than one metric, an approved
 * correction, skill or host guidance that applies to a name, a word nothing here accounts for
 * (a period, a filter, "top", "compare"), a name two entries share, a name a
 * certified block or term also claims, a time dimension, or a dimension the
 * metric cannot reach. "Total", "count", "average" and their kin ask for the
 * aggregate the metric already is and are read here when they agree with it;
 * a dimension name that several models share is the one on the metric's model.
 */

// Words that ask for a grouped table without changing what is measured.
const CONNECTIVES = new Set([
  'a', 'an', 'the', 'by', 'for', 'each', 'every', 'of', 'and', 'across', 'our', 'my', 'please',
  'show', 'me', 'us', 'give', 'display', 'get', 'tell', 'what', 'whats', 'is', 'are', 'can', 'you', 'i', 'want', 'to', 'see',
  'broken', 'down', 'split', 'grouped', 'group', 'breakdown', 'it', 's',
]);
// Words that ask for the aggregate a metric already is: "total claimed amount"
// is the sum metric Claimed amount, "number of claims" the count metric. Each
// is accepted only when the one metric's aggregation agrees (a metric with no
// recorded aggregation accepts "total"); "average paid amount" over a sum
// metric stays the model's to read. Like "by", a bare one is never a name.
const AGGREGATE_WORDS = new Map<string, ReadonlyArray<string | undefined>>([
  ['total', ['sum', 'count', 'count_distinct', undefined]],
  ['sum', ['sum', undefined]],
  ['overall', ['sum', 'count', 'count_distinct', undefined]],
  ['count', ['count', 'count_distinct']],
  ['number', ['count', 'count_distinct']],
  ['average', ['avg', 'average', 'mean']],
  ['mean', ['avg', 'average', 'mean']],
]);
const MAX_PHRASE_WORDS = 6;

const wordsOf = (text: string): string[] => text.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** One phrase's naming: one governed entry, or the same dimension name on several models, settled once the metric is known. */
type Naming = { entry: VocabularyEntry } | { shared: VocabularyEntry[] };
type Named = Naming & { start: number; end: number };

/** What one phrase names: a single governed metric or dimension, one dimension name shared by several models, nothing, or `ambiguous`. */
function namedBy(phrase: string, vocabulary: VocabularyIndex): Naming | 'ambiguous' | undefined {
  const hits = vocabulary.lookup(phrase, { limit: 24, minScore: 0.98 })
    .filter((hit) => hit.matchedOn === 'name' || hit.matchedOn === 'alias' || hit.matchedOn === 'ref')
    .map((hit) => hit.entry);
  // A certified block, a term or a concept that claims the same words decides in its own tier.
  if (hits.some((entry) => entry.kind === 'block' || entry.kind === 'term' || entry.kind === 'concept' || entry.kind === 'hint' || entry.kind === 'skill')) return 'ambiguous';
  const semantic = hits.filter((entry) => entry.kind === 'metric' || entry.kind === 'measure' || entry.kind === 'dimension');
  if (semantic.length === 0) return undefined;
  if (semantic.length === 1) return isGovernedEntry(semantic[0]!) ? { entry: semantic[0]! } : 'ambiguous';
  // The same dimension name on several models ("product" on claims and on
  // claim_payments) is one name, not two readings: the model the metric lives
  // on decides which, once the metric is known. Two names on one model stay ambiguous.
  const models = new Set(semantic.map((entry) => entry.model));
  if (semantic.every((entry) => entry.kind === 'dimension' && entry.model && isGovernedEntry(entry)) && models.size === semantic.length) return { shared: semantic };
  return 'ambiguous';
}

/** Does an approved correction or a selected skill speak about this entry? The model sees those cards; this path does not, so it yields. */
function guidedBy(entry: VocabularyEntry, vocabulary: VocabularyIndex): boolean {
  if (entry.preferredBy?.length) return true;
  const names = [entry.label, entry.name, ...entry.aliases].filter((value): value is string => Boolean(value)).map((value) => wordsOf(value).join(' ')).filter(Boolean);
  return vocabulary.entries.some((other) => {
    if (other.kind === 'skill') {
      const skill = other.skill;
      if (!skill) return false;
      const refs = [...skill.preferredRefs, ...Object.values(skill.vocabulary)].map((ref) => ref.toLowerCase());
      return refs.includes(entry.ref.toLowerCase());
    }
    if (other.kind !== 'hint') return false;
    const text = ` ${wordsOf([other.name, ...other.aliases, other.description ?? ''].join(' ')).join(' ')} `;
    return names.some((name) => text.includes(` ${name} `));
  });
}

export function readByOwnWords(question: string, vocabulary: VocabularyIndex): AnalyticalIntentV1 | undefined {
  const words = wordsOf(question);
  if (words.length === 0 || words.length > 24) return undefined;
  const named: Named[] = [];
  const taken = new Array<boolean>(words.length).fill(false);
  for (let size = Math.min(MAX_PHRASE_WORDS, words.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      if (taken.slice(start, start + size).some(Boolean)) continue;
      // A bare connective or aggregate word is never a name, even when something is called "by".
      if (size === 1 && (CONNECTIVES.has(words[start]!) || AGGREGATE_WORDS.has(words[start]!))) continue;
      const found = namedBy(words.slice(start, start + size).join(' '), vocabulary);
      if (found === 'ambiguous') return undefined;
      if (!found) continue;
      named.push({ ...found, start, end: start + size });
      for (let index = start; index < start + size; index += 1) taken[index] = true;
    }
  }
  // Every word is a name, a connective or an aggregate word, or the model reads it.
  if (words.some((word, index) => !taken[index] && !CONNECTIVES.has(word) && !AGGREGATE_WORDS.has(word))) return undefined;
  named.sort((a, b) => a.start - b.start);
  const metrics = named.flatMap((item) => ('entry' in item && item.entry.kind === 'metric' ? [item.entry] : []));
  // One metric: a second one is a comparison or a join the model reads.
  if (metrics.length !== 1) return undefined;
  const metric = metrics[0]!;
  // "total", "count", "average": the aggregate asked for must be the one the metric is.
  const aggregation = metric.aggregation?.toLowerCase();
  if (words.some((word, index) => !taken[index] && AGGREGATE_WORDS.has(word) && !AGGREGATE_WORDS.get(word)!.includes(aggregation))) return undefined;
  // A dimension name several models share is the one on the metric's model.
  const entries: VocabularyEntry[] = [];
  for (const item of named) {
    if ('entry' in item) { entries.push(item.entry); continue; }
    const own = item.shared.filter((entry) => entry.model === metric.model);
    if (own.length !== 1) return undefined;
    entries.push(own[0]!);
  }
  const dimensions = entries.filter((entry) => entry.kind === 'dimension');
  if (dimensions.length === 0 || 1 + dimensions.length !== entries.length) return undefined;
  // A time dimension needs a grain, and a dimension the metric cannot reach needs a join path: both are the model's to read.
  const reachable = (dimension: VocabularyEntry) => !metric.model || dimension.model === metric.model || (dimension.joinReach ?? []).includes(metric.model);
  if (dimensions.some((entry) => entry.roles.includes('time') || !reachable(entry))) return undefined;
  if (entries.some((entry) => guidedBy(entry, vocabulary))) return undefined;
  const unique = <T>(values: T[]) => [...new Set(values)];
  const metricRefs = [metric.ref];
  const dimensionRefs = unique(dimensions.map((entry) => entry.ref));
  const label = (ref: string) => vocabulary.get(ref)?.label ?? vocabulary.get(ref)?.name ?? ref;
  const parsed = parseIntent({
    version: 1, kind: 'analytics',
    reading: `${label(metricRefs[0]!)} by ${dimensionRefs.map(label).join(' and ')}`,
    measures: metricRefs.map((ref) => ({ ref })),
    groupBy: dimensionRefs.map((ref) => ({ ref, role: 'categorical' })),
    display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped',
  });
  if (!parsed.intent) return undefined;
  const validation = validateIntentRefs(parsed.intent, vocabulary);
  return validation.problems.length === 0 ? validation.intent : undefined;
}
