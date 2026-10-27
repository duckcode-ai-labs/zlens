import { parseIntent, type AnalyticalIntentV1 } from './intent.js';
import { validateIntentRefs } from './resolve-intent.js';
import type { VocabularyEntry, VocabularyIndex } from './vocabulary.js';

/**
 * THE QUESTION A BLOCK WAS CERTIFIED TO ANSWER.
 *
 * A certified saved query built from a request records the request's question
 * in its `examples` (`examples = [{ question = "…" }]`, written by the
 * pre-filled draft and editable in Block Studio); a draft the product writes
 * from an answer also carries the question as its description. When a
 * question equals one of those records after normalisation (case,
 * whitespace, trailing punctuation), that block IS the answer: the route is
 * settled here, before any model reads the question, so the same words
 * cannot come back certified one run and AI-written the next. The block's
 * contract still decides the rest (its grain, its identity key, a host's
 * audience and row rules), exactly as for a block the question names.
 *
 * Two certified blocks recording the same question is a modelling conflict
 * the matcher does not break: the meaning-based match decides.
 */

/** Case, whitespace, quote style and trailing punctuation folded away; what is left is the question's own words. */
export function normalizeQuestion(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[\s ]+/g, ' ')
    .trim()
    .replace(/[\s?.!…,;:]+$/g, '')
    .replace(/^[\s"']+|[\s"']+$/g, '')
    .trim();
}

/** The questions a block's metadata says it answers: its examples, and a description that is a question verbatim. */
export function certifiedQuestionsOf(entry: VocabularyEntry): string[] {
  const recorded = [...(entry.examples ?? []), ...(entry.description ? [entry.description] : [])];
  return [...new Set(recorded.map((text) => text.trim()).filter(Boolean))];
}

/** The one certified block whose recorded questions include this one, or undefined (none, or more than one). */
export function certifiedBlockForQuestion(question: string, vocabulary: VocabularyIndex): VocabularyEntry | undefined {
  const asked = normalizeQuestion(question);
  if (!asked) return undefined;
  const matched = vocabulary.entries.filter((entry) => entry.kind === 'block' && entry.certified
    && certifiedQuestionsOf(entry).some((recorded) => normalizeQuestion(recorded) === asked));
  return matched.length === 1 ? matched[0] : undefined;
}

/**
 * The reading for a question a certified block records as its own: the block
 * is the one measure, nothing else is asked for, and the question stands as
 * the reading. The same shape a question that names the block is read into.
 */
export function readByCertifiedQuestion(question: string, vocabulary: VocabularyIndex): { intent: AnalyticalIntentV1; block: VocabularyEntry } | undefined {
  const block = certifiedBlockForQuestion(question, vocabulary);
  if (!block) return undefined;
  const parsed = parseIntent({
    version: 1, kind: 'analytics',
    reading: question.trim(),
    measures: [{ ref: block.ref }],
    groupBy: [], display: [], filters: [], unresolved: [],
    provenance: { [block.ref]: 'q:certified question' },
    expectedShape: block.contract?.limit !== undefined || block.contract?.orderBy?.length ? 'ranking' : 'grouped',
  });
  if (!parsed.intent) return undefined;
  const validation = validateIntentRefs(parsed.intent, vocabulary);
  return validation.problems.length === 0 ? { intent: validation.intent, block } : undefined;
}
