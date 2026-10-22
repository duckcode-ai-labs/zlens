import { createHash } from 'node:crypto';
import type { AgentProvider, ProviderRunOptions } from '../providers/types.js';
import { executeCandidate, fillPeriodGaps, statementFailure, type ExecuteDeps, type ExecutedRows } from './execute.js';
import { describeIntent, intentExecutionFingerprint, intentRefs, type AnalyticalIntentV1, type IntentPredicate } from './intent.js';
import { composeAnsweredText, composeFailedText, composeGapText, describeResultColumns, labelFor, type AskStoryStepV1, type ContextLedgerV1, type GapKind, type PipelineOutcome, type PipelineReceipt } from './outcomes.js';
import { entails, prepare, type PrepareDeps, type PreparedCandidate, type PreparedRefusal, type PrepareResult } from './prepare/index.js';
import { blocksNamedByQuestion } from './named-blocks.js';
import { applySkillPolicies } from './policies.js';
import { proveLiterals } from './literal-proof.js';
import { prepareExploratory } from './prepare/exploratory.js';
import { isGovernedEntry, keepMembersApart, normalizeEffectiveIntent, resolveIntent, uncoveredQuestionTerms, coverageStates, unmetFacets, type IntentResolution, causalOperatorsIn, predictiveOperatorsIn, readingLane, validateIntentRefs } from './resolve-intent.js';
import { buildVocabularyIndex, renderCard, type RenderedCards, type VocabularyDomainHeader, type VocabularyEntry, type VocabularyIndex } from './vocabulary.js';
import { readByOwnWords } from './lexical-reading.js';
import { mergePhysicalRelationBinding, physicalRelationIdentity, physicalRelationText, samePhysicalRelation } from './physical-binding.js';

/**
 * INTENT → PREPARE → EXECUTE, as one host-neutral function.
 *
 * The host supplies the vocabulary, the provider, the compilers and the
 * warehouse; this function owns the order and the bounds. Bounds are a
 * wall-clock deadline, one bounded corrective re-ask, one preparation
 * repair, and the rule that an unchanged failed attempt is never repeated
 * (the fingerprint of intent + tier + bindings is remembered). Every
 * provider call is reported so the host's one ledger counts it.
 */

export interface PreparationCache {
  get(key: string): PreparedCandidate | undefined;
  set(key: string, candidate: PreparedCandidate): void;
}

/**
 * What the run that first prepared a candidate tried before it settled on it
 * (which tiers, and why the ones it passed over said no). A reused preparation
 * replays this, so a later run's trace still shows that the certified tier was
 * tried and why a block was not used, instead of showing no tier at all.
 */
const preparedWith = new WeakMap<PreparedCandidate, { tiers: PipelineReceipt['tiers']; refusals: PreparedRefusal[] }>();

export interface RunAskPipelineInput {
  question: string;
  vocabulary: VocabularyIndex;
  provider: AgentProvider;
  prepareDeps: PrepareDeps;
  executeDeps: ExecuteDeps;
  prior?: AnalyticalIntentV1;
  /** False when the prior turn was blocked: its question stands, its result does not exist. */
  priorExecuted?: boolean;
  priorAnswerSummary?: string;
  /** The earlier reading's values may not reach this model (RFC 0010 HH-5): it reads them named by position. */
  hidePriorValues?: boolean;
  guidance?: string;
  /** The governed meaning the user picked from a clarification's options. */
  selection?: { ref: string; label?: string };
  /** False for research branches: their questions are hypotheses, not asks for causes or decisions. */
  clauseCoverage?: boolean;
  explorationOptIn?: boolean;
  /** Run the review-required SQL tier on its own when nothing governed prepares; false keeps it opt-in. */
  explorationAuto?: boolean;
  /**
   * Where nothing is governed, the SQL is drafted from the question itself,
   * before (and usually instead of) the reading step. The reading turns a
   * question into governed refs; with none to choose from it only restates
   * the question for the drafter, and a restatement can change the question's
   * shape ("the median of per-country totals" read as "the median per
   * country"). A follow-up, an answer to a clarification, a forecast or a
   * question about causes still goes through the reading, and a question the
   * drafter declines falls back to it. Supplied by the host where it applies.
   */
  draftFirst?: boolean;
  /**
   * Host-owned on-demand description of relations the probe had not described
   * (their columns and types), used once when a reading leaves a clause
   * unresolved while naming a relation whose columns it could not see.
   */
  describeRelations?: (relations: string[]) => Promise<Array<{
    database?: string;
    schema?: string;
    name: string;
    description?: string;
    columns: Array<{ name: string; dataType?: string; description?: string }>;
    columnCompleteness?: 'complete' | 'partial' | 'unknown';
    observedAt?: string;
    truncated?: boolean;
    binding?: NonNullable<VocabularyEntry['physical']>['binding'];
  }>>;
  /**
   * The host owns the request-local vocabulary used after discovery.  It must
   * update its final SQL validator, executor and receipt at the same instant
   * that the interpreter sees hydrated columns; otherwise those stages can
   * disagree about an exact Snowflake binding.
   */
  onVocabularyUpdate?: (vocabulary: VocabularyIndex) => void;
  /**
   * A second look at an AI-drafted result before it is answered: does what
   * came back answer the question as asked? The host decides what the look
   * may see (the result's shape, never its values) and returns the one defect
   * it found, or nothing. Absent, nothing changes.
   */
  reviewResult?: (input: { question: string; sql: string; result: { columns?: Array<string | { name: string }>; rows: Array<Record<string, unknown>>; rowCount: number } }) => Promise<{ revise: string } | undefined>;
  deadlineMs?: number;
  /** Host cancellation for the entire request; no new phase starts after it fires. */
  signal?: AbortSignal;
  cardBudget?: number;
  providerOptions?: ProviderRunOptions;
  preparationCache?: PreparationCache;
  /** Keys that make a prepared executable reusable: snapshot, engine, target, policy. */
  cacheScope?: string;
  build?: Record<string, string>;
  now?: () => number;
  trace?: (event: { stage: string; detail?: unknown }) => void;
  /** Each step of the run's story as it finishes, for a live progress view; the same steps are kept on `receipt.story`. */
  onStep?: (step: AskStoryStepV1) => void;
  /**
   * Host-owned literal grounding: replace a member literal with the value
   * the warehouse actually holds (its casing, its spelling) on columns the
   * project explicitly allowlists, and say so. Never invents a value.
   */
  groundLiterals?: (intent: AnalyticalIntentV1) => Promise<{ intent: AnalyticalIntentV1; notes: string[] }>;
  /**
   * The members of a column whose stored value CONTAINS a literal, asked only
   * after an exact match on that same column returned nothing. "Curry" is not
   * absent from the data; it names two players, and the honest answer shows
   * both rather than reporting the surname as unknown.
   */
  suggestMembers?: (ref: string, literal: string) => Promise<string[]>;
  /**
   * The member the user picked from an identity clarification: the dimension
   * and the values chosen. A name that reads several people is settled by the
   * person asking, never by the interpreter's prose or by adding them up.
   */
  memberSelection?: { ref: string; values: string[] };
  /**
   * How the host built the vocabulary this turn reads (CTX-010): the resolved
   * envelope, what the pack retrieved and admitted, the refs retrieval ranked
   * first, and the domain header. Recorded in the receipt's context ledger.
   */
  context?: {
    packId?: string;
    snapshotId?: string;
    envelope?: ContextLedgerV1['envelope'];
    retrieved?: ContextLedgerV1['retrieved'];
    admitted?: ContextLedgerV1['admitted'];
    rankedRefs?: string[];
    header?: VocabularyDomainHeader;
    columnsFor?: { shown: number; total: number };
    /** Where the host's context assembly spent its time, by phase (ms). */
    timings?: Record<string, number>;
  };
  /** The thread's compacted memory: what was settled earlier, and a clarification still pending. */
  conversation?: { summary?: string; pendingClarification?: string };
  /**
   * A reading settled elsewhere: an intent Research built for one of its
   * programs, or the reading of an answer the user asked to investigate. No AI
   * reads the question and no repair re-reads it; the refs are validated as a
   * reading's are, and every later stage (literal proofs, grounding, policies,
   * tiers, execution) runs unchanged.
   */
  resolvedIntent?: { intent: AnalyticalIntentV1; origin: 'research_program' | 'source_run' };
  /** `reading`: stop once the reading is proven and policed; nothing is prepared, drafted or executed. */
  stopAfter?: 'reading';
}

const fingerprintSql = (sql: string) => `sha256:${createHash('sha256').update(sql).digest('hex').slice(0, 24)}`;

function summarizeRefusal(refusal: PreparedRefusal): string {
  const firstLine = refusal.message.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? refusal.message;
  const clipped = firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
  return refusal.code === 'semantic_compile_failed' ? `the semantic engine could not compile this reading: ${clipped}` : clipped;
}

function gapFromRefusals(refusals: PreparedRefusal[], intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): { gap: GapKind; message: string; nearest: string[] } {
  const denied = refusals.find((refusal) => refusal.code === 'policy_denied' || refusal.code === 'join_requires_domain_contract' || (refusal.code === 'policy_filter_unbindable' || refusal.code === 'policy_conflict'));
  if (denied) return { gap: 'denied', message: denied.message, nearest: [] };
  // A declared relationship nobody validated is an offer, not a path: the
  // reader is told exactly which one and what would make the join possible.
  const offered = refusals.find((refusal) => refusal.code === 'join_path_required' && refusal.unproven?.length);
  if (offered?.unproven?.length) {
    const offer = offered.unproven[0]!;
    return { gap: 'not_modeled', message: `no certified relationship reaches ${offered.relations?.[1] ?? offer.to} from ${offered.relations?.[0] ?? offer.from}. The declared relationship ${offer.relationshipId} (${offer.keys.map((key) => `${key.from} = ${key.to}`).join(', ')}) is ${offer.status === 'draft' ? 'a draft that has not been validated' : offer.reason}; validate it in Domain Studio and Ask will use it`, nearest: [] };
  }
  const unknownDomain = refusals.find((refusal) => refusal.code === 'relationship_domain_unknown');
  if (unknownDomain) return { gap: 'not_modeled', message: unknownDomain.message, nearest: [] };
  const unresolved = intent.unresolved.filter((clause) => clause.material);
  if (unresolved.length) return { gap: 'ambiguous', message: unresolved.map((clause) => clause.clause).join('; '), nearest: unresolved.flatMap((clause) => clause.options) };
  // AN AUTHORED SEMANTIC METRIC ONLY THE ENGINE COMPUTES. The relational and
  // generated-SQL tiers refuse to rebuild it by design, so the reason worth
  // reading is why the semantic engine itself did not answer (no layer
  // loaded, a field it does not hold, a compile error), never only the line
  // saying the other tiers will not approximate the definition.
  const engineOwned = [...new Set(intent.measures.flatMap((measure) => measure.change ? [] : measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref])
    .map((ref) => vocabulary.get(ref)).filter((entry) => Boolean(entry?.engineOnly)).map((entry) => entry!.label ?? entry!.name))];
  const engineRefusal = engineOwned.length ? refusals.find((refusal) => refusal.tier === 'semantic') : undefined;
  if (engineRefusal && engineRefusal.code !== 'semantic_compile_failed') {
    return { gap: 'unsupported', message: `the semantic engine did not answer ${engineOwned.join(', ')} (${summarizeRefusal(engineRefusal).replace(/[.\s]+$/, '')}), and generated SQL will not rebuild an authored semantic metric`, nearest: [] };
  }
  const compile = refusals.find((refusal) => refusal.code === 'semantic_compile_failed' || refusal.code === 'semantic_engine_required' || refusal.code === 'relational_compose_failed' || refusal.code === 'join_path_required' || refusal.code === 'measure_scope_not_expressible');
  const nearest = [...new Set(intent.measures.flatMap((measure) => vocabulary.suggest(measure.ref, 3).map((entry) => entry.ref)))].filter((ref) => !intent.measures.some((measure) => measure.ref === ref)).slice(0, 5);
  // The reader gets the first line of the engine's message; the receipt keeps it verbatim.
  if (compile) return { gap: 'unsupported', message: summarizeRefusal(compile), nearest };
  // The deepest governed refusal is the one worth reading. A project with no
  // certified blocks refuses at the certified tier for every question ever
  // asked, so "the project has no certified block" tells nobody why THIS
  // question stopped; the binding or composition failure underneath does.
  const depth = (refusal: PreparedRefusal): number => (refusal.code === 'no_certified_block' ? 3 : refusal.tier === 'certified' ? 2 : refusal.tier === 'semantic' ? 1 : 0);
  const deepest = [...refusals.filter((refusal) => refusal.tier !== 'exploratory')].sort((left, right) => depth(left) - depth(right))[0];
  return { gap: 'not_modeled', message: deepest?.message ?? 'no governed tier could prepare the intent', nearest };
}

/**
 * THE LABEL THE QUESTION ASKED FOR. "Which teams" is answered by names. When a
 * repair dropped the requested label because no governed relationship reaches
 * it, the rows carry a key and nothing else. The numbers may still be right,
 * so the answer is served, but the omission is named and the check does not
 * pass: opaque identifiers do not answer "which".
 */
export function unmetDisplayObligation(
  requested: string[],
  intent: AnalyticalIntentV1,
  refusals: PreparedRefusal[],
  label: (ref: string) => string,
  question?: string,
): { message: string; refs: string[] } | undefined {
  const keys = intent.groupBy.filter((group) => group.role === 'key');
  if (keys.length === 0 || intent.display.length > 0) return undefined;
  const lost = requested.filter((ref) => !intent.display.includes(ref) && !intent.groupBy.some((group) => group.ref === ref) && !(intent.provenance[ref] ?? '').startsWith('removed'));
  // A question that asks WHICH ones is answered by names. Even when no reading
  // ever asked for the label, rows identified only by a key have not answered
  // it — unless the question asked for the ids themselves.
  const asksWhich = Boolean(question && /\b(which|who|whom|whose|name|names|list)\b/i.test(question) && !/\b(id|ids|identifier|identifiers|key|keys)\b/i.test(question));
  if (lost.length === 0 && !asksWhich) return undefined;
  const join = refusals.find((refusal) => refusal.code === 'join_path_required');
  const because = join ? `, because ${summarizeRefusal(join).replace(/^no governed join path/, 'no governed relationship reaches it')}` : ' from this reading';
  const identified = keys.map((group) => label(group.ref)).join(', ');
  return {
    message: lost.length
      ? `the rows are identified by ${identified} only: ${lost.map((ref) => label(ref)).join(', ')} could not be shown beside them${because}`
      : `the rows are identified by ${identified} only: this project's governed vocabulary reaches no human-readable label for them${because}`,
    refs: lost,
  };
}

/** Words a capitalised run may start with and still be a name the question stresses. */
const NAME_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'by', 'to', 'from', 'at', 'with', 'show', 'give', 'compare', 'how', 'what', 'which', 'who', 'whose', 'when', 'where', 'why', 'did', 'do', 'does', 'is', 'are', 'was', 'were', 'our', 'my', 'their', 'his', 'her', 'its']);

/**
 * A NAME THE QUESTION LEANS ON. Capitalised runs of the question that are not
 * its first word, not vocabulary words, and not numbers: the candidates for
 * "whose facts is this about". This is a hint, never a proof — everything
 * built on it must be confirmed against the warehouse before it changes an
 * answer.
 */
export function namesInQuestion(question: string, vocabulary: VocabularyIndex): string[] {
  const names: string[] = [];
  for (const sentence of question.split(/(?<=[.?!])\s+/)) {
    const tokens = [...sentence.matchAll(/[A-Za-z][A-Za-z'`.-]*/g)];
    let run: string[] = [];
    let runStart = -1;
    const flush = () => {
      if (run.length > 0) {
        const first = run[0]!.toLowerCase();
        const capitalisedStart = runStart > 0 || run.length > 1;
        // A possessive is the name plus grammar: "LeBron James's" is a man.
        if (capitalisedStart && !NAME_STOPWORDS.has(first)) names.push(run.join(' ').replace(/['’]s$/i, '').replace(/[.'’]+$/, ''));
      }
      run = [];
    };
    for (const [index, token] of tokens.entries()) {
      const word = token[0];
      if (/^[A-Z]/.test(word) && !NAME_STOPWORDS.has(word.toLowerCase())) {
        if (run.length === 0) runStart = index;
        run.push(word);
        continue;
      }
      flush();
    }
    flush();
  }
  // A word this project already names something by is a term, not a person.
  return [...new Set(names)].filter((name) => !vocabulary.lookup(name, { limit: 1, minScore: 0.9 }).length);
}

/**
 * THE SUBJECT THE READING CLAIMS MUST BE IN THE POPULATION. An interpretation
 * that says "LeBron James's total points" and restricts nobody answers for
 * every player in the warehouse under one man's name, and every check passes:
 * the SQL is valid, the filters it does carry are all applied, the number is
 * real. The host therefore checks the reading's own claim against its own
 * filters, and where a name is missing it asks the warehouse whether that name
 * is a member. A member it confirms becomes the restriction the reading
 * promised; a name the warehouse does not hold changes nothing, because this
 * reading of prose is a hint and a hint may not rewrite an answer.
 */
export async function bindNamedSubject(
  intent: AnalyticalIntentV1,
  question: string,
  vocabulary: VocabularyIndex,
  suggestMembers: (ref: string, literal: string) => Promise<string[]>,
  maxProbes = 3,
): Promise<string[]> {
  if (intent.kind !== 'analytics') return [];
  // A filter carries a name only when it carries THAT name. "Curry" is not
  // Stephen Curry: a broader match is exactly the case where the reading names
  // one person and the query reads several, and it is what this proves away.
  const bound = new Set(intent.filters.flatMap((filter) => filter.values.filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase())));
  const claimed = namesInQuestion(question, vocabulary)
    .filter((name) => intent.reading.toLowerCase().includes(name.toLowerCase()))
    .filter((name) => !bound.has(name.toLowerCase()));
  if (claimed.length === 0) return [];
  // Only the label columns of the relations this reading already reads.
  const relations = new Set(intent.measures.flatMap((measure) => {
    const refs = measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref];
    return refs.map((ref) => vocabulary.get(ref)?.physical?.relation).filter((relation): relation is string => Boolean(relation));
  }));
  // A column that can hold a person's name: not a date, a number, a flag or a
  // key. The role is a hint and not every project spells its label columns the
  // same way — a dimension called "player" over a player_name column is a
  // label whatever the heuristic said — so the columns a name COULD live in
  // are probed, most likely first, and the warehouse decides.
  const named = (entry: VocabularyEntry): boolean =>
    (entry.kind === 'dimension' || entry.kind === 'column')
    && Boolean(entry.physical?.relation)
    && !entry.roles.some((role) => role === 'time' || role === 'numeric' || role === 'boolean' || role === 'key' || role === 'measure');
  const rank = (entry: VocabularyEntry): number =>
    Number(relations.has(entry.physical!.relation)) * 2 + Number(entry.roles.includes('label'));
  const labels = vocabulary.entries.filter(named).sort((left, right) => rank(right) - rank(left));
  const notes: string[] = [];
  let probes = 0;
  for (const name of claimed) {
    for (const entry of labels) {
      if (probes >= maxProbes) return notes;
      probes += 1;
      let members: string[] = [];
      try { members = await suggestMembers(entry.ref, name); } catch { continue; }
      const exact = members.find((member) => member.toLowerCase() === name.toLowerCase());
      if (!exact) continue;
      // A broader restriction on the same column is REPLACED, not added to:
      // "contains Curry" beside "is Stephen Curry" would read as both.
      const existing = intent.filters.findIndex((filter) => filter.ref === entry.ref && filter.on !== 'aggregate');
      const broadened = existing >= 0;
      const applied: IntentPredicate = { ref: entry.ref, op: 'eq', values: [exact], source: 'question' };
      if (broadened) intent.filters[existing] = applied; else intent.filters.push(applied);
      intent.provenance[entry.ref] = `host:the reading is about ${exact}, and the warehouse holds that member: the reading's own subject is what the query reads`;
      notes.push(`identity: the reading names ${JSON.stringify(exact)} and the restriction ${broadened ? 'was broader than that name' : 'was missing'}; ${entry.label ?? entry.name} holds that member exactly, so the query reads it`);
      return notes;
    }
  }
  return notes;
}

/** The id an identity clarification option carries: the dimension, and the values the user picked. */
export function memberOptionId(ref: string, values: string[]): string {
  return `member:${ref}=${JSON.stringify(values)}`;
}

/** The dimension and values behind such an id; anything else is not one. */
export function parseMemberOption(id: string): { ref: string; values: string[] } | undefined {
  if (!id.startsWith('member:')) return undefined;
  const split = id.indexOf('=');
  if (split <= 'member:'.length) return undefined;
  const ref = id.slice('member:'.length, split);
  try {
    const values = JSON.parse(id.slice(split + 1)) as unknown;
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string') || values.length === 0) return undefined;
    return { ref, values: values as string[] };
  } catch { return undefined; }
}

/**
 * THE MEMBER THE USER PICKED. An identity clarification comes back as the
 * dimension and the values chosen: the reading's filter on that dimension
 * becomes exactly those values, and several chosen members are separated so
 * each one keeps its own row. The user settles an identity the data could not.
 */
export function applyMemberSelection(intent: AnalyticalIntentV1, selection: { ref: string; values: string[] }, vocabulary: VocabularyIndex): void {
  if (intent.kind !== 'analytics' || selection.values.length === 0) return;
  const applied: IntentPredicate = { ref: selection.ref, op: selection.values.length === 1 ? 'eq' : 'in', values: [...selection.values], source: 'clarification' };
  const index = intent.filters.findIndex((filter) => filter.ref === selection.ref && filter.on !== 'aggregate');
  if (index >= 0) intent.filters[index] = applied; else intent.filters.push(applied);
  intent.provenance[selection.ref] = `clarification:the ${selection.values.length === 1 ? 'member' : 'members'} you chose`;
  const subject = selection.values.join(', ');
  if (!selection.values.every((value) => intent.reading.toLowerCase().includes(value.toLowerCase()))) {
    intent.reading = `${intent.reading.replace(/[.\s]+$/, '')} — for ${subject}.`;
  }
  if (selection.values.length > 1) keepMembersApart(intent, vocabulary);
}

/**
 * THE SUBJECT AND THE POPULATION ARE THE SAME THING. A member filter carrying
 * several values reads several members; with no breakdown at all, their facts
 * are added into one row that belongs to nobody — and the prose above it will
 * still name whoever the interpreter had in mind. The proof is structural: it
 * never reads the prose, and it runs before an executable is accepted, so no
 * path that widens a filter can serve one name over many people's numbers.
 */
export function proveSubjectMatchesPopulation(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): string | undefined {
  if (intent.kind !== 'analytics' || intent.groupBy.length > 0) return undefined;
  for (const filter of intent.filters) {
    if (filter.on === 'aggregate') continue;
    const values = filter.values.filter((value): value is string => typeof value === 'string');
    if (values.length < 2) continue;
    const entry = vocabulary.get(filter.ref);
    if (!entry || (entry.kind !== 'dimension' && entry.kind !== 'column' && entry.kind !== 'entity')) continue;
    if (entry.roles.includes('time') || entry.roles.includes('numeric') || entry.roles.includes('boolean')) continue;
    return `${entry.label ?? entry.name} reads ${values.length} members (${values.join(', ')}) and the reading separates none of them: one row would carry all of their facts together`;
  }
  return undefined;
}

/**
 * The refs the question names OUTRIGHT: exact ref, name or alias hits for its
 * words and word pairs. Bounded (the first forty words), spelling-exact, and
 * proposals only — pinning changes what renders first, never what resolves.
 */
export function pinnedRefsFor(question: string, vocabulary: VocabularyIndex): string[] {
  const words = question.split(/[^A-Za-z0-9_']+/).filter((word) => word.length > 2).slice(0, 40);
  const terms = new Set<string>();
  for (let index = 0; index < words.length; index += 1) {
    terms.add(words[index]!);
    if (index + 1 < words.length) terms.add(`${words[index]} ${words[index + 1]}`);
    if (index + 2 < words.length) terms.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  const pinned: string[] = [];
  for (const term of terms) {
    for (const hit of vocabulary.lookup(term, { limit: 3, minScore: 0.95 })) {
      if ((hit.matchedOn === 'ref' || hit.matchedOn === 'name' || hit.matchedOn === 'alias') && !pinned.includes(hit.entry.ref)) pinned.push(hit.entry.ref);
    }
  }
  return pinned;
}

/**
 * The retired block a question names, when the answer comes from its
 * replacement. Matching is on whole words of the retired block's name, so
 * "claims summary" in a question finds a retired "Claims Summary".
 */
export function retiredBlockNamedBy(question: string, entry: VocabularyEntry | undefined): { name: string; deprecatedOn?: string } | undefined {
  if (!entry?.supersedes?.length) return undefined;
  const words = (value: string) => ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const asked = words(question);
  return entry.supersedes.find((retired) => {
    const name = words(retired.name);
    return name.trim().length > 0 && asked.includes(name);
  });
}

/**
 * The certified block a question holds the answer to: the one it names as a
 * block, or, for a follow-up, the block the previous answer ran when this
 * reading still names it (by ref, or as a block in its own words).
 */
export function heldCertifiedBlock(input: Pick<RunAskPipelineInput, 'question' | 'vocabulary' | 'prior' | 'priorExecuted'>, intent: AnalyticalIntentV1): { entry: VocabularyEntry; how: 'named' | 'follow-up' } | undefined {
  const blocks = input.vocabulary.entries.filter((entry) => entry.kind === 'block' && entry.certified);
  if (blocks.length === 0) return undefined;
  const byName = (names: string[]) => names.map((name) => blocks.find((block) => block.name === name)).find((block): block is VocabularyEntry => Boolean(block));
  const named = byName(blocksNamedByQuestion(input.question, blocks.map((block) => block.name)));
  if (named) return { entry: named, how: 'named' };
  if (!input.prior || input.priorExecuted === false) return undefined;
  const priorBlock = input.prior.measures.map((measure) => measure.ref).find((ref) => blocks.some((block) => block.ref === ref));
  if (!priorBlock) return undefined;
  const entry = blocks.find((block) => block.ref === priorBlock)!;
  const keeps = intent.measures.some((measure) => measure.ref === entry.ref) || blocksNamedByQuestion(intent.reading, [entry.name]).length > 0;
  return keeps ? { entry, how: 'follow-up' } : undefined;
}

/**
 * The reading re-expressed as the named block's answer: the block is the one
 * measure; the restrictions, groupings, period, ordering and row count the
 * question asked for stay, so the block's contract decides whether it can
 * honour them. Clauses that only name the block are not open questions.
 */
export function readAsBlock(intent: AnalyticalIntentV1, block: VocabularyEntry): AnalyticalIntentV1 {
  return {
    ...intent,
    measures: [{ ref: block.ref }],
    ...(intent.ordering ? { ordering: { ref: 'measure:0', direction: intent.ordering.direction } } : {}),
    unresolved: intent.unresolved.filter((clause) => !nameWords(clause.clause).includes(nameWords(block.name))),
    provenance: { ...intent.provenance, [block.ref]: intent.provenance[block.ref] ?? 'q:named block' },
  };
}

const nameWords = (value: string): string => ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Why a named certified block cannot answer, and what it does answer, in words. */
export function heldBlockRefusal(block: VocabularyEntry, missing: string[]): string {
  const contract = block.contract;
  const accepts = [...new Set([...(contract?.allowedFilters ?? []), ...(contract?.parameters ?? [])])];
  const fixed = (contract?.periods ?? []).map((period) => `${period.column} from ${period.start} up to ${period.end}`);
  const returns = contract?.outputs.length ? ` It returns ${contract.outputs.join(', ')}${fixed.length ? ` for ${fixed.join(' and ')}` : ''}` : '';
  const takes = returns ? `${accepts.length ? `, and accepts ${accepts.join(', ')}` : ', and accepts no filters'}.` : '';
  // The entailment's reasons are written for the governed repair ("the answer
  // is composed by entity key instead"); a refusal says only what is missing.
  const reasons = [...new Set(missing.map((reason) => reason.replace(/;\s*the answer is composed[\s\S]*$/, '').replace(/, so it cannot bound the period$/, '')))];
  return `The certified saved query "${block.name}" cannot answer this as asked: ${reasons.join('; ')}.${returns}${takes}`;
}

/** The sentence a run tells when it answers a retired block's question from its replacement. */
export function retiredBlockSentence(retired: { name: string; deprecatedOn?: string }, replacement: string): string {
  return `${retired.name} was retired${retired.deprecatedOn ? ` on ${retired.deprecatedOn}` : ''}; answered from ${replacement}`;
}

/** Guidance that carries a settled identity into the reading the interpreter writes. */
function memberGuidance(input: RunAskPipelineInput): string | undefined {
  if (!input.memberSelection) return input.guidance;
  const chosen = input.memberSelection.values.join(', ');
  const said = `The person asking has settled who this is about: ${chosen}. Read the question about ${input.memberSelection.values.length === 1 ? 'that member' : 'those members'} and name no other.`;
  return input.guidance ? `${input.guidance}\n${said}` : said;
}

/**
 * Merge a warehouse description into the one vocabulary this request uses.
 *
 * `buildVocabularyIndex()` intentionally keeps a short relation ref for a
 * one-relation source.  That is the wrong identity when the full inventory
 * already contains DB_A.PUBLIC.EVENTS and DB_B.PUBLIC.EVENTS.  Merge by the
 * exact parsed physical binding and retain the inventory's canonical ref so a
 * request-local recovery cannot re-introduce an unsafe PUBLIC.EVENTS alias.
 */
export function mergeDiscoveredRelations(
  vocabulary: VocabularyIndex,
  relations: Parameters<typeof buildVocabularyIndex>[0]['relations'] extends infer T ? NonNullable<T> : never,
): VocabularyIndex {
  if (!relations.length) return vocabulary;
  const discovered = buildVocabularyIndex({ relations });
  const extra: VocabularyEntry[] = [];
  const existingRelations = vocabulary.entries.filter((entry) => entry.kind === 'relation');

  // A warehouse description answers for the object it was asked about: dbt may
  // have spelled it quoted (`"nba"."dev"."t"`) and the warehouse reports it
  // bare, so the match is by names, case-insensitive, never by quote state —
  // otherwise one object gets two bindings and the composer's same-relation
  // rebinding (a name read on the base relation instead of a join) gives up.
  const looseIdentity = (binding: NonNullable<VocabularyEntry['physical']>['binding'] | undefined) => binding
    ? [binding.database, binding.schema, binding.table].filter(Boolean).map((part) => part!.value.toLowerCase()).join('.')
    : undefined;
  for (const discoveredRelation of discovered.entries.filter((entry) => entry.kind === 'relation')) {
    const discoveredBinding = discoveredRelation.physical?.binding;
    const exactExisting = discoveredBinding
      ? existingRelations.find((entry) => {
        const existingBinding = entry.physical?.binding;
        return Boolean(existingBinding && (physicalRelationIdentity(physicalRelationText(existingBinding)) === physicalRelationIdentity(physicalRelationText(discoveredBinding))
          || looseIdentity(existingBinding) === looseIdentity(discoveredBinding)));
      })
      : undefined;
    const logicalCollision = discoveredBinding
      ? existingRelations.some((entry) => entry.physical?.binding?.logicalRelation.toLowerCase() === discoveredBinding.logicalRelation.toLowerCase()
        && looseIdentity(entry.physical.binding) !== looseIdentity(discoveredBinding))
      : false;
    const canonical = exactExisting?.model
      ?? (logicalCollision && discoveredBinding ? physicalRelationText(discoveredBinding) : discoveredRelation.model ?? discoveredRelation.name);
    const relationRef = `relation:${canonical}`;
    const binding = exactExisting?.physical?.binding && discoveredBinding
      ? mergePhysicalRelationBinding(exactExisting.physical.binding, discoveredBinding).binding ?? exactExisting.physical.binding
      : discoveredBinding ?? exactExisting?.physical?.binding;
    const existingColumns = exactExisting?.columns ?? [];
    const discoveredColumns = discovered.entries
      .filter((entry) => entry.kind === 'column' && entry.physical?.binding && discoveredBinding
        && physicalRelationIdentity(physicalRelationText(entry.physical.binding)) === physicalRelationIdentity(physicalRelationText(discoveredBinding)));
    const names = [...new Set([...existingColumns, ...discoveredColumns.map((entry) => entry.name)])];
    const relation: VocabularyEntry = {
      ...(exactExisting ?? discoveredRelation),
      ref: relationRef,
      model: canonical,
      aliases: exactExisting?.aliases ?? (logicalCollision ? [canonical] : discoveredRelation.aliases),
      columns: names,
      physical: {
        relation: canonical,
        ...(binding ? { binding } : {}),
      },
    };
    extra.push(relation);
    for (const column of discoveredColumns) {
      extra.push({
        ...column,
        ref: `column:${canonical}.${column.name}`,
        model: canonical,
        physical: { relation: canonical, column: column.name, ...(binding ? { binding } : {}) },
      });
    }
    // Existing column cards must read the merged binding too; a runtime
    // description may be the first complete observation of a manifest column.
    for (const column of vocabulary.entries.filter((entry) => entry.kind === 'column' && exactExisting && entry.model === exactExisting.model)) {
      extra.push({
        ...column,
        model: canonical,
        physical: { ...(column.physical ?? { relation: canonical, column: column.name }), relation: canonical, ...(binding ? { binding } : {}) },
      });
    }
  }
  return vocabulary.withEntries(extra);
}

/** A reading settled elsewhere, held to the same ref validation as a reading the AI wrote. */
function settledResolution(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): IntentResolution {
  if (intent.kind !== 'analytics') {
    return { status: 'failed', reason: 'invalid', detail: 'a settled reading must be an analytical reading', problems: [], attempts: 0 };
  }
  const validation = validateIntentRefs(intent, vocabulary);
  if (validation.problems.length > 0) {
    return { status: 'failed', reason: 'invalid', detail: validation.problems.map((problem) => problem.message).join('; '), problems: validation.problems, attempts: 0 };
  }
  return { status: 'resolved', intent: validation.intent, attempts: 0, problems: [] };
}

export async function runAskPipeline(input: RunAskPipelineInput): Promise<PipelineOutcome> {
  // A settled reading stands in for the question wherever later stages quote it.
  const settled = input.resolvedIntent;
  if (settled) input = { ...input, question: settled.intent.reading || input.question };
  const now = input.now ?? (() => Date.now());
  const started = now();
  const deadline = input.deadlineMs ? started + input.deadlineMs : undefined;
  const timings: Record<string, number> = {};
  const receipt: PipelineReceipt = {
    version: 1, vocabularyFingerprint: input.vocabulary.fingerprint, dispatches: [], candidates: [], refusals: [], tiers: [], timings, reuse: 'none',
    ...(input.build ? { build: input.build } : {}),
  };
  const remaining = () => (deadline ? deadline - now() : Number.POSITIVE_INFINITY);
  // Provider calls (initial reading, correction and SQL draft) share the run
  // cancellation.  A caller-supplied signal takes precedence only when it is
  // the same inherited request; no helper may accidentally create a detached
  // provider call after the turn has ended.
  const providerOptions: ProviderRunOptions | undefined = input.signal
    ? { ...(input.providerOptions ?? {}), signal: input.signal }
    : input.providerOptions;
  const stopped = (stage: 'resolve' | 'prepare' | 'execute'): PipelineOutcome | undefined => {
    if (!input.signal?.aborted && remaining() > 0) return undefined;
    const message = input.signal?.aborted
      ? 'the run was cancelled before the next analytical phase could start'
      : `the run reached its deadline after ${receipt.lastCompletedPhase ?? 'starting'}; no later phase was started`;
    receipt.failure = { stage, reason: input.signal?.aborted ? 'cancelled' : 'deadline', message };
    return { kind: 'failed', stage, message, text: composeFailedText(stage, message), receipt };
  };
  const beforeResolve = stopped('resolve');
  if (beforeResolve) return beforeResolve;
  // Count only physical dispatches.  Validation/filter failures happen before
  // the warehouse boundary and must not turn into a false "attempted" receipt.
  const countedExecute: typeof executeCandidate = async (...args) => {
    const [candidate, intent, executeDeps] = args;
    let physicalAttempts = 0;
    let settled = 0;
    // Legacy host executors and test doubles may not invoke receipt hooks, but
    // each call into `run` is still one physical statement request. Keep that
    // count separately so a two-branch MetricFlow program is never recorded
    // as one warehouse attempt merely because the adapter predates hooks.
    let invoked = 0;
    const notedDeps: ExecuteDeps = {
      ...executeDeps,
      run: (sql, params, options) => {
        invoked += 1;
        return executeDeps.run(sql, params, {
        ...options,
        onWarehouseAttempt: () => {
          physicalAttempts += 1;
          receipt.warehouse = {
            attempts: (receipt.warehouse?.attempts ?? 0) + 1,
            failures: receipt.warehouse?.failures ?? 0,
            executions: receipt.warehouse?.executions ?? 0,
          };
          options.onWarehouseAttempt?.();
        },
        onWarehouseResult: (outcome) => {
          settled += 1;
          receipt.warehouse = {
            attempts: receipt.warehouse?.attempts ?? 0,
            failures: (receipt.warehouse?.failures ?? 0) + (outcome === 'failed' ? 1 : 0),
            executions: (receipt.warehouse?.executions ?? 0) + (outcome === 'succeeded' ? 1 : 0),
          };
          options.onWarehouseResult?.(outcome);
        },
        });
      },
    };
    const executed = await executeCandidate(candidate, intent, notedDeps);
    // Existing host adapters and focused unit doubles predate the receipt
    // hooks. They represent a real `run` call, so retain one conservative
    // count for a result/warehouse failure; never do this for preflight or
    // filter rejections where no dispatch occurred.
    if (physicalAttempts === 0 && settled === 0 && invoked > 0 && (executed.ok || executed.code === 'execution_failed' || executed.code === 'no_rows_matched' || executed.code === 'fanout_detected')) {
      receipt.warehouse = {
        attempts: (receipt.warehouse?.attempts ?? 0) + invoked,
        failures: (receipt.warehouse?.failures ?? 0) + (!executed.ok && executed.code === 'execution_failed' ? invoked : 0),
        executions: (receipt.warehouse?.executions ?? 0) + (!executed.ok && executed.code === 'execution_failed' ? 0 : invoked),
      };
    }
    return executed;
  };
  const label = labelFor(input.vocabulary);
  const mark = (stage: string, from: number) => {
    timings[stage] = Math.round(now() - from);
    receipt.lastCompletedPhase = stage;
    input.trace?.({ stage, detail: timings[stage] });
  };
  const TIER_NAMES: Record<string, string> = { certified: 'Certified saved queries', semantic: 'Semantic layer', relational: 'Governed tables and joins', exploratory: 'AI-drafted SQL from the schema' };
  const step = (phase: AskStoryStepV1['phase'], title: string, state: AskStoryStepV1['state'], extra: { detail?: string; ms?: number } = {}) => {
    const entry: AskStoryStepV1 = { version: 1, phase, title, state, at: Date.now(), ...(extra.detail ? { detail: extra.detail.slice(0, 600) } : {}), ...(extra.ms !== undefined ? { ms: extra.ms } : {}) };
    (receipt.story ??= []).push(entry);
    try { input.onStep?.(entry); } catch { /* a progress view never fails a run */ }
  };
  const dispatchStep = (event: { purpose: string; ms: number; promptChars?: number; problems?: Array<{ message: string }> }, repair = false) => {
    const context = event.promptChars ? `${Math.round(event.promptChars / 100) / 10}k characters of project context sent` : undefined;
    if (repair) step('read', 'Asked the AI to read the question again with what the tiers found', 'done', { ms: event.ms, ...(context ? { detail: context } : {}) });
    else if (event.purpose === 'resolve') step('read', 'Asked the AI to read the question', 'done', { ms: event.ms, ...(context ? { detail: context } : {}) });
    else step('read', 'Asked the AI to correct its reading', 'done', { ms: event.ms, detail: event.problems?.length ? `because ${event.problems.map((problem) => problem.message).join('; ')}` : (context ?? 'the first reading did not hold') });
  };
  const tierSteps = (attempts: Array<{ tier: string; outcome: string; detail?: string }>, ms?: number, again = '') => {
    // The governed rounds prepare with AI-drafted SQL held back; the schema
    // lane tells its own story, so that placeholder is not a place Ask looked.
    attempts = attempts.filter((attempt) => !(attempt.tier === 'exploratory' && attempt.outcome !== 'prepared'));
    attempts.forEach((attempt, index) => {
      const name = `${TIER_NAMES[attempt.tier] ?? attempt.tier}${again ? ` (${again})` : ''}`;
      const detail = attempt.detail?.replace(/^[a-z_]+:\s*/, '');
      if (attempt.outcome === 'prepared') step('tier', `${name}: prepared an answer`, 'done', { ...(detail ? { detail } : {}), ...(index === attempts.length - 1 && ms !== undefined ? { ms } : {}) });
      else if (attempt.outcome === 'skipped') step('tier', `${name}: nothing to try`, 'missed', detail ? { detail } : {});
      else step('tier', `${name}: no answer`, 'missed', { ...(detail ? { detail } : {}), ...(index === attempts.length - 1 && ms !== undefined ? { ms } : {}) });
    });
  };

  // THE DISCOVERY PATH, step one: hydration before the first call. Every
  // exact or alias match for the question's own words is pinned ahead of
  // ranking, so what the question names is never cut by what it resembles.
  const pinnedRefs = pinnedRefsFor(input.question, input.vocabulary);
  const skillRefs = input.vocabulary.entries.filter((entry) => entry.kind === 'skill').map((entry) => entry.ref);
  const renderedCards = input.vocabulary.renderCardsDetailed({
    maxChars: input.cardBudget ?? 24_000,
    seeds: input.question.split(/[^A-Za-z0-9_']+/).filter((word) => word.length > 2),
    ...(input.context?.rankedRefs?.length ? { rankedRefs: input.context.rankedRefs } : {}),
    ...(pinnedRefs.length ? { pinnedRefs } : {}),
    include: { skill: skillRefs },
    ...(input.context?.header ? { header: input.context.header } : {}),
    ...(input.context?.columnsFor ? { columnsFor: input.context.columnsFor } : {}),
  });
  receipt.context = {
    version: 1,
    ...(input.context?.timings && Object.keys(input.context.timings).length ? { timings: input.context.timings } : {}),
    ...(input.context?.packId ? { packId: input.context.packId } : {}),
    ...(input.context?.snapshotId ? { snapshotId: input.context.snapshotId } : {}),
    ...(input.context?.envelope ? { envelope: input.context.envelope } : {}),
    ...(input.context?.retrieved ? { retrieved: input.context.retrieved } : {}),
    ...(input.context?.admitted ? { admitted: input.context.admitted } : {}),
    rendered: {
      byKind: renderedCards.rendered, charsByKind: renderedCards.chars, totalChars: renderedCards.totalChars, truncated: renderedCards.truncated,
      skills: skillRefs, hints: input.vocabulary.entries.filter((entry) => entry.kind === 'hint').map((entry) => entry.ref),
    },
  };
  const renderedRefs = new Set(renderedCards.refs.map((ref) => ref.toLowerCase()));

  // THE SCHEMA LANE. When no certified block, no governed metric and no
  // governed composition can answer — including when the question could not
  // be read into the governed vocabulary at all — the tables may still hold
  // the answer. The model writes one read-only statement over tables the host
  // inspects for it; the host validates it against those tables; a statement
  // the warehouse rejects is redrafted once with the warehouse's error; the
  // answer is review-required and says the SQL was written by AI from the
  // schema. A question the tables do not hold is declined by the drafter and
  // stays an honest gap. A policy or domain-contract denial never reaches it,
  // and it runs only when AI-drafted SQL is enabled for the project.
  const schemaLane = async (why: string, hint?: AnalyticalIntentV1, options: { onDecline?: 'gap' | 'fallthrough'; caveats?: string[]; draftQuestion?: string } = {}): Promise<PipelineOutcome | undefined> => {
    if (input.stopAfter === 'reading') return undefined;
    if (!input.prepareDeps.draftSql || !(input.explorationOptIn || input.explorationAuto)) return undefined;
    // Only a security policy stops AI-written SQL; nothing about how tables join does.
    if (receipt.refusals.some((refusal) => refusal.code === 'policy_filter_unbindable' || refusal.code === 'policy_conflict')) return undefined;
    const reading: AnalyticalIntentV1 = hint && hint.kind === 'analytics'
      ? hint
      : { version: 1, kind: 'analytics', reading: input.question, measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' } as AnalyticalIntentV1;
    let previous: { sql: string; error: string } | undefined;
    let lastFailure: Extract<Awaited<ReturnType<typeof executeCandidate>>, { ok: false }> | undefined;
    step('schema', 'Asking the AI to write SQL from the tables', 'done', { detail: why });
    type ExecutedOk = Extract<Awaited<ReturnType<typeof executeCandidate>>, { ok: true }>;
    const answerWith = (candidate: PreparedCandidate, executed: ExecutedOk, runMs: number | undefined): PipelineOutcome => {
      step('execute', `Ran the AI-drafted query: ${executed.result.rowCount} row${executed.result.rowCount === 1 ? '' : 's'}`, 'done', { ms: runMs });
      receipt.intent = reading; receipt.reading = reading.reading;
      receipt.executed = { tier: candidate.tier, sqlFingerprint: fingerprintSql(candidate.sql), rowCount: executed.result.rowCount, ms: Math.round(executed.result.executionTimeMs), proofs: executed.proofs };
      timings.total = Math.round(now() - started);
      // The AI wrote the arithmetic: a statement that multiplies by 100 hands
      // back percentage points, so a percent column is not multiplied again
      // (8.06 growth is 8.06 pp, not 806%).
      const inPoints = /\*\s*100(?:\.0*)?(?![\d.])|(?<![\d.])100(?:\.0*)?\s*\*/.test(candidate.sql);
      const columnsMeta = describeResultColumns(reading, executed.result, input.vocabulary)
        .map((meta) => (inPoints && meta.kind === 'percent' && meta.unit === 'fraction' ? { ...meta, unit: 'percentage_points' as const } : meta));
      const result: ExecutedRows = { ...executed.result, columnsMeta };
      receipt.context = { ...receipt.context!, used: { joins: [], relations: [...new Set(candidate.relations ?? [])], tier: candidate.tier, ...(candidate.engine ? { engine: candidate.engine } : {}) } };
      const tables = (candidate.relations ?? []).join(', ');
      const applied = candidate.proof.find((line) => line.startsWith('applied on the data: '));
      // Say why the governed tiers did not answer, from their own refusals: a
      // governed metric that exists but cannot take this reading's filter is
      // not the same as no metric at all, and the next question reads this.
      const placeholder = new Set(['no_certified_block', 'exploration_not_opted_in', 'semantic_runtime_unavailable']);
      const governedRefusal = ['relational', 'semantic', 'certified']
        .map((tier) => receipt.refusals.find((refusal) => refusal.tier === tier && !placeholder.has(refusal.code)))
        .find(Boolean);
      const why = governedRefusal
        ? `the governed ${governedRefusal.tier} tier could not answer it as read (${governedRefusal.message.replace(/[.\s]+$/, '').slice(0, 180)})`
        : 'no certified block or semantic metric answers this';
      // An authored semantic metric rebuilt in SQL says which engine did not
      // run it and why, in the semantic tier's own words.
      const rebuilt = [...new Set(reading.measures.flatMap((measure) => measure.change ? [] : measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref])
        .map((ref) => input.vocabulary.get(ref)).filter((entry) => Boolean(entry?.engineOnly)).map((entry) => entry!.label ?? entry!.name))];
      const engineRefusal = rebuilt.length ? receipt.refusals.find((refusal) => refusal.tier === 'semantic') : undefined;
      const source = `the SQL was written by AI from the ${tables ? `schema of ${tables}` : 'available table schemas'}${applied ? `; it ${applied.replace(/^applied on the data: /, 'filters on ')}` : ''}`;
      const caveat = rebuilt.length
        ? `the semantic engine did not run ${rebuilt.join(', ')}${engineRefusal ? ` (${engineRefusal.message.replace(/[.\s]+$/, '').slice(0, 180)})` : ''}, so ${source}, rebuilding ${rebuilt.length === 1 ? 'that metric' : 'those metrics'} from ${rebuilt.length === 1 ? 'its' : 'their'} authored definition; review the SQL before relying on the numbers`
        : `${why}, so ${source}; review the SQL before relying on the numbers`;
      // What the drafting host could not fix and the reader must know (a
      // grouping by keys whose names it could not join) is said in the answer.
      const drafted = candidate.proof.filter((line) => line.startsWith('caveat: ')).map((line) => line.slice('caveat: '.length));
      return { kind: 'answered', intent: reading, candidate, result, text: composeAnsweredText(reading, result, input.vocabulary, candidate.trust, { caveats: [...(options.caveats ?? []), caveat, ...drafted] }), receipt };
    };
    // The first statement ran and returned nothing: kept, so a redraft that
    // fails or declines still ends in the honest empty answer.
    let firstEmpty: { candidate: PreparedCandidate; executed: ExecutedOk; runMs: number | undefined } | undefined;
    // A first result the review sent back for revision: it stands unless the
    // revision runs and returns rows. A second look never costs the answer.
    let firstAnswer: { candidate: PreparedCandidate; executed: ExecutedOk; runMs: number | undefined } | undefined;
    const keepFirst = () => answerWith(firstAnswer!.candidate, firstAnswer!.executed, firstAnswer!.runMs);
    // No rows at all (or one row of nothing but nulls) after a second look is
    // an honest "no matching data", never an empty table; a row of zeros is a
    // real count of nothing and is answered.
    const noRowsAtAll = (executed: ExecutedOk) => executed.result.rowCount === 0 || (executed.result.rows.length === 1 && Object.values(executed.result.rows[0] ?? {}).every((value) => value === null || value === undefined));
    const emptyGap = (): PipelineOutcome => {
      const message = `the query ran twice, spelling the restrictions two ways, and found no rows for "${reading.reading.replace(/[.\s]+$/, '')}"`;
      receipt.intent = reading; receipt.reading = reading.reading;
      step('schema', 'The tables hold no rows for this', 'missed', { detail: message });
      return { kind: 'gap', gap: 'not_retrieved', message, nearest: [], text: `No matching data: ${message}.`, receipt, intent: reading, offerExploration: false };
    };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (remaining() < 12_000 || input.signal?.aborted) break;
      const draftStarted = now();
      const drafted = await prepareExploratory(hint && hint.kind === 'analytics' ? hint : undefined, input.vocabulary, input.prepareDeps, options.draftQuestion ?? input.question, { reason: why, ...(previous ? { previous } : {}) });
      mark(attempt === 1 ? 'schema_draft' : 'schema_redraft', draftStarted);
      const draftMs = timings[attempt === 1 ? 'schema_draft' : 'schema_redraft'];
      receipt.refusals.push(...drafted.refusals);
      receipt.tiers.push({ round: 97, tier: 'exploratory', outcome: drafted.candidates.length ? 'prepared' : 'refused', detail: drafted.refusals[0] ? `${drafted.refusals[0].code}: ${drafted.refusals[0].message.slice(0, 160)}` : `schema lane: ${why.slice(0, 160)}` });
      // The redraft looked at what the tables hold and says why nothing
      // matches (the data ends in 2017, no such player): that is the answer.
      const declinedAgain = firstEmpty ? drafted.refusals.find((refusal) => refusal.code === 'exploration_declined') : undefined;
      if (firstEmpty && declinedAgain) {
        const message = `the query ran and found nothing: ${declinedAgain.message.replace(/[.\s]+$/, '')}`;
        receipt.intent = reading; receipt.reading = reading.reading;
        step('schema', 'The tables hold nothing for this', 'missed', { detail: declinedAgain.message });
        return { kind: 'gap', gap: 'not_retrieved', message, nearest: [], text: `No matching data: ${message}.`, receipt, intent: reading, offerExploration: false };
      }
      if (firstEmpty && drafted.candidates.length === 0) return noRowsAtAll(firstEmpty.executed) ? emptyGap() : answerWith(firstEmpty.candidate, firstEmpty.executed, firstEmpty.runMs);
      if (firstAnswer && (drafted.candidates.length === 0 || drafted.refusals.some((refusal) => refusal.code === 'exploration_check_failed' || refusal.code === 'exploration_declined'))) {
        step('schema', 'The revision could not be drafted: kept the first result', 'missed', { ms: draftMs });
        return keepFirst();
      }
      const failedCheck = drafted.refusals.find((refusal) => refusal.code === 'exploration_check_failed');
      if (failedCheck) {
        step('schema', 'The drafted SQL failed a check, so it was not run', 'failed', { detail: failedCheck.message, ms: draftMs });
        // A statement that left out what the question stated is named as such,
        // even where a decline would fall back to the nearest spellings: those
        // guesses are about field names, not about the value that was dropped.
        const message = failedCheck.message.replace(/[.\s]+$/, '');
        receipt.intent = reading; receipt.reading = reading.reading;
        // "Name the field" helps only when a stated value was left out; a join
        // the check refused is fixed by rephrasing, not by naming a field.
        const advice = /from the question$|required filter/.test(message) ? ' Name the field that holds it, and Ask will use it.' : ' Rephrase the question, or name the tables it should use.';
        return { kind: 'gap', gap: 'not_modeled', message, nearest: [], text: `No query was run because the AI-drafted SQL failed a check: ${message}.${advice}`, receipt, intent: reading, offerExploration: false };
      }
      const declined = drafted.refusals.find((refusal) => refusal.code === 'exploration_declined');
      if (declined) {
        step('schema', 'The tables searched do not hold what was asked', 'missed', { detail: declined.message, ms: draftMs });
        if (options.onDecline === 'fallthrough') return undefined;
        const message = declined.message.replace(/[.\s]+$/, '') || 'the available tables do not hold what the question asks for';
        receipt.intent = reading; receipt.reading = reading.reading;
        // The drafter saw the tables it was given, not the whole project: the
        // sentence says what was searched, never that the project lacks it.
        return { kind: 'gap', gap: 'not_modeled', message, nearest: [], text: `No query was run because the tables Ask searched do not hold it: ${message}.`, receipt, intent: reading, offerExploration: false };
      }
      const candidate = drafted.candidates[0];
      if (!candidate) {
        const refused = drafted.refusals[0];
        step('schema', 'Could not draft SQL from the schema', 'failed', { ...(refused ? { detail: refused.message } : {}), ms: draftMs });
        // NO TABLES COULD BE READ AT ALL: a setup problem, not an answer about
        // the data. Saying "the project's data does not describe it" here sent
        // people away from a question the same project answers once its
        // tables are back (ZLens 0.1.0 e2e, F3).
        if (refused?.code === 'exploration_tables_unavailable' && options.onDecline !== 'fallthrough') {
          const message = refused.message.replace(/[.\s]+$/, '');
          receipt.intent = reading; receipt.reading = reading.reading;
          receipt.failure = { stage: 'prepare', reason: 'exploration_tables_unavailable', message };
          return { kind: 'failed', stage: 'prepare', message, text: `${composeFailedText('prepare', message)}. Whether the data holds "${reading.reading.replace(/[.\s]+$/, '')}" was not checked.`, receipt, intent: reading };
        }
        break;
      }
      step('schema', `${attempt === 1 ? 'Drafted' : 'Redrafted'} SQL over ${(candidate.relations ?? []).join(', ') || 'the described tables'}`, 'done', { detail: candidate.sql, ms: draftMs });
      receipt.candidates.push({ tier: candidate.tier, trust: candidate.trust, proof: candidate.proof, sqlFingerprint: fingerprintSql(candidate.sql), ...(candidate.engine ? { engine: candidate.engine } : {}) });
      const executeStarted = now();
      // The reading guides the draft; it does not dictate its spelling. A
      // governed composition must bind the reading's literals and window as
      // written, but a drafted statement may say FY26 as FISCAL_YEAR = 2026 or
      // "lost" as NOT IS_WON. What the question states was already checked on
      // the statement itself before it got here, so the execution proofs read
      // the measures and groupings, not the filters and window.
      const executionReading: AnalyticalIntentV1 = {
        ...reading,
        filters: [],
        measures: reading.measures.map(({ scope: _scope, ...measure }) => measure),
        ...(reading.time ? { time: { ...reading.time, window: undefined } } : {}),
      } as AnalyticalIntentV1;
      const executed = await countedExecute(candidate, executionReading, input.executeDeps);
      mark(attempt === 1 ? 'schema_execute' : 'schema_reexecute', executeStarted);
      const runMs = timings[attempt === 1 ? 'schema_execute' : 'schema_reexecute'];
      if (executed.ok) {
        // AN EMPTY RESULT FROM AI-WRITTEN SQL IS REDRAFTED ONCE. The drafter
        // guessed how a stated value is stored ("capital one" for "Capital
        // One", 26 for 2026); nothing matching is a claim worth one more look.
        // A COUNT over no matching rows is one row of 0, not an empty result,
        // so a single row of nothing but zeros and nulls is looked at again
        // too; a real zero comes back the same and is answered.
        const cells = executed.result.rows.length === 1 ? Object.values(executed.result.rows[0] ?? {}) : [];
        const nothing = (value: unknown) => value === null || value === undefined || value === 0 || value === 0n || value === '0';
        const noRows = executed.result.rowCount === 0 || (cells.length > 0 && cells.every(nothing));
        // A revision that finds nothing is not better than a first result that found something.
        if (firstAnswer && noRows) {
          step('execute', 'The revision found nothing: kept the first result', 'missed', { ms: runMs });
          return keepFirst();
        }
        if (noRows && attempt === 1 && remaining() > 15_000) {
          firstEmpty = { candidate, executed, runMs };
          step('execute', 'The AI-drafted query found nothing (no rows, or only zeros): redrafting once', 'missed', { ms: runMs });
          previous = { sql: candidate.sql, error: 'the statement ran and returned no rows, or only zeros. Before concluding that nothing matches, check how each stated value is stored: compare text case-insensitively and allow a partial match, a two-digit year (26, FY26) may be stored as four digits (2026), and a status may be a flag rather than text. Change only how the restrictions are spelled, never what is measured.' };
          continue;
        }
        if (firstEmpty && noRowsAtAll(executed)) return emptyGap();
        // THE SECOND LOOK. The result ran; does it answer what was asked? One
        // review, before any retry was spent, with time left for a revision.
        if (attempt === 1 && !firstEmpty && input.reviewResult && remaining() > 30_000 && !input.signal?.aborted) {
          const reviewStarted = now();
          let verdict: { revise: string } | undefined;
          try { verdict = await input.reviewResult({ question: options.draftQuestion ?? input.question, sql: candidate.sql, result: executed.result }); } catch { verdict = undefined; }
          mark('schema_review', reviewStarted);
          if (verdict?.revise) {
            firstAnswer = { candidate, executed, runMs };
            step('execute', 'Checked the result against the question: revising the SQL once', 'missed', { detail: verdict.revise, ms: timings.schema_review });
            previous = { sql: candidate.sql, error: `the statement ran and returned ${executed.result.rowCount} row${executed.result.rowCount === 1 ? '' : 's'}, but the result does not answer the question as asked: ${verdict.revise.replace(/[.\s]+$/, '')}. Keep everything it gets right and change only that.` };
            continue;
          }
          step('execute', 'Checked the result against the question', 'done', { ms: timings.schema_review });
        }
        return answerWith(candidate, executed, runMs);
      }
      if (firstAnswer) {
        step('execute', 'The revision did not run: kept the first result', 'missed', { detail: executed.message, ms: runMs });
        return keepFirst();
      }
      if (firstEmpty) return noRowsAtAll(firstEmpty.executed) ? emptyGap() : answerWith(firstEmpty.candidate, firstEmpty.executed, firstEmpty.runMs);
      receipt.refusals.push({ tier: candidate.tier, code: executed.code, message: executed.message, repairable: executed.code === 'execution_failed' } as unknown as PreparedRefusal);
      lastFailure = executed;
      step('execute', executed.code === 'execution_failed' ? (attempt === 1 ? 'The warehouse rejected the draft: correcting it once' : 'The warehouse rejected the corrected draft') : 'The drafted query was not accepted', 'failed', { detail: executed.message, ms: runMs });
      if (executed.code !== 'execution_failed') break;
      // A host keeps the warehouse's words from the answer; the corrective draft still gets its diagnosis.
      previous = { sql: candidate.sql, error: executed.repair ?? executed.message };
    }
    if (firstAnswer) return keepFirst();
    if (firstEmpty) return noRowsAtAll(firstEmpty.executed) ? emptyGap() : answerWith(firstEmpty.candidate, firstEmpty.executed, firstEmpty.runMs);
    // Two warehouse rejections: the warehouse's own words are the answer, not
    // a modeling gap the drafted SQL never had.
    if (lastFailure?.code === 'execution_failed') {
      receipt.intent = reading; receipt.reading = reading.reading;
      receipt.failure = { stage: 'execute', reason: lastFailure.code, message: lastFailure.message, ...(lastFailure.warehouse ? { warehouse: lastFailure.warehouse } : {}) };
      return { kind: 'failed', stage: 'execute', message: lastFailure.message, text: composeFailedText('execute', lastFailure.message, lastFailure.warehouse), receipt, intent: reading };
    }
    return undefined;
  };
  const recordSelection = (selected: AnalyticalIntentV1) => {
    const refs = intentRefs(selected);
    const byKind: Record<string, number> = {};
    for (const ref of refs) { const kind = input.vocabulary.get(ref)?.kind ?? 'unknown'; byKind[kind] = (byKind[kind] ?? 0) + 1; }
    receipt.context = { ...receipt.context!, selected: { refs, byKind, unrendered: refs.filter((ref) => !renderedRefs.has(ref.toLowerCase())) } };
  };

  // RETRIEVE, THEN RE-ASK. A reading that leaves a clause unresolved while
  // naming a relation it could not see the columns of is not a business gap:
  // it is a retrieval gap. The relation's columns (probed on demand when the
  // vocabulary has none) and every inventory entry the clause's words name
  // that was not shown go back to the interpreter once, with the rules for
  // reading a count, an amount and a status from raw columns. Only what those
  // still do not cover becomes a clarification.
  const expandForClauses = async (need: { clauses: string[]; question: string; reading: string }): Promise<{ vocabulary: VocabularyIndex; cards: string[]; note: string } | undefined> => {
    let vocabulary = input.vocabulary;
    const text = ` ${need.question} ${need.reading} ${need.clauses.join(' ')} `.toLowerCase();
    const escape = (value: string) => value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namedRelations = vocabulary.entries.filter((entry) => entry.kind === 'relation' && [entry.name, entry.model ?? '', ...entry.aliases, ...(entry.physical?.binding?.aliases ?? [])].some((name) => name && new RegExp(`(^|[^a-z0-9_])${escape(name)}([^a-z0-9_]|$)`).test(text)));
    // Four typed manifest columns are not evidence that a Salesforce relation
    // is complete. An admitted partial relation is re-described before an
    // unresolved field is treated as absent.
    const incomplete = namedRelations.filter((entry) => !entry.columns?.length || entry.physical?.binding?.columnCompleteness !== 'complete');
    let probed = 0;
    if (incomplete.length && input.describeRelations) {
      try {
        // A physical binding is the discovery key.  Never send aliases[0]
        // here: on Snowflake that can turn DB_A.PUBLIC.EVENTS into the
        // session's PUBLIC.EVENTS and recreate the collision we just avoided.
        const found = await input.describeRelations(incomplete.map((entry) => entry.physical?.binding
          ? physicalRelationText(entry.physical.binding)
          : entry.model ?? entry.name).slice(0, 3));
        if (found.length) {
          vocabulary = mergeDiscoveredRelations(vocabulary, found);
          probed = found.length;
          input.onVocabularyUpdate?.(vocabulary);
        }
      } catch { /* the vocabulary stands as it was */ }
    }
    const shown = new Set(renderedCards.refs.map((ref) => ref.toLowerCase()));
    const cards = new Map<string, string>();
    for (const relation of namedRelations) {
      const entry = vocabulary.get(relation.ref);
      if (!entry) continue;
      cards.set(entry.ref, renderCard(entry));
      for (const column of vocabulary.entries.filter((item) => item.kind === 'column' && item.ref.toLowerCase().startsWith(`column:${(entry.model ?? '').toLowerCase()}.`))) {
        if (!shown.has(column.ref.toLowerCase()) && cards.size < 90) cards.set(column.ref, renderCard(column));
      }
    }
    for (const clause of need.clauses) {
      const words = clause.split(/[^A-Za-z0-9_']+/).filter((word) => word.length > 2).slice(0, 12);
      const terms = new Set<string>([clause, ...words, ...words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`)]);
      for (const term of terms) for (const hit of vocabulary.lookup(term, { limit: 4, minScore: 0.8 })) {
        if (!shown.has(hit.entry.ref.toLowerCase()) && !cards.has(hit.entry.ref) && cards.size < 120) cards.set(hit.entry.ref, renderCard(hit.entry));
      }
    }
    if (cards.size === 0) return undefined;
    // The extended vocabulary serves the rest of this run: preparation and proofs read the probed columns too.
    input = { ...input, vocabulary };
    const note = `discovery: ${cards.size} entries not shown before were fetched for "${need.clauses.join('; ')}"${probed ? ` (${probed} relation${probed === 1 ? '' : 's'} described on demand)` : ''}`;
    step('search', `Fetched ${cards.size} field${cards.size === 1 ? '' : 's'} the first reading had not seen`, 'done', { detail: `for "${need.clauses.join('; ')}"${probed ? `; ${probed} table${probed === 1 ? '' : 's'} described on the warehouse` : ''}` });
    receipt.grounding = [...(receipt.grounding ?? []), note];
    return { vocabulary, cards: [...cards.values()], note };
  };

  // 1. Resolve. Only certified blocks and authored semantics are governed; a
  // reading over anything else goes to AI-written SQL when it is available.
  const aiSqlAvailable = Boolean(input.prepareDeps.draftSql && (input.explorationOptIn || input.explorationAuto));
  // 0. DRAFT FIRST where nothing is governed: the question goes to the SQL
  // drafter as asked, the checks and the result review stay, and only what
  // the drafter declines is read into a reading as before. Anything the
  // reading owns (an edit of the last analysis, an answer to a clarification,
  // a picked meaning, a forecast, a question about causes) is read first.
  if (!settled && input.draftFirst && aiSqlAvailable && !input.prior && !memberGuidance(input) && !input.selection && !input.memberSelection && !input.conversation?.pendingClarification
    && predictiveOperatorsIn(input.question).length === 0 && causalOperatorsIn(input.question).length === 0) {
    // No reading was made, so nothing has checked the question's terms yet: a
    // term no listed column holds or defines is declined, not invented, and
    // the decline goes to the reading, which asks or names the gap.
    const drafted = await schemaLane('nothing governed covers this project, so the SQL is written from the question itself. No reading was made: when the question uses a business term or grouping that no listed column holds and nothing in CONTEXT defines (a churn rate, a region the tables do not have), do not invent a definition or substitute another field; reply NO_SQL naming it', undefined, { onDecline: 'fallthrough' });
    if (drafted) return drafted;
  }
  const resolveStarted = now();
  // A question that is only a governed metric and dimensions, by their own words, is read here: no mode or model phrasing can move its route.
  // The model keeps any question that reads as an edit of the thread's last analysis (the host passes `prior` only then) and any host guidance.
  const lexicalReading = !settled && !input.prior && !memberGuidance(input) && !input.selection && !input.memberSelection && !input.conversation?.pendingClarification ? readByOwnWords(input.question, input.vocabulary) : undefined;
  let resolution: IntentResolution = settled ? settledResolution(settled.intent, input.vocabulary) : await resolveIntent({
    question: input.question, vocabulary: input.vocabulary, provider: input.provider, prior: input.prior, priorExecuted: input.priorExecuted, ...(input.hidePriorValues ? { hidePriorValues: true } : {}), priorAnswerSummary: input.priorAnswerSummary, clauseCoverage: input.clauseCoverage, budgetMs: remaining(), ...(input.selection ? { selection: input.selection } : {}),
    guidance: memberGuidance(input), cardBudget: input.cardBudget, providerOptions, now,
    renderedCards, ...(input.conversation ? { conversation: input.conversation } : {}),
    maxAttempts: remaining() > 15_000 ? 2 : 1,
    aiLane: aiSqlAvailable,
    onDispatch: (event) => { receipt.dispatches.push({ purpose: `intent:${event.purpose}`, ms: event.ms, reply: event.raw.slice(0, 1500), at: Date.now(), attempt: event.attempt, label: event.purpose === 'resolve' ? 'read' : 'correct', ...(event.promptChars !== undefined ? { promptChars: event.promptChars } : {}) }); dispatchStep(event); },
    expand: expandForClauses,
  });
  // The model was still asked, so its call is on the receipt; the lexical reading decides the route whatever it answered.
  if (lexicalReading) resolution = { status: 'resolved', intent: lexicalReading, attempts: resolution.attempts, problems: [] };
  mark('resolve', resolveStarted);
  if (settled) {
    receipt.reuse = 'interpretation';
    step('read', resolution.status === 'failed' ? 'The settled reading named things that do not exist' : 'Used the settled reading', resolution.status === 'failed' ? 'failed' : 'done', { detail: resolution.status === 'failed' ? resolution.detail : settled.intent.reading });
  } else if (lexicalReading) {
    step('read', 'Read the question by the semantic layer\'s own words', 'done', { detail: lexicalReading.reading });
  } else {
    const calls = receipt.dispatches.filter((dispatch) => dispatch.purpose.startsWith('intent:')).length;
    const callsNote = `${calls} AI call${calls === 1 ? '' : 's'}`;
    if (resolution.status === 'resolved' || resolution.status === 'clarify') {
      const unrenderedNote = receipt.grounding?.filter((note) => note.startsWith('discovery:')).map((note) => note.replace(/^discovery:\s*/, '')).join('; ');
      step('read', 'Settled the reading', 'done', { detail: `${resolution.intent.reading}${unrenderedNote ? ` · searched again: ${unrenderedNote}` : ''} · ${callsNote} in ${Math.round((timings.resolve ?? 0) / 100) / 10} s` });
      if (resolution.status === 'clarify' && resolution.unmatched?.length) step('read', 'Named fields this project does not hold', 'missed', { detail: resolution.unmatched.map((problem) => problem.message).join('; ') });
    } else if (resolution.status === 'failed') {
      step('read', resolution.reason === 'provider_error' ? 'The AI model did not answer' : 'Could not read the question into governed fields', resolution.reason === 'provider_error' ? 'failed' : 'missed', { detail: `${resolution.detail} · ${callsNote}` });
    } else {
      step('read', 'Settled the reading', 'done', { detail: callsNote });
    }
  }
  const recordLedger = (resolved: IntentResolution) => {
    if (resolved.status !== 'resolved' && resolved.status !== 'clarify') return;
    if (!resolved.ledger) return;
    receipt.ledger = { clauses: resolved.ledger.clauses.map((clause) => ({ clause: clause.clause, ...(clause.kind ? { kind: clause.kind } : {}) })), ...(resolved.ledger.timeGrain ? { timeGrain: resolved.ledger.timeGrain } : {}), measures: resolved.ledger.measures, entries: [...(receipt.ledger?.entries ?? []), ...(resolved.ledgerEntries ?? [])] };
  };
  recordLedger(resolution);
  // A question that could not be read into the governed vocabulary is still a
  // question about these tables. The model itself failing (timeout, quota,
  // authentication) is not: it could not draft either.
  if (!settled && resolution.status === 'failed' && (resolution.reason === 'invalid' || resolution.reason === 'unparseable')) {
    const drafted = await schemaLane(`the question could not be read into the governed vocabulary (${resolution.detail.slice(0, 300)})`);
    if (drafted) return drafted;
  }
  if (resolution.status === 'failed') {
    // The reader gets one sentence; the receipt keeps the provider's words.
    const timedOut = resolution.reason === 'provider_error' && resolution.code === 'provider_timeout';
    const exited = resolution.reason === 'provider_error' && resolution.code === 'provider_exit';
    const quota = resolution.reason === 'provider_error' && resolution.code === 'provider_quota';
    const authentication = resolution.reason === 'provider_error' && resolution.code === 'provider_auth';
    const message = timedOut ? 'the AI model took too long to read the question; retry the same question'
      : exited ? 'the AI model exited before answering; retry the same question'
      : quota ? `the AI model's usage limit is reached; wait for it to reset or switch the provider (${resolution.detail})`
      : authentication ? `the AI model needs authentication; reauthenticate the configured provider and retry (${resolution.detail})`
      : resolution.reason === 'provider_error' ? `the AI model did not respond (${resolution.detail})` : resolution.reason === 'unparseable' ? 'the AI reply was not a readable interpretation' : `the interpretation named things that do not exist: ${resolution.detail}`;
    receipt.failure = { stage: 'resolve', reason: timedOut ? 'provider_timeout' : exited ? 'provider_exit' : quota ? 'provider_quota' : authentication ? 'provider_auth' : resolution.reason, message: timedOut || exited ? `${message} (${resolution.detail})` : message, problems: resolution.problems };
    return { kind: 'failed', stage: 'resolve', message, text: composeFailedText('resolve', message), receipt };
  }
  if (resolution.status === 'conversation' || resolution.status === 'definition') {
    receipt.intent = resolution.intent;
    return { kind: resolution.status, reply: resolution.reply, text: resolution.reply, receipt, intent: resolution.intent };
  }
  receipt.intent = resolution.intent;
  receipt.reading = resolution.intent.reading;
  // A FORECAST IS NOT A MEASUREMENT, on any lane short of a fully governed
  // reading: nothing is drafted as a proxy for what will happen.
  {
    // A settled reading has no question wording to hold it to.
    const predictive = settled ? [] : predictiveOperatorsIn(input.question);
    const governedReading =intentRefs(resolution.intent).length > 0 && readingLane(resolution.intent, input.vocabulary) === 'governed';
    if (predictive.length > 0 && !governedReading) {
      const message = `Predicting what will happen (${predictive.join(', ')}) is not something Ask computes from the data; it reports what the data recorded. Research can investigate the history behind it`;
      return { kind: 'gap', gap: 'unsupported', message, nearest: [], text: composeGapText('unsupported', message, [], false), receipt, intent: resolution.intent, offerExploration: false };
    }
  }
  // A DESCRIPTION IS NOT A RECOMMENDATION, AND REFUSING ONE SHOULD NOT WITHHOLD
  // THE OTHER. "Which of these should we build around, and why?" carries a
  // reading this project can measure and a judgment it cannot compute. Naming
  // the measurable part in prose and running nothing leaves the reader to ask
  // the same question again in smaller words; so the comparison is delivered,
  // and the judgment is refused out loud rather than quietly attempted.
  let judgmentCaveat: string | undefined;
  if (resolution.status === 'clarify') {
    const material = resolution.intent.unresolved.filter((clause) => clause.material);
    const operators = material.filter((clause) => clause.kind === 'unsupported' && clause.options.length === 0);
    if (operators.length > 0 && operators.length === material.length && resolution.intent.measures.length > 0) {
      for (const clause of operators) clause.material = false;
      judgmentCaveat = `${operators.map((clause) => `"${clause.clause}"`).join(' and ')} ${operators.length === 1 ? 'is' : 'are'} not computed here: what follows is the measured comparison, not a recommendation and not a cause. Research can investigate the drivers`;
      resolution = { status: 'resolved', intent: resolution.intent, attempts: resolution.attempts, problems: [], ...(resolution.ledger ? { ledger: resolution.ledger } : {}), ...(resolution.ledgerEntries ? { ledgerEntries: resolution.ledgerEntries } : {}) };
    }
  }
  // THE READING KEPT NAMING FIELDS THE PROJECT DOES NOT HOLD. The options the
  // host would offer are its nearest spellings, not meanings the question
  // could have had, so the tables are asked first; the guesses are offered
  // only when the drafter finds nothing there or AI-drafted SQL is off.
  if (resolution.status === 'clarify' && resolution.unmatched?.length) {
    const guesses = resolution.options.map(label).join(', ');
    const drafted = await schemaLane(`the reading named fields this project does not hold (${resolution.unmatched.map((problem) => problem.message).join('; ').slice(0, 400)}); the nearest governed fields were ${guesses}`, undefined, { onDecline: 'fallthrough' });
    if (drafted) return drafted;
  }
  if (resolution.status === 'clarify') {
    const options = resolution.options.map((ref) => ({ ref, label: label(ref), ...(input.vocabulary.get(ref)?.description ? { description: input.vocabulary.get(ref)!.description } : {}) }));
    // A continuity question the host asked (which population does this
    // follow-up mean?) has no options and no unresolved clause: it is a real
    // question for the user, not a modeling gap.
    if (options.length === 0 && !resolution.intent.unresolved.some((item) => item.material)) {
      return { kind: 'clarify', intent: resolution.intent, question: resolution.question, options, text: resolution.question, receipt };
    }
    if (options.length === 0) {
      // Nothing to choose between: the project simply does not hold it.
      const materials = resolution.intent.unresolved.filter((item) => item.material);
      const material = materials[0];
      const clause = material?.clause ?? input.question;
      // No partial answers: nothing executes, but the reading that WAS
      // answerable is named so the user can ask for exactly that.
      const answerable = resolution.intent.measures.length > 0 ? ` Answerable from this reading: ${describeIntent(resolution.intent, label).replace(/[.\s]+$/, '')}.` : '';
      // When the reading itself carries nothing, name the measures this
      // project does hold for the words the question used: a refusal that
      // points at the answerable neighbour is worth more than a full stop.
      const nearestMeasures = resolution.intent.measures.length === 0
        ? [...new Set(input.vocabulary.lookup(input.question, { limit: 6, minScore: 0.5 }).map((hit) => hit.entry).filter((entry) => entry.kind === 'metric' || entry.kind === 'measure').map((entry) => entry.label ?? entry.name))].slice(0, 3)
        : [];
      const offered = nearestMeasures.length ? ` This project does measure ${nearestMeasures.join(', ')}: ask for ${nearestMeasures.length === 1 ? 'it' : 'one of them'} over a period and I can show it.` : '';
      if (material?.kind === 'unsupported' || (material && causalOperatorsIn(material.clause).length > 0)) {
        // Every clause the project cannot serve is named, not only the first.
        const message = materials.map((item) => item.question ?? `"${item.clause}" asks for an operation Ask does not perform`).map((text) => text.replace(/[.\s]+$/, '')).join('. ');
        return { kind: 'gap', gap: 'unsupported', message, nearest: [], text: `${composeGapText('unsupported', message.replace(/[.\s]+$/, ''), [], false)}${answerable}${offered}`, receipt, intent: resolution.intent, offerExploration: false };
      }
      // NOTHING GOVERNED DESCRIBES IT, AND THERE IS NOTHING TO CHOOSE BETWEEN:
      // the tables are asked before the answer is "not modeled".
      {
        const drafted = await schemaLane(material?.question ?? `"${clause}" is not described by this project's certified blocks or governed metrics`, resolution.intent);
        if (drafted) return drafted;
      }
      // THE DISCOVERY PATH, step three: "not shown" is never "not modeled".
      // Before the project is said not to hold something, the whole inventory
      // is asked; an exact object the cards did not have room for is named,
      // and the gap says it was not shown in this reading.
      const unrendered = input.vocabulary.lookup(clause, { limit: 3, minScore: 0.9 })
        .filter((hit) => (hit.matchedOn === 'ref' || hit.matchedOn === 'name' || hit.matchedOn === 'alias') && !renderedRefs.has(hit.entry.ref.toLowerCase()));
      if (unrendered.length > 0) {
        const named = unrendered.map((hit) => `${label(hit.entry.ref)} (${hit.entry.ref})`).join(', ');
        const message = `"${clause}" was not shown in this reading, but this project does hold ${named}; ask for it by that name`;
        return { kind: 'gap', gap: 'not_retrieved', message, nearest: unrendered.map((hit) => label(hit.entry.ref)), text: `${composeGapText('not_retrieved', message, [], false)}${answerable}`, receipt, intent: resolution.intent, offerExploration: false };
      }
      const nearest = input.vocabulary.lookup(clause, { limit: 4, minScore: 0.5 }).map((hit) => label(hit.entry.ref));
      // A clause that came with its own explanation says more than the
      // generic sentence: read it out instead of restating the clause. And a
      // clause whose explanation is itself a question ("spend or orders?")
      // is an ambiguity the project could not settle, not something it fails
      // to model: the gap says so.
      const message = material?.question ?? `"${clause}" is not something this project's governed data describes`;
      const gap = material?.question && /\?\s*$/.test(material.question.trim()) ? 'ambiguous' : 'not_modeled';
      return { kind: 'gap', gap, message, nearest, text: `${composeGapText(gap, message.replace(/[.\s]+$/, ''), nearest, false)}${answerable}${offered}`, receipt, intent: resolution.intent, offerExploration: false };
    }
    return { kind: 'clarify', intent: resolution.intent, question: resolution.question, options, text: resolution.question, receipt };
  }
  let intent = resolution.intent;
  // The lane follows the final reading: a judgment question over the previous
  // analysis reaches here through a clarification, not the resolver's return.
  let aiReading = resolution.status === 'resolved' && (resolution.lane === 'ai' || (aiSqlAvailable && readingLane(resolution.intent, input.vocabulary) === 'ai'));
  // THE BLOCK THE PERSON ASKED FOR. A question that names a certified block
  // ("using the certified block …"), or a follow-up that narrows that block's
  // answer, is answered BY that block when its contract entails the reading,
  // or the run says exactly why it cannot. It is never handed to AI-written
  // SQL over other tables, which would answer a different question at a
  // glance-alike confidence. Exploring the tables stays one explicit step away.
  const held = !settled && !input.explorationOptIn && resolution.status === 'resolved' && intent.kind === 'analytics' ? heldCertifiedBlock(input, intent) : undefined;
  if (held) {
    const asked = readAsBlock(intent, held.entry);
    const verdict = entails(held.entry, asked, input.vocabulary);
    const open = asked.unresolved.filter((clause) => clause.material).map((clause) => `"${clause.clause}" is not something the block declares`);
    const identityOnly = !verdict.ok && verdict.identityNote !== undefined && verdict.missing.length === 1;
    // A follow-up is held to the block only where nothing governed reaches:
    // a field that lives on a raw table. Anything the governed tiers can
    // compose (a period, a key instead of a label, a row count) keeps the
    // ordinary path, which re-reads the analysis by metrics and entities.
    const ungoverned = [...asked.filters.map((predicate) => predicate.ref), ...asked.groupBy.map((group) => group.ref), ...asked.display]
      .filter((ref) => { const entry = input.vocabulary.get(ref) ?? input.vocabulary.resolve(ref); return !entry || !isGovernedEntry(entry); });
    if ((verdict.ok || identityOnly) && open.length === 0) {
      intent = asked;
      aiReading = false;
    } else if (held.how === 'named' || ungoverned.length > 0) {
      const governedNote = ungoverned.length ? [`${[...new Set(ungoverned.map((ref) => input.vocabulary.get(ref)?.name ?? ref.split('.').pop() ?? ref))].join(', ')} is not part of the project's governed data (no certified block or semantic field holds it)`] : [];
      const message = heldBlockRefusal(held.entry, [...verdict.missing, ...open, ...governedNote]);
      receipt.intent = asked; receipt.reading = asked.reading;
      receipt.refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${held.entry.ref}: ${[...verdict.missing, ...open].join('; ')}`, repairable: false });
      receipt.tiers.push({ round: 0, tier: 'certified', outcome: 'refused', detail: `${held.how === 'named' ? 'named block' : 'follow-up on the block'}: ${[...verdict.missing, ...open].join('; ').slice(0, 560)}` });
      receipt.failure = { stage: 'prepare', reason: 'named_block_not_applicable', message };
      step('tier', `Certified saved query ${held.entry.name}: cannot answer this as asked`, 'missed', { detail: message });
      return { kind: 'gap', gap: 'not_modeled', message, nearest: [], text: `${message} Ask within what the saved query declares, or explore the tables for a review-required answer.`, receipt, intent: asked, offerExploration: true };
    }
  }
  // THE RELATIONS THE READING NAMES ARE DESCRIBED BEFORE ANYTHING IS PREPARED.
  // Context assembly hydrates only the few relations whose words match the
  // question; the reading may still lean on another (the facts a metric is
  // bound to, the relation a label lives on) that the manifest documents with
  // a handful of columns. Composing over it then fails for want of a column
  // the warehouse has: reading a season relation's player name on the game
  // facts that carry the same column is exactly that. The named relations are
  // few, so describing them costs milliseconds and no dispatch.
  if (input.describeRelations && remaining() > 8_000) {
    const named = new Map<string, VocabularyEntry>();
    const refs = new Set<string>();
    for (const measure of intent.measures) {
      refs.add(measure.ref);
      if (measure.derived) { refs.add(measure.derived.numerator); refs.add(measure.derived.denominator); }
      for (const predicate of measure.scope ?? []) refs.add(predicate.ref);
    }
    for (const group of intent.groupBy) refs.add(group.ref);
    for (const ref of intent.display) refs.add(ref);
    for (const predicate of intent.filters) refs.add(predicate.ref);
    if (intent.time?.ref) refs.add(intent.time.ref);
    for (const ref of refs) {
      const entry = input.vocabulary.get(ref) ?? input.vocabulary.resolve(ref);
      const relationName = entry?.physical?.relation ?? (entry && (entry.kind === 'column' || entry.kind === 'relation') ? entry.model : undefined);
      if (!relationName) continue;
      const relation = input.vocabulary.get(`relation:${relationName}`)
        ?? input.vocabulary.entries.find((candidate) => candidate.kind === 'relation' && samePhysicalRelation(candidate.model, relationName));
      if (!relation || relation.physical?.binding?.columnCompleteness === 'complete') continue;
      named.set(relation.ref, relation);
    }
    if (named.size > 0) {
      const describeStarted = now();
      try {
        const found = await input.describeRelations([...named.values()]
          .map((entry) => entry.physical?.binding ? physicalRelationText(entry.physical.binding) : entry.model ?? entry.name)
          .slice(0, 6));
        if (found.length > 0) {
          input = { ...input, vocabulary: mergeDiscoveredRelations(input.vocabulary, found) };
          input.onVocabularyUpdate?.(input.vocabulary);
          receipt.grounding = [...(receipt.grounding ?? []), `discovery: described ${found.length} relation${found.length === 1 ? '' : 's'} the reading names (${found.map((relation) => [relation.schema, relation.name].filter(Boolean).join('.')).join(', ')})`];
        }
      } catch { /* the vocabulary stands as it was */ }
      mark('describe', describeStarted);
    }
  }
  if (input.memberSelection) applyMemberSelection(intent, input.memberSelection, input.vocabulary);
  // EVERY LITERAL IS PROVEN AGAINST ITS FIELD BEFORE SQL: a relative period on
  // a date field becomes its dates, a partial date its window; a value no
  // field of that kind can take is asked back, never sent to the warehouse.
  if (!aiReading) {
    const proven = proveLiterals(intent, input.vocabulary, new Date(now()));
    intent = proven.intent;
    if (proven.notes.length) receipt.grounding = [...(receipt.grounding ?? []), ...proven.notes];
    if (proven.problems.length) {
      const question = `${proven.problems.map((problem) => problem.message).join('; ')}.`;
      receipt.intent = intent; receipt.reading = intent.reading;
      return { kind: 'clarify', intent, question, options: [], text: question, receipt };
    }
  }
  // What the first reading promised to SHOW. A repair may drop a label the
  // engine could not reach; the answer must say so rather than quietly
  // identifying its rows by an opaque key.
  const requestedDisplay = [...resolution.intent.display];
  if (input.groundLiterals) {
    const groundStarted = now();
    try {
      const grounded = await input.groundLiterals(intent);
      intent = grounded.intent;
      if (grounded.notes.length) receipt.grounding = grounded.notes;
    } catch (error) {
      receipt.grounding = [`literal grounding skipped: ${statementFailure(error).message}`];
    }
    mark('ground', groundStarted);
  }
  // A name the reading leans on that the filters never carried is bound from
  // the warehouse before anything is prepared.
  if (!settled && !aiReading && input.suggestMembers && remaining() > 8_000) {
    try {
      const bound = await bindNamedSubject(intent, input.question, input.vocabulary, input.suggestMembers);
      if (bound.length) receipt.grounding = [...(receipt.grounding ?? []), ...bound];
    } catch { /* a probe that fails leaves the reading as the interpreter wrote it */ }
  }
  // TYPED POLICIES ARE ENFORCED HERE (SKILL-004): the selected skills' and
  // the domain's required filters, time role, completeness and ranking
  // defaults, on the typed intent, before any proof or preparation. What
  // could not be bound is a refusal, never a silent predicate.
  const policies = applySkillPolicies(intent, input.vocabulary, { now, extraRequiredFilters: input.context?.header?.requiredFilters });
  if (policies.applied.length || policies.gaps.length) {
    receipt.policies = policies.applied.map((effect) => ({ policyId: effect.policyId, field: effect.field, effect: effect.effect }));
    receipt.context = { ...receipt.context!, enforced: { policies: policies.applied, requiredFilters: policies.requiredFilters, gaps: policies.gaps } };
  }
  // A required filter the reading's refs cannot carry is checked on the AI's
  // SQL itself (it must apply the filter); a question that contradicts a
  // policy is denied on either lane.
  if (policies.refusal && !(aiReading && policies.refusal.code === 'policy_filter_unbindable')) {
    receipt.refusals.push(policies.refusal);
    receipt.failure = { stage: 'prepare', reason: policies.refusal.code, message: policies.refusal.message };
    return { kind: 'gap', gap: 'denied', message: policies.refusal.message, nearest: [], text: composeGapText('denied', policies.refusal.message, [], false), receipt, intent, offerExploration: false };
  }
  // THE READING ALONE. Research frames an investigation from the proven,
  // policed reading and runs its own programs; nothing is prepared here.
  if (input.stopAfter === 'reading') {
    receipt.intent = intent; receipt.reading = intent.reading;
    return { kind: 'reading', intent, lane: aiReading ? 'ai' : 'governed', text: intent.reading, receipt };
  }
  // THE AI LANE. The reading is a hint: the drafter chooses the tables, the
  // fields and the joins, the SQL is checked before it runs (stated values,
  // required filters, a multiplying join, read-only), and the answer is
  // review-required and says what it did. Nothing about which tables are
  // "governed" is judged here, because nobody vouched for any of them.
  if (aiReading) {
    receipt.intent = intent; receipt.reading = intent.reading;
    recordSelection(intent);
    // A FORECAST IS NOT A MEASUREMENT. "Who is most likely to get injured next
    // season" has no measured part; answering it with a proxy (top scorers)
    // would be a substitute measure. It is an unsupported gap, nothing runs.
    const predictive = settled ? [] : predictiveOperatorsIn(input.question);
    if (predictive.length > 0) {
      const message = `Predicting what will happen (${predictive.join(', ')}) is not something Ask computes from the data; it reports what the data recorded. Research can investigate the history behind it`;
      return { kind: 'gap', gap: 'unsupported', message, nearest: [], text: composeGapText('unsupported', message, [], false), receipt, intent, offerExploration: false };
    }
    const operators = settled ? [] : causalOperatorsIn(input.question);
    if (operators.length > 0 && intent.measures.length === 0) {
      const message = `Explaining why something happened or recommending what to do (${operators.join(', ')}) is not something Ask computes; Research can investigate the drivers`;
      return { kind: 'gap', gap: 'unsupported', message, nearest: [], text: composeGapText('unsupported', message, [], false), receipt, intent, offerExploration: false };
    }
    const open = [
      ...intent.unresolved.filter((clause) => clause.material).map((clause) => clause.question ?? clause.clause),
      ...(resolution.status === 'resolved' ? resolution.problems.map((problem) => problem.message) : []),
    ];
    const why = `no certified block or semantic metric answers this${open.length ? ` (${open.join('; ').slice(0, 400)})` : ''}`;
    const judgment = operators.length > 0 ? [`${operators.map((word) => `"${word}"`).join(' and ')} ${operators.length === 1 ? 'is' : 'are'} not computed here: what follows is the measured comparison, not a recommendation and not a cause. Research can investigate the drivers`] : [];
    // A judgment question drafts only its measured comparison: the drafter is
    // given the reading, never the "should we" wording it would decline.
    const drafted = await schemaLane(why, intent, { caveats: judgment, ...(operators.length > 0 ? { draftQuestion: intent.reading } : {}) });
    if (drafted) return drafted;
    const message = open.length ? open.join('; ') : 'the AI could not write SQL that answers it from the tables it searched';
    return { kind: 'gap', gap: 'not_modeled', message, nearest: [], text: `No query was run: ${message.replace(/[.\s]+$/, '')}.`, receipt, intent, offerExploration: false };
  }
  // Whatever produced this reading — the interpreter, a follow-up edit, the
  // host's own grounding — a single row may not carry several members' facts.
  if (proveSubjectMatchesPopulation(intent, input.vocabulary)) keepMembersApart(intent, input.vocabulary);
  const merged = proveSubjectMatchesPopulation(intent, input.vocabulary);
  if (merged) {
    receipt.failure = { stage: 'prepare', reason: 'subject_population_mismatch', message: merged };
    return { kind: 'gap', gap: 'ambiguous', message: merged, nearest: [], text: `${composeGapText('ambiguous', merged, [], false)} Name the one you mean, or ask for them side by side.`, receipt, intent, offerExploration: false };
  }
  // Grounding and the host's own proofs replace the intent object, so the
  // receipt must be repointed: a receipt showing a reading the query did not
  // run is exactly the mismatch this pipeline exists to prevent.
  receipt.intent = intent;
  receipt.reading = intent.reading;
  recordSelection(intent);
  const uncovered = settled ? [] : uncoveredQuestionTerms(input.question, intent, input.vocabulary);
  if (uncovered.length) {
    receipt.uncovered = uncovered;
    // What each unused word names: a competing measure the reading chose not
    // to use is a choice; a thing or a condition it left out is a gap.
    receipt.coverage = coverageStates(input.question, uncovered).map((item) => ({
      ...item,
      names: [...new Set(input.vocabulary.lookup(item.word, { limit: 3, minScore: 0.97 }).filter((hit) => hit.matchedOn === 'name' || hit.matchedOn === 'alias').map((hit) => hit.entry.kind))],
    }));
  }

  // 2. Prepare (with cache and one bounded repair).
  const attempted = new Set<string>();
  let provedJoin = false;
  let prepared: PrepareResult | undefined;
  let firstPrepared: PrepareResult | undefined;
  let firstIntent: AnalyticalIntentV1 | undefined;
  let candidate: PreparedCandidate | undefined;
  let joinProvenForRetry = false;
  for (let round = 0; round < 2; round += 1) {
    const beforePrepare = stopped('prepare');
    if (beforePrepare) return { ...beforePrepare, intent } as PipelineOutcome;
    // The resolver, literal grounding, typed policies and one corrective
    // reading can all add scopes. Normalize only here, immediately before
    // preparation, so a shared comparison restriction reaches MetricFlow once
    // and an authored offset remains owned by the semantic engine.
    normalizeEffectiveIntent(intent);
    const prepareStarted = now();
    const cacheKey = `${input.cacheScope ?? ''}|${intentExecutionFingerprint(intent)}`;
    const cached = input.preparationCache?.get(cacheKey);
    if (cached) {
      candidate = cached;
      receipt.reuse = 'preparation';
      const earlier = preparedWith.get(cached);
      if (earlier) {
        receipt.refusals.push(...earlier.refusals);
        receipt.tiers.push(...earlier.tiers);
        tierSteps(earlier.tiers, undefined, 'when first prepared');
      }
      step('tier', `${TIER_NAMES[cached.tier] ?? cached.tier}: reused an earlier validated preparation`, 'done');
      receipt.candidates.push({ tier: cached.tier, trust: cached.trust, proof: [...cached.proof, 'reused a previously validated preparation'], sqlFingerprint: fingerprintSql(cached.sql), ...(cached.engine ? { engine: cached.engine } : {}) });
      mark('prepare', prepareStarted);
      break;
    }
    if (attempted.has(cacheKey)) break; // never repeat an unchanged failed attempt
    attempted.add(cacheKey);
    prepared = await prepare({ intent, vocabulary: input.vocabulary, deps: input.prepareDeps, explorationOptIn: false, explorationAuto: false, question: input.question });
    if (round === 0) { firstPrepared = prepared; firstIntent = intent; }
    mark(round === 0 ? 'prepare' : 'prepare_repair', prepareStarted);
    for (const item of prepared.candidates) receipt.candidates.push({ tier: item.tier, trust: item.trust, proof: item.proof, sqlFingerprint: fingerprintSql(item.sql), ...(item.engine ? { engine: item.engine } : {}) });
    receipt.refusals.push(...prepared.refusals);
    receipt.tiers.push(...prepared.attempts.map((attempt) => ({ round, ...attempt })));
    tierSteps(prepared.attempts, timings[round === 0 ? 'prepare' : 'prepare_repair'], joinProvenForRetry ? 'with the proven join' : round > 0 ? 'second try' : '');
    joinProvenForRetry = false;
    if (prepared.chosen) { candidate = prepared.chosen; break; }
    // One bounded repair: a repairable compile refusal goes back to the resolver with the engine's words.
    // With AI-written SQL available, a reading the semantic engine could not
    // compile goes to AI SQL instead of spending a dispatch re-reading it; a
    // certified block that does not apply is still re-read into metrics.
    const repairable = prepared.refusals.find((refusal) => refusal.repairable && !(aiSqlAvailable && refusal.tier === 'semantic'));
    // A settled reading is never re-read: its caller chose it.
    if (!repairable || round > 0 || remaining() < 12_000 || settled) break;
    const repairStarted = now();
    resolution = await resolveIntent({
      coverageQuestion: input.question,
      question: `${input.question}\n\nThe previous interpretation could not be prepared. ${repairable.tier === 'certified' ? 'The certified block is not applicable: ' : 'The engine said: '}${repairable.message}. ${repairable.tier === 'certified' ? 'Express the analysis with metric, entity and dimension refs instead of the block.' : 'Choose refs the engine can bind.'}`,
      vocabulary: input.vocabulary, provider: input.provider, prior: input.prior, priorExecuted: input.priorExecuted, ...(input.hidePriorValues ? { hidePriorValues: true } : {}), guidance: input.guidance, cardBudget: input.cardBudget, providerOptions, now, maxAttempts: 1, clauseCoverage: input.clauseCoverage, aiLane: aiSqlAvailable, ...(input.selection ? { selection: input.selection } : {}),
      renderedCards, ...(input.conversation ? { conversation: input.conversation } : {}),
      // The repair is held to the original question's obligations.
      ...(resolution.status === 'resolved' && resolution.ledger ? { ledger: resolution.ledger, ledgerRound: round + 1 } : {}),
      onDispatch: (event) => { receipt.dispatches.push({ purpose: 'intent:repair', ms: event.ms, reply: event.raw.slice(0, 1500), at: Date.now(), attempt: event.attempt, label: 'reread', ...(event.promptChars !== undefined ? { promptChars: event.promptChars } : {}) }); dispatchStep(event, true); },
    });
    mark('resolve_repair', repairStarted);
    recordLedger(resolution);
    if (resolution.status !== 'resolved') {
      receipt.failure = { stage: 'prepare', reason: `repair_${resolution.status}`, message: resolution.status === 'failed' ? resolution.detail : resolution.status === 'clarify' ? resolution.question : resolution.status, ...(resolution.status === 'failed' ? { problems: resolution.problems } : {}) };
      // A repair that came back with a QUESTION is a question for the user, not
      // an engine failure: asking it is the honest end of the turn, and the
      // compiler's message stays in the receipt.
      // ... unless a certified block is still standing as the answer of last
      // resort: serving what the team certified beats asking again.
      const fallbackWaiting = Boolean(prepared?.fallbacks?.[0] ?? firstPrepared?.fallbacks?.[0]);
      // With AI-written SQL available, the question it came back with is for
      // the drafter first, never a dead end in front of it.
      if (resolution.status === 'clarify' && resolution.question && !fallbackWaiting && aiSqlAvailable) break;
      if (resolution.status === 'clarify' && resolution.question && !fallbackWaiting) {
        receipt.intent = resolution.intent;
        const options = resolution.options.map((ref) => ({ ref, label: label(ref), ...(input.vocabulary.get(ref)?.description ? { description: input.vocabulary.get(ref)!.description } : {}) }));
        return { kind: 'clarify', intent: resolution.intent, question: resolution.question, options, text: resolution.question, receipt };
      }
      break;
    }
    intent = resolution.intent;
    // A repaired reading is grounded again: an identity a name carries (two
    // customers named Jordan Lee) must hold for the reading that runs, and a
    // note written about the first reading must not describe the second.
    if (input.groundLiterals) {
      try {
        const grounded = await input.groundLiterals(intent);
        intent = grounded.intent;
        receipt.grounding = [...(receipt.grounding ?? []).filter((note) => !note.startsWith('identity:')), ...grounded.notes];
      } catch { receipt.grounding = (receipt.grounding ?? []).filter((note) => !note.startsWith('identity:')); }
    }
    receipt.intent = intent;
  }
  // The answer of last resort: a certified block refused only for label-only
  // identity is served as published, with its caveat, when the repair re-ask
  // could not express the analysis by entity key. Never a dead end.
  if (!candidate) {
    const fallback = prepared?.fallbacks?.[0] ?? firstPrepared?.fallbacks?.[0];
    // THE LAST TIER, LAST: only after the governed repair and the certified
    // fallback have both come up empty does SQL get drafted from the schema —
    // never instead of a governed answer one re-ask away. A policy denial or a
    // domain-contract refusal never reaches it.
    const denied = receipt.refusals.some((refusal) => refusal.code === 'policy_filter_unbindable' || refusal.code === 'policy_conflict');
    if (!fallback && !denied && (input.explorationOptIn || input.explorationAuto)) {
      const drafted = await schemaLane(gapFromRefusals(receipt.refusals, intent, input.vocabulary).message, intent);
      if (drafted) return drafted;
    }
    if (candidate) { /* drafted: falls through to execution below */ }
    else if (fallback) {
      // Served from the certified block, but not certified FOR this question:
      // the badge is governed, the source stays the block.
      candidate = { ...fallback, trust: 'governed' };
      if (firstPrepared && fallback === firstPrepared.fallbacks[0]) intent = firstIntent ?? intent;
      receipt.intent = intent;
      for (let index = receipt.refusals.length - 1; index >= 0; index -= 1) {
        if (receipt.refusals[index]!.tier === 'certified' && /no identity key/.test(receipt.refusals[index]!.message)) receipt.refusals.splice(index, 1);
      }
      receipt.candidates.push({ tier: fallback.tier, trust: fallback.trust, proof: fallback.proof, sqlFingerprint: fingerprintSql(fallback.sql) });
      receipt.tiers.push({ round: 99, tier: 'certified', outcome: 'prepared', detail: 'served as published: no keyed governed answer could be composed' });
    }
  }
  if (!candidate) {
    const gap = gapFromRefusals(receipt.refusals, intent, input.vocabulary);
    // The offer stands only when exploration was neither opted into nor run on its own.
    const offerExploration = !input.explorationOptIn && !input.explorationAuto && receipt.refusals.some((refusal) => refusal.code === 'exploration_not_opted_in');
    return { kind: 'gap', gap: gap.gap, message: gap.message, nearest: gap.nearest.map(label), text: composeGapText(gap.gap, gap.message, gap.nearest.map(label), offerExploration), receipt, intent, offerExploration };
  }

  // 3. Execute and prove. A candidate that fails a proof (a dropped filter, a
  // multiplying join) is refused and the next governed tier is prepared for
  // the same intent; an unchanged attempt is never repeated.
  const excluded: PreparedCandidate['tier'][] = [];
  const beforeExecute = stopped('execute');
  if (beforeExecute) return { ...beforeExecute, intent } as PipelineOutcome;
  // A question that named a retired block is answered from its replacement,
  // and the run says so. The replacement carries its own trust; nothing of
  // the retired block's is served.
  const servedBlock = candidate.sourceRef ? input.vocabulary.get(candidate.sourceRef) : undefined;
  const retired = retiredBlockNamedBy(input.question, servedBlock);
  if (retired && servedBlock) {
    const sentence = retiredBlockSentence(retired, servedBlock.name);
    step('tier', sentence, 'done');
    if (!candidate.proof.includes(sentence)) candidate = { ...candidate, proof: [...candidate.proof, sentence] };
  }
  let executeStarted = now();
  let executed = await countedExecute(candidate, intent, input.executeDeps);
  mark('execute', executeStarted);
  step('execute', executed.ok ? `Ran the ${TIER_NAMES[candidate.tier]?.toLowerCase() ?? candidate.tier} query: ${executed.result.rowCount} row${executed.result.rowCount === 1 ? '' : 's'}` : `The ${TIER_NAMES[candidate.tier]?.toLowerCase() ?? candidate.tier} query did not succeed`, executed.ok ? 'done' : 'failed', { ms: timings.execute, ...(!executed.ok ? { detail: executed.message } : {}) });
  while (!executed.ok && (executed.code === 'filter_not_applied' || executed.code === 'fanout_detected') && excluded.length < 3 && remaining() > 5_000) {
    receipt.refusals.push({ tier: candidate.tier, code: executed.code, message: executed.message, repairable: false } as unknown as PreparedRefusal);
    receipt.tiers.push({ round: 9, tier: candidate.tier, outcome: 'refused', detail: `${executed.code}: ${executed.message.slice(0, 160)}` });
    excluded.push(candidate.tier);
    const again = await prepare({ intent, vocabulary: input.vocabulary, deps: input.prepareDeps, explorationOptIn: false, explorationAuto: false, question: input.question, excludeTiers: excluded });
    for (const item of again.candidates) receipt.candidates.push({ tier: item.tier, trust: item.trust, proof: item.proof, sqlFingerprint: fingerprintSql(item.sql), ...(item.engine ? { engine: item.engine } : {}) });
    receipt.refusals.push(...again.refusals.filter((refusal) => !excluded.includes(refusal.tier)));
    receipt.tiers.push(...again.attempts.map((attempt) => ({ round: 9, ...attempt })));
    tierSteps(again.attempts, undefined, 'after a failed proof');
    if (!again.chosen) {
      const gap = gapFromRefusals(receipt.refusals, intent, input.vocabulary);
      return { kind: 'gap', gap: gap.gap, message: gap.message, nearest: gap.nearest.map(label), text: composeGapText(gap.gap, gap.message, gap.nearest.map(label), false), receipt, intent, offerExploration: false };
    }
    candidate = again.chosen;
    executeStarted = now();
    executed = await countedExecute(candidate, intent, input.executeDeps);
    mark(`execute_${excluded.length + 1}`, executeStarted);
  }
  // A NAME THAT MATCHED NOTHING EXACTLY MAY NAME SEVERAL MEMBERS. The query
  // already filtered that column, so asking which of its values contain the
  // literal is no wider a reach; one match is canonicalised, several are all
  // shown and named, and too many stay an honest no-match.
  // Which stated members the warehouse was seen to hold, spelled as asked.
  const memberLookups = new Map<string, boolean>();
  if (!executed.ok && executed.code === 'no_rows_matched' && executed.cause?.kind === 'member' && input.suggestMembers && remaining() > 5_000) {
    const candidates: Array<{ predicate: IntentPredicate; values: string[]; stored?: { literal: string; values: IntentPredicate['values'] } }> = [];
    for (const literal of executed.cause.literals) memberLookups.set(literal, false);
    for (const predicate of intent.filters) {
      if (predicate.op !== 'eq' && predicate.op !== 'in') continue;
      const literal = predicate.values.find((value): value is string => typeof value === 'string' && value.trim().length > 2);
      if (!literal || !executed.cause.literals.includes(literal)) continue;
      try {
        const found = await input.suggestMembers(predicate.ref, literal);
        // The member is stored with other capitals or spacing: an engine that
        // compares text exactly (MetricFlow on Snowflake) missed the member
        // the question named, so the query runs again on its stored spelling.
        if (found.includes(literal)) memberLookups.set(literal, true);
        const stored = found.find((value) => value !== literal && value.trim().toLowerCase() === literal.trim().toLowerCase());
        if (stored) candidates.push({ predicate, values: [stored], stored: { literal, values: predicate.values.map((value) => (value === literal ? stored : value)) } });
        else if (found.length > 0 && found.length <= 6 && !found.some((value) => value.toLowerCase() === literal.toLowerCase())) candidates.push({ predicate, values: found });
      } catch { /* a probe that fails leaves the honest no-match in place */ }
    }
    if (candidates.length > 0) {
      // SEVERAL PEOPLE ARE NOT ONE PERSON. A singular name that matched no
      // member exactly, and several members that contain it, is a question:
      // which one? Adding their facts together answers about nobody, and the
      // reading above that row would still name whichever one it had in mind.
      const ambiguous = candidates.find((item) => !item.stored && item.values.length > 1 && item.predicate.op === 'eq' && item.predicate.values.length === 1);
      if (ambiguous) {
        const literal = String(ambiguous.predicate.values[0]);
        const name = label(ambiguous.predicate.ref);
        const options = [
          ...ambiguous.values.map((value) => ({ ref: memberOptionId(ambiguous.predicate.ref, [value]), label: value })),
          { ref: memberOptionId(ambiguous.predicate.ref, ambiguous.values), label: `All ${ambiguous.values.length}, one row each`, description: ambiguous.values.join(', ') },
        ];
        const question = `${JSON.stringify(literal)} matches ${ambiguous.values.length} members of ${name}: ${ambiguous.values.join(', ')}. Which one do you mean?`;
        receipt.grounding = [...(receipt.grounding ?? []), `identity: ${name} ${JSON.stringify(literal)} matched no member exactly and names ${ambiguous.values.length} members (${ambiguous.values.join(', ')}); the turn asked which one instead of adding them together`];
        receipt.tiers.push({ round: 9, tier: candidate.tier, outcome: 'refused', detail: `member_ambiguous: ${ambiguous.values.length} members contain ${JSON.stringify(literal)}` });
        receipt.executed = { tier: candidate.tier, sqlFingerprint: fingerprintSql(candidate.sql), rowCount: 0, ms: Math.round(now() - executeStarted), proofs: executed.proofs };
        return { kind: 'clarify', intent, question, options, text: question, receipt };
      }
      const notes: string[] = [];
      const widened: AnalyticalIntentV1 = {
        ...intent,
        filters: intent.filters.map((predicate) => {
          const found = candidates.find((item) => item.predicate === predicate);
          if (!found) return predicate;
          if (found.stored) {
            notes.push(`identity: ${label(predicate.ref)} ${JSON.stringify(found.stored.literal)} is stored as ${JSON.stringify(found.values[0])}; the query ran again on the stored spelling`);
            return { ...predicate, values: found.stored.values };
          }
          notes.push(`identity: ${label(predicate.ref)} ${JSON.stringify(String(predicate.values[0]))} matched no member exactly; ${found.values.length === 1 ? 'it is' : 'these are'} the ${found.values.length === 1 ? 'member' : `${found.values.length} members`} whose name contains it: ${found.values.join(', ')}`);
          return { ...predicate, op: 'in' as const, values: found.values };
        }),
      };
      // A set that widened to several members keeps them apart, and the
      // executable is not accepted until the population it reads is the
      // subject the reading claims.
      keepMembersApart(widened, input.vocabulary);
      const merged = proveSubjectMatchesPopulation(widened, input.vocabulary);
      if (!merged) {
        receipt.grounding = [...(receipt.grounding ?? []), ...notes];
        const again = await prepare({ intent: widened, vocabulary: input.vocabulary, deps: input.prepareDeps, explorationOptIn: false, explorationAuto: false, question: input.question });
        if (again.chosen) {
          const retried = await countedExecute(again.chosen, widened, input.executeDeps);
          if (retried.ok) { candidate = again.chosen; executed = retried; intent = widened; receipt.intent = widened; }
        }
      } else {
        receipt.grounding = [...(receipt.grounding ?? []), `identity: the widened reading was not run because ${merged}`];
      }
    }
  }
  // A TWO-DIGIT YEAR ON A YEAR FIELD. "FY26" read as 26 against a field that
  // stores 2026 matches nothing. When the restricted query came back empty,
  // the year is read once as 20YY and the answer says so; a field that really
  // stores 26 already returned its rows and never reaches this.
  if (!executed.ok && executed.code === 'no_rows_matched' && remaining() > 5_000) {
    const shortYear = (predicate: IntentPredicate) => (predicate.op === 'eq' || predicate.op === 'in')
      && /year|(?:^|[._])fy(?:[._]|$)/i.test(predicate.ref)
      && !(input.vocabulary.get(predicate.ref)?.roles ?? []).includes('time')
      && predicate.values.some((value) => /^\d{2}$/.test(String(value).trim()));
    const widenYear = (predicate: IntentPredicate): IntentPredicate => shortYear(predicate)
      ? { ...predicate, values: predicate.values.map((value) => /^\d{2}$/.test(String(value).trim()) ? (typeof value === 'number' ? 2000 + value : String(2000 + Number(value))) : value) }
      : predicate;
    const years = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])].filter(shortYear);
    if (years.length > 0) {
      const reread: AnalyticalIntentV1 = {
        ...intent,
        filters: intent.filters.map(widenYear),
        measures: intent.measures.map((measure) => (measure.scope?.length ? { ...measure, scope: measure.scope.map(widenYear) } : measure)),
      };
      const again = await prepare({ intent: reread, vocabulary: input.vocabulary, deps: input.prepareDeps, explorationOptIn: false, explorationAuto: false, question: input.question });
      if (again.chosen) {
        const retried = await countedExecute(again.chosen, reread, input.executeDeps);
        if (retried.ok) {
          receipt.grounding = [...(receipt.grounding ?? []), ...years.map((predicate) => `period: ${label(predicate.ref)} ${predicate.values.join(', ')} matched nothing; a two-digit year was read as ${widenYear(predicate).values.join(', ')}`)];
          candidate = again.chosen; executed = retried; intent = reread; receipt.intent = reread;
        }
      }
    }
  }
  if (!executed.ok && executed.code === 'no_rows_matched') {
    receipt.refusals.push({ tier: candidate.tier, code: executed.code, message: executed.message, repairable: false } as unknown as PreparedRefusal);
    receipt.executed = { tier: candidate.tier, sqlFingerprint: fingerprintSql(candidate.sql), rowCount: 0, ms: Math.round(now() - executeStarted), proofs: executed.proofs };
    const nearest = (receipt.grounding ?? []).filter((note) => note.includes('nearest'));
    const advice = executed.cause?.kind === 'window'
      ? 'The data may end before that period; ask for the latest period it holds.'
      : executed.cause?.kind === 'predicate'
        ? 'Loosen the restriction, or ask for the values this field holds.'
        : 'Check the spelling of the member, or ask for the values this field holds.';
    // The warehouse holds every member the question named, spelled as asked:
    // the member did not empty the result, the other restrictions did, and
    // the answer names them instead of doubting the spelling.
    const cause = executed.cause;
    if (cause?.kind === 'member' && cause.literals.length > 0 && cause.literals.every((literal) => memberLookups.get(literal))) {
      const others = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])]
        .filter((predicate) => !predicate.values.some((value) => typeof value === 'string' && cause.literals.includes(value)))
        .map((predicate) => `${label(predicate.ref)} ${predicate.op} ${predicate.values.map((value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))).join(', ')}`);
      if (intent.time?.window) others.push(`the period ${intent.time.window.start.slice(0, 10)}..${intent.time.window.end.slice(0, 10)}`);
      const named = cause.literals.map((value) => JSON.stringify(value)).join(', ');
      const message = `${named} ${cause.literals.length === 1 ? 'is' : 'are'} on the warehouse, but no rows matched ${cause.literals.length === 1 ? 'it' : 'them'} together with ${others.length ? others.join('; ') : 'the other restrictions'}; the aggregate was empty`;
      return { kind: 'gap', gap: 'not_retrieved', message, nearest, text: `The governed query ran, but ${message}. Loosen one of those restrictions, or ask for the values that field holds.`, receipt, intent, offerExploration: false };
    }
    return { kind: 'gap', gap: 'not_retrieved', message: executed.message, nearest, text: `The governed query ran, but ${executed.message}.${nearest.length ? ` ${nearest.join('; ')}.` : ''} ${advice}`, receipt, intent, offerExploration: false };
  }
  if (!executed.ok) {
    receipt.refusals.push({ tier: candidate.tier, code: executed.code, message: executed.message, repairable: false } as unknown as PreparedRefusal);
    receipt.failure = { stage: 'execute', reason: executed.code, message: executed.message, ...(executed.warehouse ? { warehouse: executed.warehouse } : {}) };
    return { kind: 'failed', stage: 'execute', message: executed.message, text: composeFailedText('execute', executed.message, executed.warehouse), receipt, intent };
  }
  const cacheKey = `${input.cacheScope ?? ''}|${intentExecutionFingerprint(intent)}`;
  if (input.preparationCache) {
    // A candidate reused from an earlier run keeps what that run recorded; its replay is already in this receipt.
    if (!preparedWith.has(candidate)) preparedWith.set(candidate, { tiers: [...receipt.tiers], refusals: [...receipt.refusals] });
    input.preparationCache.set(cacheKey, candidate);
  }
  receipt.executed = { tier: candidate.tier, sqlFingerprint: fingerprintSql(candidate.sql), rowCount: executed.result.rowCount, ms: Math.round(executed.result.executionTimeMs), proofs: executed.proofs };
  timings.total = Math.round(now() - started);
  // A certified block matched by meaning names its columns its own way; the
  // ones it was matched on are read as the question's measure and period.
  const blockRefs = new Map((candidate.outputRefs ?? []).map((item) => [item.output.toLowerCase(), item.ref]));
  const columnsMeta = describeResultColumns(intent, executed.result, input.vocabulary).map((meta) => {
    const ref = blockRefs.get(meta.name.toLowerCase());
    if (!ref) return meta;
    const grain = intent.groupBy.find((group) => group.ref === ref && group.role === 'time')?.grain;
    return { ...meta, ref, ...(grain ? { kind: 'date' as const, grain } : {}) };
  });
  const described: ExecutedRows = { ...executed.result, columnsMeta };
  // A series must cover the period it claims: a month the warehouse returned
  // no rows for is a month with nothing in it, not a month left out.
  const filled = fillPeriodGaps(intent, described);
  const result = filled.result;
  // A certified block served as published with an identity caveat says so in the answer.
  const tieNote = executed.proofs.find((line) => line.startsWith('tie: '))?.slice('tie: '.length);
  const caveats = candidate.tier === 'certified' ? candidate.proof.filter((line) => /no identity key/.test(line)).map((line) => `${line.replace(/; the certified block is served as published$/, '')}; recertify it with the entity key to keep them apart`) : [];
  // THE LABEL THE QUESTION ASKED FOR. "Which teams" is answered by names; when
  // the repair dropped the label because no governed relationship reaches it,
  // the rows carry a key and nothing else. The numbers can still be right, so
  // the answer is served, but the omission is named and the check does not
  // pass: opaque identifiers are not the answer to "which".
  if (filled.added > 0) receipt.executed = { ...receipt.executed!, proofs: [...(receipt.executed?.proofs ?? []), `${filled.added} ${intent.groupBy.find((group) => group.role === 'time')?.grain ?? 'period'}s of the window held no rows and are shown as zero`] };
  // A request that listed its parts is answered part by part: the ones no ref
  // is named for are said out loud, not left for the reader to notice.
  // Several rows tied for the top: the answer names the tie rather than
  // presenting one of them as the single best.
  if (tieNote) caveats.push(tieNote);
  if (judgmentCaveat) caveats.unshift(judgmentCaveat);
  // A part the POLICY answered for is answered: the required filters the
  // host applied are part of the reading, not context it lacks.
  const facets = settled ? [] : unmetFacets(input.question, intent, input.vocabulary, { policyTexts: [...(receipt.context?.enforced?.requiredFilters ?? []), ...(receipt.policies ?? []).map((policy) => policy.effect ?? '')] });
  if (facets.length > 0) {
    const message = `this answer carries nothing for ${facets.map((facet) => `"${facet}"`).join(', ')}: no governed metric or dimension of this project is named for ${facets.length === 1 ? 'it' : 'them'}`;
    receipt.unmet = [...(receipt.unmet ?? []), { obligation: 'coverage', message }];
    caveats.push(message);
  }
  // A breakdown answered with a stand-in field says so in the answer.
  for (const clause of intent.unresolved.filter((item) => !item.material && item.kind === 'not_modeled' && item.question)) caveats.push(clause.question!.replace(/[.\s]+$/, ''));
  const unmetLabel = unmetDisplayObligation(requestedDisplay, intent, receipt.refusals, label, input.question);
  if (unmetLabel) {
    receipt.unmet = [...(receipt.unmet ?? []), { obligation: 'display_label', message: unmetLabel.message, refs: unmetLabel.refs }];
    caveats.push(`${unmetLabel.message}; declare a governed relationship to that label (with its uniqueness and coverage proof), or add the label to the fact relation`);
  }
  // A member the host did not resolve to a key is matched by text, and the
  // answer says so: the reading may name a person, the predicate names a
  // string. A `contains` match can cover several members.
  const grounded = new Set((receipt.grounding ?? []).map((note) => note.toLowerCase()));
  const textMatches = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])]
    .filter((predicate) => (predicate.op === 'contains' || predicate.op === 'eq' || predicate.op === 'in') && predicate.values.some((value) => typeof value === 'string'))
    .filter((predicate) => { const entry = input.vocabulary.get(predicate.ref); return Boolean(entry && (entry.kind === 'dimension' || entry.kind === 'column') && !entry.roles.includes('time') && !entry.roles.includes('numeric') && !entry.roles.includes('boolean')); })
    .filter((predicate) => !predicate.values.some((value) => [...grounded].some((note) => note.includes(String(value).toLowerCase()))))
    .map((predicate) => {
      const entry = input.vocabulary.get(predicate.ref)!;
      const label = entry.label ?? entry.name;
      const literal = predicate.values.map((value) => JSON.stringify(String(value))).join(', ');
      return predicate.op === 'contains'
        ? `identity: ${label} matched by text containing ${literal}; that can cover several members, none was resolved to a key`
        : `identity: ${label} matched by exact text ${literal}, not resolved to a key`;
    });
  const usedJoins = (candidate.joins ?? []).map((step) => step.authority
    ? { source: step.authority.source, ...(step.authority.relationshipId ? { relationshipId: step.authority.relationshipId } : {}), authority: step.authority.authority, scope: step.authority.scope }
    : { source: 'declared', authority: 'unknown' });
  receipt.context = { ...receipt.context!, used: { joins: usedJoins, relations: [...new Set([...(candidate.relations ?? []), ...(candidate.joins ?? []).map((step) => step.relation)])], tier: candidate.tier, ...(candidate.engine ? { engine: candidate.engine } : {}) } };
  return { kind: 'answered', intent, candidate, result, text: composeAnsweredText(intent, result, input.vocabulary, candidate.trust, { notes: [...(receipt.grounding ?? []), ...textMatches], caveats }), receipt };
}
