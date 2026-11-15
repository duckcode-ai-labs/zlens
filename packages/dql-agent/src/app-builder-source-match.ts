import type { AppSourceCatalogRecord } from './app-source-catalog.js';

/**
 * How well a source's own words (its name, description and example question) answer a question, for
 * Describe with AI (V13 retest):
 *
 * - a certified saved query whose name and description say exactly what was asked ("Warriors Ppg Regular Vs
 *   Playoffs 2016" for "Compare how the Golden State Warriors scored per game in the 2016 regular season and in
 *   the 2016 playoffs") reaches the planner first and is picked;
 * - a pick whose own words answer its question covers it, though the question does not spell the field names
 *   ("How did the Warriors perform in each season?" answered by WINS by SEASON);
 * - a question the planner wrote about something the request never names ("the Golden State Warriors' points
 *   per game" for "the top scorers in the 2016 playoffs") is not the person's question.
 *
 * Pure word matching; no I/O.
 */

/** Words that carry no subject: articles, prepositions, question words, and the words of the request itself. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'from', 'for', 'with', 'by', 'per', 'vs', 'versus', 'into',
  'over', 'during', 'between', 'through', 'than', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'their',
  'they', 'them', 'his', 'her', 'our', 'my', 'your', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
  'whose', 'when', 'where', 'why', 'how', 'did', 'do', 'does', 'done', 'has', 'have', 'had', 'me', 'us', 'we', 'i', 'all',
  'any', 'some', 'only', 'also', 'up', 'out', 'about', 'there', 'here', 'will', 'would', 'can', 'could', 'should',
  'app', 'dashboard', 'page', 'data', 'block', 'query', 'saved', 'certified',
]);

/** Words that say how to show or ask for a number, never which number. */
const PRESENTATION_WORDS = new Set([
  'show', 'shown', 'showing', 'see', 'help', 'give', 'compare', 'comparison', 'compared', 'each', 'every', 'top', 'most',
  'best', 'worst', 'least', 'highest', 'lowest', 'largest', 'smallest', 'led', 'lead', 'leading', 'leader', 'list', 'rank',
  'ranking', 'many', 'much', 'number', 'total', 'side', 'separately', 'separate', 'together', 'one', 'coach', 'fan',
  'perform', 'performed', 'performance', 'fared', 'doing', 'went', 'trend', 'chart', 'view', 'over', 'time', 'stakeholder',
  'manager', 'like', 'look', 'looked', 'change', 'changed', 'id', 'name',
]);

/** Words of a time window ("the last 90 days"): a source answers such a question only when its own words name the window too. */
const WINDOW_WORDS = new Set([
  'last', 'past', 'recent', 'recently', 'lately', 'latest', 'current', 'today', 'yesterday', 'ytd', 'mtd', 'qtd',
  'day', 'week', 'month', 'quarter',
]);

/** One word for the ways a number is said ("scored", "PPG" and "points" are points). */
const SYNONYMS: Record<string, string[]> = {
  ppg: ['point', 'game'],
  rpg: ['rebound', 'game'],
  apg: ['assist', 'game'],
  scored: ['point'],
  scoring: ['point'],
  score: ['point'],
  scorer: ['point'],
  won: ['win'],
  victory: ['win'],
  victorie: ['win'],
  rebounder: ['rebound'],
  rebounding: ['rebound'],
  postseason: ['playoff'],
  lost: ['loss'],
  losse: ['loss'],
  // A grain is its period: "monthly revenue" is revenue by month.
  daily: ['day'],
  weekly: ['week'],
  monthly: ['month'],
  quarterly: ['quarter'],
  yearly: ['year'],
  annual: ['year'],
};

const YEAR = /^(?:18|19|20|21)\d{2}$/;

/** The words of a text that name a subject, stemmed ("wins" → "win") and with their synonyms. */
export function subjectWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().replace(/'s\b/g, '').split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    const token = raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
    if (STOP_WORDS.has(token) || STOP_WORDS.has(raw) || PRESENTATION_WORDS.has(token) || PRESENTATION_WORDS.has(raw)) continue;
    // A small count ("top 3") says how many to show; a year is a subject.
    if (/^\d+$/.test(token) && !YEAR.test(token)) continue;
    const synonyms = SYNONYMS[token] ?? SYNONYMS[raw];
    if (synonyms) synonyms.forEach((word) => words.add(word));
    else if (token.length > 1) words.add(token);
  }
  return words;
}

/** The years a text names ("2014-2018" names 2014 and 2018). */
export function namedYears(text: string): number[] {
  return Array.from(new Set((text.match(/\b(?:18|19|20|21)\d{2}\b/g) ?? []).map(Number))).sort((left, right) => left - right);
}

/** A source's own words: its name, description, example question and field names. */
function sourceEvidence(candidate: Pick<AppSourceCatalogRecord, 'title' | 'name' | 'description' | 'capabilities'> & { reasons?: readonly string[] }): string {
  const dataset = candidate.capabilities.dataset;
  return [
    candidate.title,
    candidate.name,
    candidate.description ?? '',
    ...(candidate.reasons ?? []),
    ...candidate.capabilities.outputs,
    ...candidate.capabilities.measures,
    ...candidate.capabilities.dimensions,
    ...(dataset?.fields ?? []).map((field) => field.name),
  ].join(' ');
}

/** The words a source's name and description use for what it shows, without its field names. */
function sourceTitleText(candidate: Pick<AppSourceCatalogRecord, 'title' | 'name' | 'description'>): string {
  return [candidate.title, candidate.name, candidate.description ?? ''].join(' ');
}

/** The share of `wanted` found in `available` (1 when nothing is wanted). */
function share(wanted: Set<string>, available: Set<string>): number {
  if (wanted.size === 0) return 1;
  let found = 0;
  for (const word of wanted) if (available.has(word)) found += 1;
  return found / wanted.size;
}

export type SourceQuestionMatch = 'exact' | 'near';

/**
 * Whether a certified source answers a question as it is, by its own words: every subject word of its name is
 * in the question ("wins" in "Warriors Regular Season Wins 2016" never answers points per game), the question's
 * words are in its name, description or fields, and it covers exactly the years the question names ("wins
 * 2014–2018" never matches "wins in 2016"). `exact` when nearly every word of the question is the source's;
 * `near` when most are. Undefined otherwise.
 */
export function sourceAnswersQuestion(
  question: string,
  candidate: Pick<AppSourceCatalogRecord, 'title' | 'name' | 'description' | 'capabilities'> & { reasons?: readonly string[] },
): SourceQuestionMatch | undefined {
  const asked = subjectWords(question);
  if (asked.size === 0) return undefined;
  const nameWords = subjectWords(candidate.name || candidate.title);
  if (nameWords.size === 0) return undefined;
  const askedYears = namedYears(question);
  const sourceYears = namedYears(sourceTitleText(candidate));
  if (askedYears.join(',') !== sourceYears.join(',')) return undefined;
  const named = share(nameWords, asked);
  const covered = share(asked, subjectWords(sourceEvidence(candidate)));
  if (named < 1) return undefined;
  if (covered >= 0.8) return 'exact';
  if (covered >= 0.6) return 'near';
  return undefined;
}

/**
 * Whether a source's own words answer a question well enough for the planner's pick to cover it, though the
 * question does not spell the field names ("How did the Warriors perform in each season?" by a saved query of
 * the Warriors' wins by season). Most of the question's subject words are the source's, and any year it names
 * is one the source covers.
 */
export function sourceEvidenceAnswersQuestion(
  question: string,
  candidate: Pick<AppSourceCatalogRecord, 'title' | 'name' | 'description' | 'capabilities'> & { reasons?: readonly string[] },
  /** What the tile itself shows: its measures, groups and their periods ("month"). */
  shown: readonly string[] = [],
): boolean {
  const asked = subjectWords(question);
  if (asked.size === 0) return false;
  const askedYears = namedYears(question);
  const sourceYears = namedYears(sourceTitleText(candidate));
  if (askedYears.length && sourceYears.length) {
    const from = sourceYears[0]!;
    const to = sourceYears[sourceYears.length - 1]!;
    if (askedYears.some((year) => year < from || year > to)) return false;
  }
  const evidence = subjectWords([sourceEvidence(candidate), ...shown].join(' '));
  if (Array.from(asked).some((word) => WINDOW_WORDS.has(word) && !evidence.has(word))) return false;
  return share(asked, evidence) >= 0.6;
}

/**
 * The names a question gives (capitalised words after its first: "Golden State Warriors", "Lakers"). A question
 * the planner wrote is the person's own only when it names nothing, or names something the request names too
 * (V13: "What was the Golden State Warriors' points per game in the 2016 playoffs?" for "Show the top scorers in
 * the 2016 playoffs and how many points each one scored").
 */
export function questionGroundedInRequest(question: string, request: string): boolean {
  const names = question.split(/\s+/).slice(1)
    .map((word) => word.replace(/['’]s$/i, '').replace(/[^A-Za-z0-9]/g, ''))
    .filter((word) => /^[A-Z][a-z]/.test(word) && !STOP_WORDS.has(word.toLowerCase()));
  if (names.length === 0) return true;
  const asked = new Set(request.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(Boolean));
  return names.some((name) => asked.has(name.toLowerCase()));
}

/**
 * Candidates whose own name names part of the request, every word of it ("Warriors Ppg Regular Vs Playoffs 2016"
 * in a request for the Warriors' 2016 points per game, regular season and playoffs), certified first: these reach
 * the planner first. The rest keep their order.
 */
export function namedInRequestFirst<T extends Pick<AppSourceCatalogRecord, 'title' | 'name' | 'trust'>>(request: string, candidates: readonly T[]): T[] {
  const asked = subjectWords(request);
  const askedYears = new Set(namedYears(request));
  const score = (candidate: T): number => {
    const nameWords = subjectWords(candidate.name || candidate.title);
    if (nameWords.size === 0) return 0;
    const years = namedYears(candidate.name || candidate.title);
    if (years.some((year) => !askedYears.has(year))) return 0;
    if (share(nameWords, asked) < 1) return 0;
    // The more of the request a name says, the more exactly it answers it.
    return (candidate.trust === 'certified' ? 2 : 1) + nameWords.size / 100;
  };
  return candidates
    .map((candidate, index) => ({ candidate, index, score: score(candidate) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.candidate);
}

/** Whether the candidate's own name names part of the request (see `namedInRequestFirst`). */
export function namedInRequest(request: string, candidate: Pick<AppSourceCatalogRecord, 'title' | 'name'>): boolean {
  const nameWords = subjectWords(candidate.name || candidate.title);
  if (nameWords.size === 0) return false;
  const askedYears = new Set(namedYears(request));
  if (namedYears(candidate.name || candidate.title).some((year) => !askedYears.has(year))) return false;
  return share(nameWords, subjectWords(request)) === 1;
}

/**
 * A source's name as a tile or App title: "warriors_ppg_regular_vs_playoffs_2016" reads "Warriors PPG Regular vs
 * Playoffs 2016". A name already written with spaces is kept.
 */
export function readableSourceTitle(title: string): string {
  const trimmed = title.trim();
  if (/\s/.test(trimmed)) return trimmed;
  return trimmed.split(/[_-]+/).filter(Boolean).map((word) => {
    const lower = word.toLowerCase();
    if (lower === 'vs' || lower === 'and' || lower === 'of' || lower === 'by' || lower === 'in' || lower === 'the') return lower;
    if (/^[a-z]{2,4}$/.test(lower) && !/[aeiouy]/.test(lower)) return lower.toUpperCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ').replace(/^./, (first) => first.toUpperCase());
}
