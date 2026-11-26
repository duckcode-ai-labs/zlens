import type { AgentRun } from '../../api/client';

/**
 * CERTIFY FIRST: the guide on Ask's home while fewer than ten saved queries are
 * certified (Snowflake app fix plan, Risk 1, B1).
 *
 * On a fresh install nothing is certified, so every answer is AI-generated.
 * The guide leads a person to certify the questions they ask most: it lists
 * them from their own Ask history (never invented ones), most asked first, and
 * each step goes into the flow that already exists: the saved query's page,
 * where "Compare with the old report" checks it value by value against an
 * export of the report it replaces, and "I reviewed it — certify" certifies it.
 *
 * It counts certified saved queries, shows "N of 10 certified", and is gone
 * at ten. Dismissed, it stays away in this browser until Settings » Appearance
 * shows it again.
 */
export const CERTIFY_GOAL = 10;

/** The label an answer carries, in the words Ask uses. */
export type CertifyStepLabel = 'Certified' | 'From Metrics' | 'AI-generated' | 'Not in this data' | 'No answer';

export interface CertifyStep {
  /** The question as the person last asked it. */
  question: string;
  /** How its last answer was labelled. */
  label: CertifyStepLabel;
  /** How often it was asked: the draft's own count when Ask kept one, else the runs in the history read. */
  askedTimes: number;
  /** The draft saved query Ask kept for this answer, opened to compare and certify. */
  draftPath?: string;
  /** The last answer, for reference. */
  runId: string;
  lastAskedAt: string;
}

export interface CertifyFirstView {
  certified: number;
  goal: number;
  /** "2 of 10 certified". */
  progress: string;
  title: string;
  /** The questions to certify next, most asked first; at most what is left to the goal. */
  steps: CertifyStep[];
}

export const CERTIFY_FIRST_TITLE_NONE = 'Nothing is certified yet. Certify your 10 most-asked questions';
export const CERTIFY_FIRST_TITLE_SOME = 'Certify your 10 most-asked questions';
/** Why, in the labels' own words. */
export const CERTIFY_FIRST_WHY = 'Answers stay AI-generated (or From Metrics) until their question is certified.';
/** What a person does for each question, in the order the saved query's page offers it. */
export const CERTIFY_FIRST_HOW = 'For each one, open its saved query, use Compare with the old report with an export of the report you already trust, then certify it with "I reviewed it". Asked again in the same words, it is answered Certified, with no AI.';

/** The same question however it is cased or punctuated (Ask matches certified questions this way). */
export function certifyQuestionKey(question: string): string {
  return question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

type ListedRun = Pick<AgentRun, 'id' | 'question' | 'requestedMode' | 'route' | 'status' | 'trustState' | 'startedAt'> & {
  answer?: string;
  summary?: string;
  routeDecision?: unknown;
  conversationBinding?: unknown;
  reviewDraft?: { path?: string; askedTimes?: number };
};

const DATA_GAP = /\bdo not hold it\b|\bNot in this data\b/i;
const NO_MODEL = /\bNo AI model is configured\b/i;

/** The label of one answer from the run list (which carries no answer payloads). */
export function certifyStepLabel(run: ListedRun): CertifyStepLabel {
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

/** An Ask question a person could certify on its own: asked in Ask, not a chat reply or a follow-up. */
function isAskQuestion(run: ListedRun): boolean {
  if (run.requestedMode !== 'auto' && run.requestedMode !== 'ask') return false;
  if (!run.question?.trim() || run.route === 'conversation') return false;
  return !isFollowUp(run);
}

/** Ask asked back about it: too vague to certify as it stands. */
const askedBack = (run: ListedRun) => run.status === 'needs_clarification' || run.route === 'clarify';

/**
 * The questions to certify next, from the Ask history read: one step per question (however cased or punctuated),
 * its label from its last answer, most asked first, then the most recently asked. Left out: questions whose last
 * answer is Certified (done) and questions Ask last asked back about (too vague as they stand).
 */
export function certifySteps(runs: ReadonlyArray<ListedRun>, limit: number): CertifyStep[] {
  if (limit <= 0) return [];
  const byQuestion = new Map<string, { latest?: ListedRun; vague: boolean; runs: number; askedTimes: number; draftPath?: string }>();
  const newestFirst = [...runs].sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
  for (const run of newestFirst) {
    if (!isAskQuestion(run)) continue;
    const key = certifyQuestionKey(run.question);
    if (!key) continue;
    const entry = byQuestion.get(key) ?? { vague: false, runs: 0, askedTimes: 0 };
    if (!byQuestion.has(key)) {
      byQuestion.set(key, entry);
      // Its newest run decides: asked back about last time, it is not a question to certify yet.
      entry.vague = askedBack(run);
    }
    entry.runs += 1;
    if (typeof run.reviewDraft?.askedTimes === 'number') entry.askedTimes = Math.max(entry.askedTimes, run.reviewDraft.askedTimes);
    if (!entry.draftPath && run.reviewDraft?.path) entry.draftPath = run.reviewDraft.path;
    // The last answer (a stopped run is not one).
    if (!entry.latest && run.status !== 'cancelled' && !askedBack(run)) entry.latest = run;
  }
  return [...byQuestion.values()]
    .flatMap((entry) => {
      if (entry.vague || !entry.latest) return [];
      const label = certifyStepLabel(entry.latest);
      const step: CertifyStep = {
        question: entry.latest.question.trim(),
        label,
        askedTimes: Math.max(entry.askedTimes, entry.runs),
        runId: entry.latest.id,
        lastAskedAt: entry.latest.startedAt,
      };
      // A draft is worth opening only while the answer still has SQL to compare: not after a "Not in this data".
      if (entry.draftPath && (label === 'AI-generated' || label === 'From Metrics')) step.draftPath = entry.draftPath;
      return [step];
    })
    .filter((step) => step.label !== 'Certified')
    .sort((left, right) => right.askedTimes - left.askedTimes || right.lastAskedAt.localeCompare(left.lastAskedAt))
    // Ask keeps one draft per answer, so two wordings with the same answer share it: one step certifies it.
    .filter((step, index, all) => !step.draftPath || all.findIndex((other) => other.draftPath === step.draftPath) === index)
    .slice(0, limit);
}

/** Certified saved queries in the library (a replaced one no longer counts). */
export function certifiedSavedQueryCount(blocks: ReadonlyArray<{ status?: string; replacedBy?: string; deprecatedOn?: string }>): number {
  return blocks.filter((block) => block.status === 'certified' && !block.replacedBy && !block.deprecatedOn).length;
}

/** The guide, or null when it has nothing to do (ten or more certified). */
export function certifyFirstView(input: { certified: number; runs: ReadonlyArray<ListedRun> }): CertifyFirstView | null {
  const certified = Math.max(0, input.certified);
  if (certified >= CERTIFY_GOAL) return null;
  return {
    certified,
    goal: CERTIFY_GOAL,
    progress: `${certified} of ${CERTIFY_GOAL} certified`,
    title: certified === 0 ? CERTIFY_FIRST_TITLE_NONE : CERTIFY_FIRST_TITLE_SOME,
    steps: certifySteps(input.runs, CERTIFY_GOAL - certified),
  };
}

/** What a step's button does and says. */
export function certifyStepAction(step: CertifyStep): { kind: 'open_draft'; label: string } | { kind: 'ask'; label: string } {
  if (step.draftPath) return { kind: 'open_draft', label: 'Compare with the old report' };
  return { kind: 'ask', label: step.label === 'Not in this data' || step.label === 'No answer' ? 'Ask again' : 'Ask it' };
}

/** One line under a step: how often it was asked and what to do next. */
export function certifyStepNote(step: CertifyStep): string {
  const asked = step.askedTimes === 1 ? 'Asked once' : `Asked ${step.askedTimes} times`;
  if (step.draftPath) return `${asked}. Its saved query is a draft: compare it, then certify.`;
  if (step.label === 'Not in this data') return `${asked}. Not in this data, so there is nothing to certify yet.`;
  if (step.label === 'No answer') return `${asked}. It got no answer last time.`;
  return `${asked}. Ask it, then Save as saved query: its page has Compare with the old report.`;
}

// ── Dismissal (this browser) ────────────────────────────────────────────────
export const CERTIFY_GUIDE_DISMISSED_KEY = 'zlens-certify-guide-dismissed';
/** Fired in this tab when Settings shows the guide again or the card is dismissed. */
export const CERTIFY_GUIDE_CHANGED_EVENT = 'zlens:certify-guide-changed';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const browserStore = (): Store | undefined => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
};

export function certifyGuideDismissed(store: Store | undefined = browserStore()): boolean {
  try {
    return store?.getItem(CERTIFY_GUIDE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setCertifyGuideDismissed(dismissed: boolean, store: Store | undefined = browserStore()): void {
  try {
    if (dismissed) store?.setItem(CERTIFY_GUIDE_DISMISSED_KEY, '1');
    else store?.removeItem(CERTIFY_GUIDE_DISMISSED_KEY);
  } catch {
    // Storage can be blocked; the card then simply shows again next time.
  }
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CERTIFY_GUIDE_CHANGED_EVENT, { detail: { dismissed } }));
  } catch {
    // No window (tests, server render): nothing to tell.
  }
}
