import type { AgentRun } from '../../api/client';

/**
 * MOST ASKED FIRST: how often each question was asked in Ask, read from the person's own chat runs (never
 * invented). Saved queries lists drafts most asked first with it (the trust flow approved 2026-11-27). It replaces
 * the certify-first card on Ask's home, which counted the same way; Ask now saves an answer only when the person
 * presses Save, so the count comes from the runs, not from a draft Ask kept on its own.
 */

/** The label an answer carries, in the words Ask uses. */
export type AskedLabel = 'Certified' | 'From Metrics' | 'AI-generated' | 'Not in this data' | 'No answer';

export interface AskedQuestion {
  /** The question as the person last asked it. */
  question: string;
  /** The same question however it is cased or punctuated (see askedQuestionKey). */
  key: string;
  /** How its last answer was labelled; none when every run of it was stopped or asked back about. */
  label?: AskedLabel;
  /** How many times it was asked in the runs read. */
  askedTimes: number;
  /** Its newest run. */
  runId: string;
  lastAskedAt: string;
}

/** The same question however it is cased or punctuated (Ask matches certified questions this way). */
export function askedQuestionKey(question: string): string {
  return question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export type ListedRun = Pick<AgentRun, 'id' | 'question' | 'requestedMode' | 'route' | 'status' | 'trustState' | 'startedAt'> & {
  answer?: string;
  summary?: string;
  routeDecision?: unknown;
  conversationBinding?: unknown;
};

const DATA_GAP = /\bdo not hold it\b|\bNot in this data\b/i;
const NO_MODEL = /\bNo AI model is configured\b/i;

/** The label of one answer from the run list (which carries no answer payloads). */
export function askedLabel(run: ListedRun): AskedLabel {
  if (run.trustState === 'certified') return 'Certified';
  if (run.status === 'blocked' || run.trustState === 'blocked') {
    const words = `${run.answer ?? ''} ${run.summary ?? ''}`;
    return DATA_GAP.test(words) && !NO_MODEL.test(words) ? 'Not in this data' : 'No answer';
  }
  if (run.trustState === 'governed' || run.trustState === 'grounded') return 'From Metrics';
  return 'AI-generated';
}

/**
 * A question that only means something after the answer before it ("What about 2009?", "Which of those had a
 * winning record?"). The server marks one that reused the prior result; the openers catch the rest. Not the
 * route decision's `followsUp`: every Ask pipeline run carries it.
 */
const FOLLOW_UP_OPENER = /^(?:(?:what|how) about|and|also|same(?: for| but)?|now|then|instead|(?:which|what|who|how many) of (?:those|these|them|that))\b/i;
function isFollowUp(run: ListedRun): boolean {
  if (run.conversationBinding === 'prior_result' || run.conversationBinding === 'task_dependency') return true;
  return FOLLOW_UP_OPENER.test(run.question.trim());
}

/** A question asked in Ask on its own: not a chat reply, another mode or a follow-up. */
function isAskQuestion(run: ListedRun): boolean {
  if (run.requestedMode !== 'auto' && run.requestedMode !== 'ask') return false;
  if (!run.question?.trim() || run.route === 'conversation') return false;
  return !isFollowUp(run);
}

/** Ask asked back about it: no answer that time. */
const askedBack = (run: ListedRun) => run.status === 'needs_clarification' || run.route === 'clarify';

/**
 * One entry per question (however cased or punctuated), most asked first, then the most recently asked. Its label
 * comes from its last answer (a stopped run, or one Ask asked back about, is not an answer).
 */
export function mostAskedQuestions(runs: ReadonlyArray<ListedRun>): AskedQuestion[] {
  const byQuestion = new Map<string, { newest: ListedRun; latestAnswer?: ListedRun; runs: number }>();
  const newestFirst = [...runs].sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
  for (const run of newestFirst) {
    if (!isAskQuestion(run)) continue;
    const key = askedQuestionKey(run.question);
    if (!key) continue;
    const entry = byQuestion.get(key) ?? { newest: run, runs: 0 };
    byQuestion.set(key, entry);
    entry.runs += 1;
    if (!entry.latestAnswer && run.status !== 'cancelled' && !askedBack(run)) entry.latestAnswer = run;
  }
  return [...byQuestion.entries()]
    .map(([key, entry]): AskedQuestion => {
      const shown = entry.latestAnswer ?? entry.newest;
      return {
        question: shown.question.trim(),
        key,
        ...(entry.latestAnswer ? { label: askedLabel(entry.latestAnswer) } : {}),
        askedTimes: entry.runs,
        runId: entry.newest.id,
        lastAskedAt: entry.newest.startedAt,
      };
    })
    .sort((left, right) => right.askedTimes - left.askedTimes || right.lastAskedAt.localeCompare(left.lastAskedAt));
}
