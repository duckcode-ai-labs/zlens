import { upsertReviewRequiredAnswerDraft, type AgentRun, type AgentRunReviewDraftV1 } from '@zlens/agent';

/**
 * Graduated trust, Tier 2: an answer that is not backed by a certified block
 * is labelled review-required AND leaves a durable draft block a person can
 * review and certify (docs/architecture/graduated-trust.md). This is the one
 * place every Ask surface gets that draft from: the notebook UI, `zlens agent
 * ask` and MCP `answer_question` all run through `POST /api/agent-runs`.
 *
 * The answer's executed DQL artifact stays transient — it is the execution
 * receipt and is never replaced by a file. The draft is a separate copy under
 * `blocks/_drafts/` (or `domains/<d>/blocks/_drafts/`), always `status =
 * "draft"`, de-duplicated by the answer SQL's fingerprint and by question so
 * repeats bump `asked_times` instead of adding files.
 */

interface ReviewAnswer {
  question: string;
  sql: string;
  dqlArtifact?: { source: string; name?: string; kind?: string };
  domain?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Words that only mean something after an earlier answer: "What about 2009?", "Which of those…", "And for the Lakers?". */
const FOLLOW_UP_WORDS = /^\s*(?:(?:what|how)\s+about|and|also|now|same|then|only)\b|\b(?:those|these|them|that one|the same|instead)\b/i;

/**
 * The question a draft is named and filed under. A follow-up ("What about
 * 2009?") is named from what it answered, its reading, never from its own few
 * words: those name nothing on their own, and the same words after another
 * question would land in the same draft (new-user test V12: "about_2009").
 */
export function standaloneQuestionOf(run: Pick<AgentRun, 'question' | 'conversationBinding'>, payload: Record<string, unknown> | undefined): string {
  const intent = record(payload?.askIntentV1);
  const reading = text(intent?.reading)?.replace(/\s+/g, ' ').trim();
  if (!reading) return run.question;
  const sameWords = reading.toLowerCase().replace(/[\s?.!]+$/, '') === run.question.toLowerCase().replace(/\s+/g, ' ').replace(/[\s?.!]+$/, '').trim();
  if (sameWords) return run.question;
  const provenance = Object.values(record(intent?.provenance) ?? {});
  const filters = Array.isArray(intent?.filters) ? intent!.filters as unknown[] : [];
  const carried = run.conversationBinding === 'prior_result' || run.conversationBinding === 'task_dependency'
    || provenance.some((source) => source === 'inherited' || source === 'prior_result')
    || filters.some((filter) => { const source = record(filter)?.source; return source === 'inherited' || source === 'prior_result'; });
  return carried || FOLLOW_UP_WORDS.test(run.question) ? reading : run.question;
}

/** The review-required answer a run produced, when it produced one worth keeping. */
export function reviewRequiredAnswerOf(run: AgentRun): ReviewAnswer | null {
  if (run.status !== 'completed' && run.status !== 'needs_review') return null;
  // A certified answer already is a saved query; nothing to review.
  if (run.trustState === 'certified') return null;
  if (run.figuresWithheld) return null;
  for (const artifact of run.artifacts ?? []) {
    if (artifact.kind !== 'answer') continue;
    const payload = record(artifact.payload);
    if (!payload) continue;
    const reviewRequired = artifact.trustState === 'review_required'
      || payload.reviewStatus === 'review_required'
      || payload.certification === 'review_required'
      || payload.kind === 'uncertified';
    if (!reviewRequired || payload.kind === 'certified' || payload.certification === 'certified') continue;
    // Only an answer that actually ran: a refusal or clarification has no result.
    if (!record(payload.result)) continue;
    const dql = record(payload.dqlArtifact);
    const sql = text(dql?.compiledSql) ?? text(payload.sql);
    if (!sql) continue;
    const source = text(dql?.source);
    return {
      question: standaloneQuestionOf(run, payload),
      sql,
      ...(source ? { dqlArtifact: { source, ...(text(dql?.name) ? { name: text(dql?.name)! } : {}), ...(text(dql?.kind) ? { kind: text(dql?.kind)! } : {}) } } : {}),
      ...(text(payload.domain) ? { domain: text(payload.domain)! } : {}),
    };
  }
  return null;
}

/**
 * Save (or re-find) the review draft for a run's review-required answer.
 * Returns undefined when the run has no such answer. Never throws: a draft
 * that cannot be written must not lose the answer itself.
 */
export function captureReviewRequiredDraft(
  projectRoot: string,
  run: AgentRun,
  options: { owner?: string } = {},
): AgentRunReviewDraftV1 | undefined {
  const answer = reviewRequiredAnswerOf(run);
  if (!answer) return undefined;
  try {
    const saved = upsertReviewRequiredAnswerDraft(projectRoot, {
      question: answer.question,
      sql: answer.sql,
      ...(answer.dqlArtifact ? { dqlArtifact: answer.dqlArtifact } : {}),
      ...(answer.domain ? { proposedDomain: answer.domain } : {}),
      ...(options.owner ? { owner: options.owner } : {}),
      runId: run.id,
    });
    return { version: 1, path: saved.path, status: 'draft', askedTimes: saved.askedTimes, created: saved.created, fingerprint: saved.fingerprint };
  } catch {
    return undefined;
  }
}
