/**
 * Conversation snapshot: the bounded, structured view of a thread that every
 * question carries into the answer loop — working state + rolling summary +
 * a few verbatim recent turns + how the new question relates to the topic.
 */

import type { ConversationResultMemberSetV1, ConversationStore, ConversationStoreLike, ConversationThread, ConversationTurn } from './session-store.js';
import type { AgentDqlArtifactReference } from '../answer-loop.js';
import type { CascadeAnswerResult } from '../cascade/cascade.js';
import type { KnowledgeLens } from '../domain-context.js';
import type { AnalyticalRequirementSetV1 } from '../analytical-orchestration.js';
import {
  parseWorkingState,
  reduceWorkingState,
  type ConversationWorkingState,
  type TopicRelation,
} from './working-state.js';
import {
  renderStructuredConversationSummary,
  updateRollingSummary,
  updateStructuredConversationSummary,
  type ConversationSummaryV1,
} from './rolling-summary.js';
import { isTrustedConversationTurn } from './turn-trust.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';
import { envEmbeddingProvider, hybridRank } from '../embeddings/provider.js';

/**
 * Verbatim turns carried into the prompt.
 *
 * Four was too shallow for the way people actually work: three follow-ups on a
 * result and the question that started it has already fallen out of the window,
 * so a deictic reference resolves against the wrong turn or not at all. The
 * rolling summary below still covers everything older, and it stays the
 * fallback — this only widens what is carried word for word.
 */
const RECENT_TURNS = 8;

export interface ConversationSnapshotTurn {
  id: string;
  question: string;
  answerSummary?: string;
  route?: string;
  trustLabel?: string;
  runStatus?: string;
  stopReason?: string;
  /** Carried so trust can be computed without re-reading the run. */
  refusalCode?: string;
  executionError?: string;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  knowledgeLens?: KnowledgeLens;
  resultColumns?: string[];
  resultRowCount?: number;
  resultDimensionValues?: Record<string, string[]>;
  /** Bounded local continuity sets; never rendered into portable trace output. */
  resultMemberSets?: ConversationResultMemberSetV1[];
  sourceSql?: string;
  dqlArtifact?: AgentDqlArtifactReference;
  cascade?: CascadeAnswerResult;
}

export interface ConversationEnvelopeV1 {
  /** Present on every newly built envelope; optional only for persisted v0 compatibility. */
  version?: 1;
  threadId: string;
  /** Present on every newly built envelope; optional only for persisted v0 compatibility. */
  surface?: string;
  rollingSummary?: string;
  /** Trust-aware, source-attributed summary of turns outside the recent window. */
  structuredSummary?: ConversationSummaryV1;
  workingState?: ConversationWorkingState;
  recentTurns: ConversationSnapshotTurn[];
  /** Semantic-recall hits over older turns (P5). */
  recalledTurns?: ConversationSnapshotTurn[];
  /** How the NEW question relates to the ongoing topic (when a question is supplied). */
  topicRelation?: TopicRelation;
  /** Latest clarification that is still the current turn. */
  /**
   * The clarification the last turn asked, and the analytical question it was
   * asked ABOUT. Both are needed: replying "by region" only makes sense
   * alongside the original request, and the engine has to restore that pairing
   * or the reply runs context-free and gets clarified again.
   */
  pendingClarification?: {
    sourceTurnId: string;
    /** The clarifying question ZLens asked. */
    question: string;
    /** The user's original analytical question that triggered it. */
    sourceQuestion?: string;
    /**
     * Server-persisted continuation contract. These identifiers and typed
     * requirements are reject-only on a later request; the router still checks
     * current snapshot eligibility before allowing a plan to freeze.
     */
    selection?: {
      version: 1;
      optionIds: string[];
      ambiguityCandidateIds: string[];
      requirements?: AnalyticalRequirementSetV1;
      snapshotId?: string;
      continuityFingerprint?: string;
    };
  };
}

/** Compatibility name retained for existing API/provider consumers. */
export type ConversationSnapshot = ConversationEnvelopeV1;

export interface ConversationHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

const STANDALONE_QUESTION_START_RE =
  /^(?:who|what|why|where|when|how|show|give|list|compare|build|create|which|calculate|find|tell)\b/i;

/**
 * A pending clarification is deliberately one-shot. Only a short, incomplete
 * value/choice should bind to it; a complete analytical request starts a fresh
 * turn even when the previous turn asked for clarification.
 */
export function isLikelyClarificationReply(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const words = normalized.split(' ').filter(Boolean);
  if (words.length > 40) return false;
  if (words.length >= 4 && STANDALONE_QUESTION_START_RE.test(normalized)) return false;
  if (words.length >= 7 && /\?\s*$/.test(normalized)) return false;

  // Compact analytical phrases such as "revenue by region" are complete Ask
  // turns even without a verb or question mark. A terse choice such as
  // "by region", "last quarter", or "use order date" remains a clarification.
  if (words.length >= 3) {
    const plan = buildAnalysisQuestionPlan(normalized);
    const hasMeasure = plan.metricTerms.length > 0;
    const hasSubject = plan.entities.length > 0 || plan.dimensionTerms.length > 0;
    // A measure paired with a time window or a ranking is a complete request
    // even without a recognized entity noun: "I need last two months highest
    // revenue and give me top 5 rows" is a fresh ask, and treating it as a
    // terse clarification reply stitched the previous turn's text into it.
    const hasWindowOrRanking = plan.timeTerms.length > 0 || Boolean(plan.requestedShape.topN);
    if ((hasMeasure && (hasSubject || hasWindowOrRanking)) || plan.entities.length >= 2) return false;
  }
  return true;
}

/**
 * Build the snapshot for a new question. When the question starts a genuinely
 * new topic (shift), the carried filters are deterministically cleared in the
 * snapshot — stale-context protection that doesn't rely on the model.
 */
export interface ConversationSnapshotOptions {
  question?: string;
  recent?: number;
  /**
   * Host-only structured-choice continuation. The Notebook replays the
   * original analytical question when an option is clicked, so that complete
   * wording must not clear the persisted server selection before the router
   * can validate it.
   */
  preservePendingClarification?: boolean;
}

export function buildConversationSnapshot(
  store: ConversationStore,
  threadId: string,
  options: ConversationSnapshotOptions = {},
): ConversationSnapshot | null {
  const thread = store.getThread(threadId);
  if (!thread) return null;
  return snapshotFromThread(thread, store.recentTurns(threadId, options.recent ?? RECENT_TURNS), options);
}

/**
 * `buildConversationSnapshot` over any conversation store, including a
 * host's own whose methods return Promises (RFC 0010 HH-6).
 */
export async function loadConversationSnapshot(
  store: ConversationStoreLike,
  threadId: string,
  options: ConversationSnapshotOptions = {},
): Promise<ConversationSnapshot | null> {
  const thread = await store.getThread(threadId);
  if (!thread) return null;
  return snapshotFromThread(thread, await store.recentTurns(threadId, options.recent ?? RECENT_TURNS), options);
}

function snapshotFromThread(
  thread: ConversationThread,
  recent: ConversationTurn[],
  options: ConversationSnapshotOptions,
): ConversationSnapshot {
  const threadId = thread.id;
  let workingState = parseWorkingState(thread.workingState);
  let topicRelation: TopicRelation | undefined;
  if (options.question && workingState.topicKey) {
    topicRelation = classifyQuestionRelation(workingState, options.question);
    if (topicRelation === 'shift') {
      // A new topic clears the WHOLE carried shape, not just the filters.
      // Leaving `topicKey`, entities, measures, dimensions and the prior result
      // columns in place meant a genuinely new question was still rendered under
      // "active topic: <the old one>" with the old measures and dimensions
      // attached — the reported "when I ask a different question it doesn't give
      // the right solution". `reduceWorkingState` already clears these on shift;
      // this path only cleared `filters`.
      //
      // A blocked turn deliberately does NOT fold into working state
      // (`turn-trust.ts`), so `topicKey` here still describes the last turn
      // that actually answered. That is correct and must stay: when a
      // misclassified follow-up used to fail, every retry compared against the
      // same stale key and shifted again, which read like an unrecoverable
      // loop. The defect was the classification, not the retention — do not
      // "fix" it by folding failed turns into the topic.
      workingState = {
        ...workingState,
        filters: [],
        entities: [],
        measures: [],
        dimensions: [],
        topicKey: undefined,
        timeframe: undefined,
        limit: undefined,
        sourceCertifiedBlock: undefined,
        lastResultColumns: undefined,
        lastResultDimensionValues: undefined,
      };
    }
  }
  const latest = recent[recent.length - 1];
  const latestNeedsClarification = Boolean(
    latest && (latest.route === 'clarify' || latest.runStatus === 'needs_clarification'),
  );
  const carryPendingClarification = latestNeedsClarification
    && (!options.question || isLikelyClarificationReply(options.question) || options.preservePendingClarification === true);
  return {
    version: 1,
    threadId,
    surface: thread.surface,
    rollingSummary: thread.rollingSummary,
    structuredSummary: thread.structuredSummary,
    workingState: hasWorkingState(workingState) ? workingState : undefined,
    recentTurns: recent.map(snapshotTurn),
    topicRelation,
    pendingClarification: latest && carryPendingClarification
      ? {
          sourceTurnId: latest.id,
          question: latest.answerSummary ?? latest.answerText ?? latest.question,
          // Walk back past any intermediate short replies to the last real
          // analytical question, so a repeated clarify chain still recovers the
          // request rather than a terse "yes".
          sourceQuestion: analyticalQuestionBefore(recent, recent.length - 1),
          ...(pendingClarificationSelection(latest)
            ? { selection: pendingClarificationSelection(latest) }
            : {}),
        }
      : undefined,
  };
}

function pendingClarificationSelection(
  turn: ConversationTurn,
): NonNullable<ConversationEnvelopeV1['pendingClarification']>['selection'] | undefined {
  const raw = turn.contract?.clarificationSelection;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const ids = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))].slice(0, 16)
    : [];
  const optionIds = ids(record.optionIds);
  const ambiguityCandidateIds = ids(record.ambiguityCandidateIds);
  if (optionIds.length === 0 && ambiguityCandidateIds.length === 0) return undefined;
  const requirements = record.requirements && typeof record.requirements === 'object' && !Array.isArray(record.requirements)
    ? record.requirements as AnalyticalRequirementSetV1
    : undefined;
  const snapshotId = typeof record.snapshotId === 'string' && record.snapshotId.trim()
    ? record.snapshotId.trim()
    : undefined;
  const continuityFingerprint = typeof record.continuityFingerprint === 'string' && record.continuityFingerprint.trim()
    ? record.continuityFingerprint.trim()
    : undefined;
  return {
    version: 1,
    optionIds,
    ambiguityCandidateIds,
    ...(requirements ? { requirements } : {}),
    ...(snapshotId ? { snapshotId } : {}),
    ...(continuityFingerprint ? { continuityFingerprint } : {}),
  };
}

/**
 * Walk back from `index` to the last turn whose question is a real analytical
 * request rather than a clarification reply. A repeated clarify chain
 * (original question → "yes" → clarify again) must recover the ORIGINAL
 * request; returning the intermediate "yes" is how the loop kept restarting
 * from a context-free word.
 */
function analyticalQuestionBefore(turns: ConversationTurn[], index: number): string | undefined {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const question = turns[cursor]?.question?.trim();
    if (question && !isLikelyClarificationReply(question)) return question;
  }
  return turns[Math.max(0, index)]?.question?.trim() || undefined;
}

/**
 * Post-run maintenance: fold the appended turn into the thread's working state
 * and compact turns that just left the recent window into the rolling summary.
 * Incremental and idempotent (cursor = summaryTurnSeq); never throws.
 */
export function advanceThreadState(store: ConversationStore, threadId: string, turn: ConversationTurn): void {
  try {
    const thread = store.getThread(threadId);
    if (!thread) return;
    const window = compactionWindow(thread, turn);
    const compactable = window ? store.turnsForCompaction(threadId, window.afterSeq, window.beforeSeq) : [];
    store.updateThreadState(threadId, nextThreadState(thread, turn, compactable));
  } catch {
    // Advisory maintenance — never fail the run for it.
  }
}

/** `advanceThreadState` over any conversation store, including a host's own (RFC 0010 HH-6). Never throws. */
export async function advanceThreadStateAsync(store: ConversationStoreLike, threadId: string, turn: ConversationTurn): Promise<void> {
  try {
    const thread = await store.getThread(threadId);
    if (!thread) return;
    const window = compactionWindow(thread, turn);
    const compactable = window ? await store.turnsForCompaction(threadId, window.afterSeq, window.beforeSeq) : [];
    await store.updateThreadState(threadId, nextThreadState(thread, turn, compactable));
  } catch {
    // Advisory maintenance — never fail the run for it.
  }
}

/** Everything older than the recent verbatim window and not yet folded in, or nothing. */
function compactionWindow(thread: ConversationThread, turn: ConversationTurn): { afterSeq: number; beforeSeq: number } | undefined {
  const compactBefore = Math.max(turn.seq - RECENT_TURNS + 1, 1);
  return thread.summaryTurnSeq < compactBefore - 1 ? { afterSeq: thread.summaryTurnSeq, beforeSeq: compactBefore } : undefined;
}

function nextThreadState(thread: ConversationThread, turn: ConversationTurn, compactable: ConversationTurn[]): Parameters<ConversationStore['updateThreadState']>[1] {
  const { state } = reduceWorkingState(parseWorkingState(thread.workingState), turn);
  const rollingSummary = compactable.length > 0
    ? updateRollingSummary({ previousSummary: thread.rollingSummary, compactedTurns: compactable })
    : thread.rollingSummary;
  const structuredSummary = compactable.length > 0
    ? updateStructuredConversationSummary({
        previousSummary: thread.structuredSummary,
        compactedTurns: compactable,
      })
    : thread.structuredSummary;
  return {
    workingState: state as unknown as Record<string, unknown>,
    rollingSummary,
    ...(structuredSummary ? { structuredSummary } : {}),
    summaryTurnSeq: compactable.length > 0
      ? compactable[compactable.length - 1].seq
      : thread.summaryTurnSeq,
  };
}

/**
 * Semantic recall over the thread's OLDER turns ("what did we discuss about X?").
 * FTS candidates are re-ranked with the configured project embedding provider
 * (and the deterministic local fallback when no provider is configured).
 * Turns already in the recent verbatim window are excluded; returns at most
 * `limit` hits. Never throws.
 */
export async function recallRelevantTurns(
  store: ConversationStoreLike,
  threadId: string,
  question: string,
  options: { limit?: number; excludeTurnIds?: string[] } = {},
): Promise<ConversationSnapshotTurn[]> {
  try {
    const excluded = new Set(options.excludeTurnIds ?? []);
    const candidates = (await store.searchTurns({ query: question, threadId, limit: 24 }))
      .filter((turn) => !excluded.has(turn.id))
      .filter((turn) => isUsableAnalyticalContextTurn(snapshotTurn(turn)));
    if (candidates.length === 0) return [];
    const ranked = await hybridRank(
      question,
      candidates.map((turn, index) => ({
        item: turn,
        // FTS returns rank-ordered rows; convert position to a [0,1] score.
        ftsScore: 1 - index / candidates.length,
        text: `${turn.question} ${turn.answerSummary ?? ''}`,
      })),
      { alpha: 0.4, provider: envEmbeddingProvider() },
    );
    return ranked.slice(0, options.limit ?? 3).map((entry) => snapshotTurn(entry.item));
  } catch {
    return [];
  }
}

/** Read the canonical server envelope while accepting the original key during upgrades. */
export function conversationEnvelopeFromContext(
  context: Record<string, unknown> | undefined,
): ConversationEnvelopeV1 | undefined {
  if (!context) return undefined;
  const raw = context.conversationEnvelope ?? context.serverSnapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const envelope = raw as Partial<ConversationEnvelopeV1>;
  if (typeof envelope.threadId !== 'string' || !Array.isArray(envelope.recentTurns)) return undefined;
  return {
    ...envelope,
    version: 1,
    surface: typeof envelope.surface === 'string' ? envelope.surface : 'agent',
    threadId: envelope.threadId,
    recentTurns: envelope.recentTurns,
  } as ConversationEnvelopeV1;
}

/**
 * One bounded history projection for routing, meaning resolution, planning and
 * execution fallbacks. Review/blocked state is explicit so prose cannot silently
 * become trusted analytical context.
 */
export function conversationHistoryFromContext(
  context: Record<string, unknown> | undefined,
  limit = 6,
): ConversationHistoryMessage[] {
  const envelope = conversationEnvelopeFromContext(context);
  if (!envelope) return [];
  return envelope.recentTurns
    .filter(isUsableAnalyticalContextTurn)
    .slice(-Math.max(1, limit))
    .flatMap((turn) => {
      const answer = turn.answerSummary?.trim();
      return [
        { role: 'user' as const, text: turn.question },
        ...(answer
          ? [{
              role: 'assistant' as const,
              text: `[${conversationTurnContextState(turn)}] ${answer}`,
            }]
          : []),
      ];
    });
}

/** Compact non-prose context shared by every orchestration stage. */
export function renderConversationEnvelopeForPrompt(
  context: Record<string, unknown> | undefined,
): string | undefined {
  const envelope = conversationEnvelopeFromContext(context);
  if (!envelope) return undefined;
  const state = envelope.workingState
    ? parseWorkingState(envelope.workingState as unknown as Record<string, unknown>)
    : undefined;
  const summary = renderStructuredConversationSummary(envelope.structuredSummary)
    ?? envelope.rollingSummary;
  const stateLines = state
    ? [
        state.topicKey ? `active topic: ${state.topicKey}` : '',
        state.entities.length ? `entities: ${state.entities.join(', ')}` : '',
        state.measures.length ? `measures: ${state.measures.join(', ')}` : '',
        state.dimensions.length ? `dimensions: ${state.dimensions.join(', ')}` : '',
        state.filters.length ? `filters: ${state.filters.map((filter) => filter.value).join(', ')}` : '',
        state.timeframe ? `timeframe: ${state.timeframe}` : '',
        state.limit !== undefined ? `limit: ${state.limit}` : '',
      ].filter(Boolean)
    : [];
  const lines = [
    `thread: ${envelope.threadId}`,
    `surface: ${envelope.surface}`,
    envelope.topicRelation ? `new-turn relation: ${envelope.topicRelation}` : '',
    ...stateLines,
    envelope.pendingClarification
      ? `pending clarification: ${envelope.pendingClarification.question}`
      : '',
    summary ? `older trusted-state summary:\n${summary}` : '',
  ].filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** Classify the NEW question against the current topic key (same Jaccard rule as the reducer). */
function classifyQuestionRelation(state: ConversationWorkingState, question: string): TopicRelation {
  const plan = buildAnalysisQuestionPlan(question);
  const terms = new Set([
    ...plan.entities.map((entity) => normalizeTerm(entity.text)),
    ...plan.metricTerms.map(normalizeTerm),
  ].filter(Boolean));
  const topicTerms = new Set((state.topicKey ?? '').split('|').filter(Boolean));
  // An unreadable question DEFAULTS TO CONTINUATION.
  //
  // A short fragment — "and by month?", "now by region", "what about 2023" — is
  // the single most common follow-up shape, and the analysis planner reads none
  // of it. Treating those as a new topic threw away the measure and timeframe
  // the follow-up depends on, which is how a MetricFlow query ended up missing
  // `metric_time` and how generated SQL lost the relations it needed.
  //
  // Only a question that plainly stands on its own is a shift. Preserving
  // context is the safer default: a stale carry produces a wrong-ish answer the
  // user can redirect, while a dropped carry breaks the follow-up outright.
  if (terms.size === 0) {
    return standsAloneAsNewQuestion(question) ? 'shift' : 'continuation';
  }
  if (topicTerms.size === 0) return 'continuation';
  let shared = 0;
  for (const term of terms) if (topicTerms.has(term)) shared += 1;
  const overlap = shared / (terms.size + topicTerms.size - shared);
  if (overlap >= 0.5) return 'continuation';
  if (overlap > 0) return 'refinement';
  const returned = (state.priorTopics ?? []).some((frame) => {
    const frameTerms = new Set(frame.topicKey.split('|').filter(Boolean));
    let hit = 0;
    for (const term of terms) if (frameTerms.has(term)) hit += 1;
    return frameTerms.size > 0 && hit / (terms.size + frameTerms.size - hit) >= 0.5;
  });
  if (returned) return 'return';
  // A question carrying no measure, dimension or entity stays a REFINEMENT, as
  // it always has. The danger this used to feed — a refinement silently reusing
  // an unrelated question's whole context pack, route decision included — is now
  // blocked at its real source by `isFilterOnlyRefinement`, which requires both
  // plans to carry actual signal. Narrowing the classifier as well was belt and
  // braces that cost genuine follow-ups their context.
  const onlyRefinement = plan.dimensionTerms.length === 0 && plan.metricTerms.length === 0 && plan.entities.length === 0;
  if (onlyRefinement) return 'refinement';
  // An ATTRIBUTE LOOKUP about the previous answer is not a new topic, even
  // though it reads like one. "what region he belongs to" and
  // `which region "Mr. Matthew Meyer" belongs to` each contribute a dimension
  // term ("region") the prior topic never carried, so the overlap rule above
  // scored zero and called it a shift — and a shift discards the entire
  // follow-up context, including the member set the question is ABOUT. The
  // subject is unchanged; only the requested attribute is new. Refinement is
  // the truthful label, and it is what keeps the prior result reachable.
  if (questionNamesPriorResultValue(question, state.lastResultDimensionValues)) return 'refinement';
  if (carriesAnaphoricReference(question)) return 'refinement';
  return 'shift';
}

/**
 * Does the question point back with a pronoun or demonstrative? Deliberately
 * NARROWER than `referencesPriorTurn`: the additive connectives that belong
 * there ("and", "now", "also", "about") appear in plenty of self-contained
 * questions, and this predicate runs against questions that already carry
 * their own analytical vocabulary. "revenue and orders by month" must stay a
 * shift; "what region he belongs to" must not.
 */
function carriesAnaphoricReference(question: string): boolean {
  return /\b(it|its|he|him|his|she|her|hers|they|them|their|theirs|this|that|these|those|same)\b/i.test(question);
}

/**
 * Does the question quote a value the previous answer actually displayed?
 * A named member is the strongest possible signal that the turn is about the
 * prior result, and it is the one case where the user has removed all
 * ambiguity — dropping the context here is what turned an answerable
 * `which region "Mr. Matthew Meyer" belongs to` into an unbounded search.
 */
function questionNamesPriorResultValue(
  question: string,
  priorValues: Record<string, string[]> | undefined,
): boolean {
  if (!priorValues) return false;
  const haystack = normalizeConversationValue(question);
  if (!haystack) return false;
  for (const values of Object.values(priorValues)) {
    for (const value of values) {
      // Short values ("NY", "A") collide with ordinary words; require enough
      // signal that a whole-string containment is really a member reference.
      const needle = normalizeConversationValue(value);
      if (needle.length < 4) continue;
      if (haystack.includes(needle)) return true;
    }
  }
  return false;
}

/**
 * Fold a displayed value and a question onto the same comparison surface.
 * Mirrors the host-side value normalizer so `Mr. Matthew Meyer` in a result
 * matches `"Mr. Matthew Meyer"` typed with quotes and odd spacing.
 */
function normalizeConversationValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A question that reads as a complete, self-contained request rather than a
 * fragment continuing the last one. Deliberately demanding: it must open with an
 * interrogative or command verb AND carry enough words to stand alone AND not
 * point back at the previous turn. "How many warehouse shipments were delayed?"
 * qualifies; "what about 2023", "show monthly" and "by month" do not.
 */
function standsAloneAsNewQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 5) return false;
  if (referencesPriorTurn(normalized)) return false;
  return /^(who|what|which|when|where|why|how|show|list|give|count|find|compare|calculate)\b/i.test(normalized);
}

/**
 * A whole new question in an existing Ask chat, read on its own rather than as an edit of the previous answer
 * (new-user test B2, 2026-11-10: "What was the total number of points scored in the 2016 regular season?",
 * asked after other questions, inherited their filters and was refused with the validator's internal text;
 * the same question in a fresh chat was answered). Narrower about pointing back than `referencesPriorTurn`:
 * "and" or "then" inside a sentence ("Which teams did Kevin Durant play for, and in which seasons?") does not
 * point back, nor does "that" as a relative pronoun ("teams that won"). A fragment ("and by month?", "what
 * about 2016?"), a pronoun or demonstrative with no referent in the question ("how did he do?", "which of
 * those…"), or words like "same", "instead", "again" keep the previous answer as the one being edited.
 */
export function readsAsNewQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, ' ').trim();
  if (normalized.split(' ').filter(Boolean).length < 6) return false;
  // Only a question word opens a new question: in a chat a command ("Show only 2017, and expand that…",
  // "List them by…") edits the answer on screen.
  if (!/^(who|what|which|when|where|why|how)\b/i.test(normalized)) return false;
  if (/^(what|how) about\b/i.test(normalized)) return false;
  if (/\b(it|its|he|him|his|she|her|hers|those|these|same|above|previous|prior|instead|again|aforementioned)\b/i.test(normalized)) return false;
  // "that" as the thing acted on ("expand that", "break that down") points back; as a relative pronoun ("teams
  // that won") it does not.
  return !/\b(expand|show|change|break|split|sort|rank|filter|limit|do|redo|make|turn|keep|add|drop|remove)\s+that\b/i.test(normalized);
}

/**
 * Does the question explicitly point at what came before? Deictic and additive
 * connectives are both reliable signals that the user means "carry the previous
 * context", independent of whether the planner recognised any vocabulary.
 */
function referencesPriorTurn(question: string): boolean {
  // Third-person personal pronouns belong here for the same reason "it" and
  // "them" do: they have no referent inside the question. Their absence made
  // "what region he belongs to" read as a self-contained new topic, which
  // discarded the very answer the pronoun pointed at. Every other deictic
  // module in the codebase already lists them.
  return /\b(it|its|he|him|his|she|her|hers|they|theirs|that|this|those|these|them|their|there|same|above|previous|prior|instead|also|too|and|now|next|then|plus|about)\b/i.test(question);
}

function snapshotTurn(turn: ConversationTurn): ConversationSnapshotTurn {
  return {
    id: turn.id,
    question: turn.question,
    answerSummary: turn.answerSummary,
    route: turn.route,
    trustLabel: turn.trustLabel,
    runStatus: turn.runStatus,
    stopReason: turn.stopReason,
    sourceCertifiedBlock: turn.sourceCertifiedBlock,
    contextPackId: turn.contextPackId,
    knowledgeLens: turn.knowledgeLens,
    resultColumns: turn.result?.columns,
    resultRowCount: turn.result?.rowCount,
    resultDimensionValues: turn.result?.dimensionValues,
    resultMemberSets: turn.result?.memberSets,
    refusalCode: turn.refusalCode,
    executionError: turn.executionError,
    sourceSql: turn.sql,
    dqlArtifact: turn.dqlArtifact,
    cascade: turn.cascade,
  };
}

export function conversationTurnContextState(turn: ConversationSnapshotTurn): string {
  if (turn.runStatus === 'cancelled' || turn.stopReason === 'cancelled' || turn.route === 'cancelled') {
    return 'cancelled';
  }
  if (turn.runStatus === 'blocked' || turn.trustLabel === 'blocked' || turn.route === 'blocked') {
    return 'blocked';
  }
  if (turn.runStatus === 'needs_clarification' || turn.route === 'clarify') {
    return 'unresolved';
  }
  if (turn.runStatus === 'needs_review' || turn.trustLabel === 'review_required') {
    return 'provisional';
  }
  if (turn.trustLabel === 'certified' || turn.trustLabel === 'governed' || turn.trustLabel === 'grounded') {
    return 'confirmed';
  }
  return 'context';
}

function isUsableAnalyticalContextTurn(turn: ConversationSnapshotTurn): boolean {
  // One predicate, shared with the provider layer, the working-state reducer and
  // the prompt renderer. They used to disagree, and a failed turn slipped
  // through every one of them.
  return isTrustedConversationTurn(turn);
}

function hasWorkingState(state: ConversationWorkingState): boolean {
  return state.entities.length > 0
    || state.measures.length > 0
    || state.dimensions.length > 0
    || state.filters.length > 0
    || Boolean(state.topicKey);
}

function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_ ]+/g, '').replace(/s$/, '').trim();
}
