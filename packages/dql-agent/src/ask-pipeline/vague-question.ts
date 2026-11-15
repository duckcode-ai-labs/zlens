/**
 * A VAGUE QUESTION IS ASKED BACK, NOT REPORTED AS MISSING DATA.
 *
 * "How are the Warriors doing lately?" names no measure (doing how: wins, points?) and no period ("lately" is
 * which games?). When no SQL could be written for it, the honest reply is a question back, never "Not in this data
 * ... the tables Ask searched do not hold it" (new-user test V13, Q17; the V13 gate saw both "blocked" and a
 * clarification for the same question). "Not in this data" stays for what the data truly lacks: a payroll the
 * tables have no column for is asked plainly, with its measure and its year, and is not vague.
 */

import { withoutTrailing } from '../text-ends.js';

/** What a question leaves open. */
export interface OpenParts {
  /** It names no measure: "how are they doing", "how good is". */
  measure: boolean;
  /** It names no period: "lately", "recently", "these days". */
  period: boolean;
}

// "How are the Warriors doing", "how is the team performing", "how good is the defense". A trend of a named
// measure ("how is revenue trending") names its measure and is not here.
const OPEN_MEASURE = /\bhow\s+(?:(?:is|are|was|were|has|have|had|did|do|does|will|would|'s|'re)\s+)?(?:[\w'.&-]+\s+){0,5}?(?:doing|performing|faring|going|shaping\s+up|getting\s+on)\b|\bhow\s+(?:good|well|bad|badly|strong|weak)\b/i;
const OPEN_PERIOD = /\b(?:lately|recently|of\s+late|these\s+days|nowadays|in\s+recent\s+(?:times|years|seasons|months|weeks|games|days))\b/i;

// The AI's own reason for writing no SQL says the QUESTION left something out, not that the data lacks it:
// "No measure of how the Warriors are doing ... or defined time period for lately is specified in the question".
const SAYS_UNSPECIFIED = [
  /\b(?:not|no|nor|never|without)\b[^.;]{0,160}?\b(?:specif(?:y|ies|ied|ying|ication)|stated?|defined?|given|says?|named?|mention(?:s|ed)?|indicat(?:e|es|ed|ing))\b[^.;]{0,80}?\b(?:question|asked|request)\b/i,
  /\b(?:question|request)\b[^.;]{0,80}?\b(?:does\s+not|doesn't|did\s+not|didn't|never)\s+(?:specify|say|state|define|name|mention|indicate)\b/i,
  // "The question is too vague to pick a measure"; "ambiguous" alone may be about names, not the question.
  /\b(?:ambiguous|vague|unclear|underspecified|under-specified|open\s+to\s+interpretation)\b[^;]{0,80}?\b(?:question|measure|metric|period|time\s*frame)\b|\b(?:question|measure|metric|period|time\s*frame)\b[^;]{0,80}?\b(?:ambiguous|vague|unclear|underspecified|under-specified)\b/i,
];
const SAYS_MEASURE = /\b(?:measure|metric|statistic|stat|kpi|performance\s+(?:measure|indicator))\b/i;
const SAYS_PERIOD = /\b(?:period|time\s*frame|timeframe|time\s+range|date\s+range|time\s+window|lately|recently|which\s+(?:season|year|month|dates?))\b/i;

/** What the question's own words leave open, or undefined when they name a measure and a period (or need none). */
export function openPartsOfQuestion(question: string): OpenParts | undefined {
  const measure = OPEN_MEASURE.test(question);
  const period = OPEN_PERIOD.test(question);
  return measure || period ? { measure, period } : undefined;
}

/** What a reason for writing no SQL says the question left open, or undefined when it blames the data. */
export function openPartsOfReason(text: string): OpenParts | undefined {
  // "etc." and "e.g." do not end a sentence.
  const reason = text.replace(/\betc\./gi, 'etc').replace(/\be\.g\./gi, 'eg').replace(/\bi\.e\./gi, 'ie');
  if (!SAYS_UNSPECIFIED.some((pattern) => pattern.test(reason))) return undefined;
  const measure = SAYS_MEASURE.test(reason);
  const period = SAYS_PERIOD.test(reason);
  // It says the question is open without saying what: both are asked.
  return measure || period ? { measure, period } : { measure: true, period: true };
}

/**
 * Examples of measures the AI named in its reason ("(wins, points, efficiency, etc.)"), in plain words. A list
 * that reads like column names (WIN_PCT) offers nothing a person can say back, and is left out.
 */
export function measureExamples(reason: string | undefined): string[] {
  if (!reason) return [];
  for (const match of reason.matchAll(/\(([^()]{3,120})\)/g)) {
    const items = match[1]!.split(/,|\bor\b|\band\b/).map((item) => withoutTrailing(item.replace(/\b(?:e\.g\.|etc\.?|and so on|for example)/gi, '').trim(), '.')).filter(Boolean);
    if (items.length < 2) continue;
    if (items.some((item) => /[_()]|^[A-Z0-9 ]+$/.test(item) || item.split(/\s+/).length > 4)) continue;
    return items.slice(0, 4).map((item) => item.toLowerCase());
  }
  return [];
}

const orList = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`);

/** The question asked back: short and plain, never the person's question quoted inside another. */
export function vagueClarification(parts: OpenParts, examples: string[] = []): string {
  const ask = parts.measure && parts.period ? 'Which measure do you mean, and over which period (a year or a date range)?'
    : parts.measure ? 'Which measure do you mean?'
      : 'Over which period do you mean: a year or a date range?';
  const forExample = parts.measure && examples.length >= 2 ? ` For example ${orList(examples)}.` : '';
  return `${ask}${forExample}`;
}

/**
 * Whether a run that wrote no SQL should ask back instead of reporting a gap, and the question to ask. Undefined
 * when the question names what it measures and when: then the gap stands ("Not in this data").
 */
export function clarificationForOpenQuestion(question: string, reason?: string, options: { wordsOnly?: boolean } = {}): string | undefined {
  const fromWords = openPartsOfQuestion(question);
  const fromReason = reason && !options.wordsOnly ? openPartsOfReason(reason) : undefined;
  if (!fromWords && !fromReason) return undefined;
  const parts: OpenParts = {
    measure: Boolean(fromWords?.measure || fromReason?.measure),
    period: Boolean(fromWords?.period || fromReason?.period),
  };
  return vagueClarification(parts, measureExamples(reason));
}

/** Clarification options without repeats: two buttons that both say "EFFICIENCY RATING" are one choice (V13, Q16). */
export function distinctOptions<T extends { label: string }>(options: T[]): T[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = option.label.replace(/[_\s]+/g, ' ').trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
