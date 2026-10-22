/**
 * HOW AN ASK RUN WAS ANSWERED, IN ORDER AND IN PLAIN WORDS.
 *
 * One pure model over the Ask pipeline's run record (`diagnosticReceiptV9`)
 * and its answer payload, shared by the "How it was answered" flow and the
 * decision graph on the full trace page. It never invents a step, a timing or
 * a reason the record does not hold, and it returns undefined for runs the
 * pipeline did not produce, so older runs keep their own views.
 */
import type { AskTraceDataV1 } from '../../api/client';

export type RunStepKind = 'read' | 'certified' | 'semantic' | 'relational' | 'ai_sql' | 'checks' | 'warehouse' | 'answer' | 'gap' | 'clarify' | 'failed' | 'conversation';
export type RunStepOutcome = 'done' | 'refused' | 'skipped' | 'failed' | 'not_reached';
export type RunEnding = 'answered' | 'gap' | 'clarify' | 'failed' | 'conversation';

export interface RunAiCall {
  label: string;
  ms?: number;
  promptChars?: number;
  reply?: string;
  outcome?: 'sql' | 'declined' | 'rejected' | 'error' | 'accepted' | 'revise';
  at?: number;
}

export interface RunCheck {
  label: string;
  passed: boolean;
  message: string;
  attempt?: number;
}

export interface RunStoryEntry {
  phase: string;
  title: string;
  state: 'done' | 'missed' | 'failed';
  detail?: string;
  ms?: number;
  at: number;
}

export interface RunStep {
  id: string;
  n: number;
  kind: RunStepKind;
  title: string;
  outcome: RunStepOutcome;
  ms?: number;
  reason: string;
  aiCalls: RunAiCall[];
  checks: RunCheck[];
  notes: string[];
  story: RunStoryEntry[];
  sql?: string;
  rows?: number;
}

export interface RunDataUsed {
  tables: string[];
  joins: string[];
  metrics: string[];
  dimensions: string[];
  certifiedBlock?: string;
  filters: string[];
  notes: string[];
  policies: string[];
}

export interface RunExplanation {
  ending: RunEnding;
  headline: string;
  totalMs?: number;
  steps: RunStep[];
  aiCalls: RunAiCall[];
  checks: RunCheck[];
  dataUsed: RunDataUsed;
  timings: { aiMs: number; warehouseMs?: number; contextMs?: number };
}

export interface ExplainAskRunInput {
  receipt: unknown;
  payload?: Record<string, unknown>;
  evaluations?: Array<{ id?: string; label?: string; passed?: boolean; message?: string }>;
  status?: string;
}

/** An outcome in the reader's words. */
export const OUTCOME_WORDS: Record<RunStepOutcome, string> = { done: 'Done', refused: 'Not used', skipped: 'Skipped', failed: 'Failed', not_reached: 'Not reached' };

/** A row-count range (a trace read by someone other than the asker) in words: "No rows", "1 row", "About 2-10 rows". */
export function rowCountWords(bucket: string): string {
  return bucket === 'none' ? 'No rows' : bucket === '1' ? '1 row' : `About ${bucket} rows`;
}

/** A duration for a step or call; nothing for an unmeasured or trivial one. */
export function formatRunMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 50) return '';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

/** The explanation of a pipeline trace (receipt plus the answer read from the saved run), or undefined for any other trace. */
export function explanationForTrace(trace: Pick<AskTraceDataV1, 'runtimeReceiptV9' | 'runtimeAnswerV1' | 'envelope'>): RunExplanation | undefined {
  if (!trace.runtimeReceiptV9) return undefined;
  const answer = trace.runtimeAnswerV1 ?? {};
  return explainAskRun({
    receipt: trace.runtimeReceiptV9,
    payload: answer as Record<string, unknown>,
    ...(answer.evaluations ? { evaluations: answer.evaluations } : {}),
    status: answer.status ?? (trace.envelope.status === 'completed' ? 'completed' : 'blocked'),
  });
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A receipt the Ask pipeline wrote. */
export function isAskPipelineReceipt(value: unknown): boolean {
  const receipt = rec(value);
  return Boolean(receipt && receipt.version === 1 && Array.isArray(receipt.dispatches) && Array.isArray(receipt.tiers));
}

/** Internal codes a reader must never see verbatim, with the sentence they stand for. */
export const REFUSAL_SENTENCES: Record<string, string> = {
  no_certified_block: 'No certified saved query matches this question.',
  block_not_applicable: 'A certified saved query exists, but it does not answer this question as asked.',
  block_unbound_parameters: 'A certified saved query matches, but it still needs parameter values.',
  not_semantic: 'The semantic layer has no metric or dimension for part of this question.',
  semantic_compile_failed: 'The semantic engine could not compile this question.',
  semantic_runtime_unavailable: 'No semantic layer is loaded for this project.',
  measure_scope_not_expressible: 'The semantic layer cannot restrict that measure the way the question asks.',
  not_relational: 'These tables cannot answer it the way the question asks.',
  relational_compose_failed: 'A query over these tables could not be composed.',
  join_path_required: 'No certified relationship joins the tables this needs.',
  join_requires_domain_contract: 'Joining these tables crosses a domain boundary.',
  relationship_domain_unknown: 'It is not known which domain owns one of these tables.',
  policy_denied: 'A project policy does not allow this question.',
  policy_filter_unbindable: 'A required filter could not be applied.',
  policy_conflict: 'The question contradicts a required filter.',
  exploration_not_opted_in: 'AI-written SQL is turned off for this project.',
  exploration_unavailable: 'No AI model is available to write SQL.',
  exploration_tables_unavailable: 'No tables could be read for this project, so the data was not checked.',
  exploration_declined: 'The AI looked at the tables and found nothing that answers this.',
  exploration_check_failed: 'The AI-written SQL failed a check, so it was not run.',
  exploration_failed: 'The AI could not write SQL for this question.',
  exploration_not_read_only: 'The AI-written SQL was not a single read-only statement, so it was not run.',
  semantic_engine_required: 'This metric can only be computed by the semantic engine.',
  execution_failed: 'The warehouse rejected the query.',
  no_rows_matched: 'The query ran, but no rows matched.',
  fanout_detected: 'A join would have counted rows more than once, so the query was not used.',
  filter_not_applied: 'The prepared query did not apply a restriction, so it was not used.',
};

const INTERNAL_CODE = /\b(?:exploration_not_opted_in|no_certified_block|semantic_runtime_unavailable|semantic_compile_failed|exploration_declined|exploration_check_failed|join_path_required|not_semantic|not_relational|block_not_applicable)\b|sha256:|\b(?:metric|measure|dimension|entity|column|relation|block|concept):[A-Za-z_]/;

/** Whether a sentence still carries an internal code (used by tests). */
export function containsInternalCode(text: string): boolean {
  return INTERNAL_CODE.test(text);
}

/** Refs and codes turned into words: `metric:orders.total_revenue` → "total revenue". */
export function plainRefs(text: string): string {
  return text
    // "jaffle_shop"."dev"."orders" reads as jaffle_shop.dev.orders.
    .replace(/"[A-Za-z0-9_$]+"(?:\."[A-Za-z0-9_$]+")+/g, (name) => name.replace(/"/g, ''))
    .replace(/\bsha256:[0-9a-f]+\b/gi, '')
    .replace(/\b(?:metric|measure|dimension|entity|column|relation|block|concept|term|skill|hint):([A-Za-z0-9_.@-]+)/g, (_match, ref: string) => ref.split('.').pop()!.replace(/_/g, ' '))
    .replace(/^(?:[a-z]+\/)?[a-z]+(?:_[a-z]+)+:\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A reason without the list of tables it searched: the step that searched shows that list once. */
function withoutSearchList(text: string): string {
  return text.replace(/\s*\((?:searched|tables searched)\b[^)]*\)/gi, '').replace(/\s{2,}/g, ' ').trim();
}

/** A reason cut to its point for a headline: first sentence, at most about 180 characters. */
export function briefly(text: string): string {
  const point = withoutSearchList(text);
  const sentence = point.match(/^.+?[.;](?=\s|$)/)?.[0] ?? point;
  return sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}…` : sentence;
}

/** A refusal as a sentence: the code's sentence, and the engine's own words when they add something. */
export function plainReason(code: string | undefined, message: string | undefined): string {
  const sentence = code ? REFUSAL_SENTENCES[code] : undefined;
  const words = message ? plainRefs(message).replace(/[.\s]+$/, '') : '';
  if (sentence && words && !/^no governed tier|^the project has no certified block$/i.test(words)) return `${sentence.replace(/\.$/, '')}: ${words}.`;
  if (sentence) return sentence;
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}.` : 'Not recorded.';
}

const CALL_LABELS: Record<string, string> = {
  read: 'Read the question',
  correct: 'Corrected its reading',
  reread: 'Read it again with what the tiers found',
  draft: 'Drafted SQL',
  redraft: 'Redrafted after a warehouse error',
  fix: 'Fixed a failed check',
  retry_empty: 'Redrafted after an empty result',
  widen: 'Looked again with more tables',
  review: 'Checked the result against the question',
  revise: 'Revised the SQL after the result check',
};

function aiCallOf(value: unknown): RunAiCall | undefined {
  const call = rec(value);
  const purpose = str(call?.purpose);
  if (!call || !purpose) return undefined;
  const label = str(call.label) ?? (purpose === 'intent:resolve' ? 'read' : purpose === 'intent:correct' ? 'correct' : purpose === 'intent:repair' ? 'reread' : purpose === 'intent:draft' ? 'draft' : purpose);
  const outcome = call.outcome === 'sql' || call.outcome === 'declined' || call.outcome === 'rejected' || call.outcome === 'error' || call.outcome === 'accepted' || call.outcome === 'revise' ? call.outcome : undefined;
  return {
    label: CALL_LABELS[label] ?? label.replace(/^intent:/, '').replace(/_/g, ' '),
    ...(num(call.ms) !== undefined ? { ms: num(call.ms) } : {}),
    ...(num(call.promptChars) !== undefined ? { promptChars: num(call.promptChars) } : {}),
    ...(str(call.reply) ? { reply: str(call.reply) } : {}),
    ...(outcome ? { outcome } : {}),
    ...(num(call.at) !== undefined ? { at: num(call.at) } : {}),
  };
}

function storyOf(value: unknown): RunStoryEntry | undefined {
  const entry = rec(value);
  if (!entry || typeof entry.title !== 'string' || typeof entry.at !== 'number') return undefined;
  return {
    phase: str(entry.phase) ?? 'step',
    title: entry.title,
    state: entry.state === 'missed' || entry.state === 'failed' ? entry.state : 'done',
    ...(str(entry.detail) ? { detail: str(entry.detail)!.slice(0, 2_000) } : {}),
    ...(num(entry.ms) !== undefined ? { ms: num(entry.ms) } : {}),
    at: entry.at,
  };
}

const TIER_TITLES: Record<string, string> = { certified: 'Certified saved queries', semantic: 'Semantic layer', relational: 'Governed tables' };
const WAREHOUSE_SENTENCES: Record<string, string> = {
  warehouse_suspended: 'The warehouse is not running.',
  relation_missing: 'The warehouse cannot see a table the query reads.',
  relation_denied: 'This connection is not allowed to read a table the query reads.',
  catalog_stale: 'The project lists a table the warehouse no longer has.',
  sql_error: 'The warehouse rejected the SQL.',
};
const SOURCE_WORDS: Record<string, string> = {
  certified: 'a certified saved query',
  semantic: 'the semantic layer',
  exploratory: 'SQL written by AI from the tables (review before relying on it)',
  relational: 'governed tables',
};

/** The explanation of one Ask pipeline run, or undefined when the run is not one. */
export function explainAskRun(input: ExplainAskRunInput): RunExplanation | undefined {
  if (!isAskPipelineReceipt(input.receipt)) return undefined;
  const receipt = input.receipt as Rec;
  const payload = input.payload ?? {};
  const intent = rec(receipt.intent);
  const timings = rec(receipt.timings) ?? {};
  const failure = rec(receipt.failure);
  const executed = rec(receipt.executed);
  const context = rec(receipt.context);
  const refusals = arr(receipt.refusals).map(rec).filter((item): item is Rec => Boolean(item));
  const tiers = arr(receipt.tiers).map(rec).filter((item): item is Rec => Boolean(item));
  const story = arr(receipt.story).map(storyOf).filter((entry): entry is RunStoryEntry => Boolean(entry));
  const calls = arr(receipt.dispatches).map((value) => ({ raw: rec(value), call: aiCallOf(value) })).filter((item): item is { raw: Rec; call: RunAiCall } => Boolean(item.raw && item.call));
  const readCalls = calls.filter(({ raw }) => /^intent:(resolve|correct|repair)$/.test(String(raw.purpose))).map(({ call }) => call);
  const draftCalls = calls.filter(({ raw }) => raw.purpose === 'intent:draft').map(({ call }) => call);
  // The drafting calls with the result check between them, in the order they ran.
  const sqlCalls = calls.filter(({ raw }) => raw.purpose === 'intent:draft' || raw.purpose === 'intent:review').map(({ call }) => call);
  const executedTier = str(executed?.tier);
  const gap = rec(payload.gap);

  const ending: RunEnding = intent?.kind === 'conversation' || intent?.kind === 'definition'
    ? 'conversation'
    : gap ? 'gap'
    : str(payload.executionError) || str(payload.failedStage) || (failure && !executed) ? 'failed'
    : executed && input.status !== 'blocked' ? 'answered'
    : input.status === 'needs_clarification' || payload.kind === 'clarify' ? 'clarify'
    : input.status === 'blocked' || input.status === 'failed' || !executed ? 'gap' : 'answered';

  const steps: RunStep[] = [];
  const push = (step: Omit<RunStep, 'n' | 'aiCalls' | 'checks' | 'notes' | 'story'> & Partial<Pick<RunStep, 'aiCalls' | 'checks' | 'notes' | 'story'>>) => {
    steps.push({ aiCalls: [], checks: [], notes: [], story: [], ...step, n: steps.length + 1 });
  };
  const refusalFor = (tier: string) => [...refusals].reverse().find((refusal) => refusal.tier === tier && refusal.code !== 'exploration_not_opted_in');
  const reading = str(receipt.reading) ?? str(intent?.reading);

  if (ending === 'conversation') {
    push({ id: 'conversation', kind: 'conversation', title: 'Replied without querying data', outcome: 'done', reason: plainRefs(reading ?? 'The message was not a question about data.'), aiCalls: readCalls });
  } else {
    // 1. Reading the question.
    const readFailed = failure?.stage === 'resolve';
    push({
      id: 'read', kind: 'read', title: 'Read the question', outcome: readFailed ? 'failed' : 'done',
      ...(num(timings.resolve) !== undefined ? { ms: num(timings.resolve) } : {}),
      reason: readFailed ? plainRefs(str(failure?.message) ?? 'The AI could not read the question.') : plainRefs(reading ?? 'Read the question.'),
      aiCalls: readCalls,
      story: story.filter((entry) => entry.phase === 'context' || entry.phase === 'read' || entry.phase === 'search'),
      notes: arr(receipt.grounding).map(str).filter((note): note is string => Boolean(note) && /^discovery:/.test(note!)).map((note) => plainRefs(note.replace(/^discovery:\s*/, ''))),
    });

    // 2. The governed tiers, last outcome per tier.
    const governedRounds = tiers.filter((entry) => [0, 1, 9, 99].includes(Number(entry.round)) && TIER_TITLES[String(entry.tier)]);
    const aiLaneActivity = draftCalls.length > 0 || tiers.some((entry) => Number(entry.round) === 97) || story.some((entry) => entry.phase === 'schema') || executedTier === 'exploratory';
    if (!readFailed) {
      if (governedRounds.length === 0 && aiLaneActivity) {
        push({ id: 'governed', kind: 'semantic', title: 'Certified saved queries and semantic layer', outcome: 'skipped', reason: 'The question is not about a certified saved query or a semantic metric, so the AI wrote the SQL.' });
      }
      // A question that named a retired block was answered from its replacement.
      const retiredNotes = story
        .filter((entry) => entry.phase === 'tier' && / was retired\b.*; answered from /.test(entry.title))
        .map((entry) => `${entry.title}.`);
      for (const tier of ['certified', 'semantic', 'relational']) {
        const attempts = governedRounds.filter((entry) => entry.tier === tier);
        if (attempts.length === 0) continue;
        const last = attempts[attempts.length - 1]!;
        const servedAsPublished = tier === 'certified' && attempts.some((entry) => Number(entry.round) === 99);
        const answeredHere = executedTier === tier;
        const outcome: RunStepOutcome = answeredHere || servedAsPublished || last.outcome === 'prepared' ? 'done' : last.outcome === 'skipped' ? 'skipped' : 'refused';
        const refusal = refusalFor(tier);
        const reason = outcome === 'done'
          ? servedAsPublished ? 'A certified saved query was served as published.' : tier === 'certified' ? 'A certified saved query answers this question.' : tier === 'semantic' ? 'The semantic layer compiled this question.' : 'These tables answer this question.'
          : outcome === 'skipped'
            ? refusal ? plainReason(str(refusal.code), str(refusal.message)) : tier === 'certified' ? 'No certified saved query matches this question.' : 'Not needed: an earlier tier answered.'
            : plainReason(str(refusal?.code), str(refusal?.message) ?? str(last.detail));
        push({
          id: `tier-${tier}`, kind: tier as RunStepKind, title: TIER_TITLES[tier]!, outcome, reason,
          notes: [
            ...(answeredHere ? retiredNotes : []),
            ...(attempts.some((entry) => Number(entry.round) === 9) ? ['Tried again after a query was not usable.'] : []),
          ],
          story: story.filter((entry) => entry.phase === 'tier' && entry.title.toLowerCase().includes(tier)),
        });
      }
    }

    // 3. AI-written SQL.
    const aiRefusal = [...refusals].reverse().find((refusal) => refusal.tier === 'exploratory');
    if (aiLaneActivity || aiRefusal?.code === 'exploration_not_opted_in' && ending !== 'answered') {
      const code = str(aiRefusal?.code);
      const outcome: RunStepOutcome = executedTier === 'exploratory' ? 'done'
        : code === 'exploration_not_opted_in' ? 'skipped'
        : code === 'exploration_declined' ? 'refused'
        : code ? 'failed' : draftCalls.length ? 'done' : 'not_reached';
      const tables = arr(context?.used && rec(context.used)?.relations).map(str).filter((name): name is string => Boolean(name)).map((name) => name.replace(/"/g, ''));
      const redrafts = draftCalls.length - 1;
      const drafting = (num(timings.schema_draft) ?? 0) + (num(timings.schema_redraft) ?? 0);
      push({
        id: 'ai-sql', kind: 'ai_sql', title: 'AI wrote SQL', outcome,
        ...(drafting ? { ms: drafting } : {}),
        reason: outcome === 'done'
          ? `Wrote one read-only statement${tables.length ? ` over ${tables.join(', ')}` : ''}${redrafts > 0 ? `, redrafted ${redrafts === 1 ? 'once' : `${redrafts} times`}` : ''}.`
          : plainReason(code, str(aiRefusal?.message)),
        aiCalls: sqlCalls,
        story: story.filter((entry) => entry.phase === 'schema'),
        ...(executedTier === 'exploratory' && str(payload.sql) ? { sql: str(payload.sql) } : {}),
      });
    }

    // 4. Checks.
    const recordedChecks: RunCheck[] = arr(receipt.checks).map(rec).filter((item): item is Rec => Boolean(item)).map((item) => ({
      label: str(item.label) ?? 'Check', passed: item.passed === true, message: plainRefs(str(item.message) ?? ''), ...(num(item.attempt) !== undefined ? { attempt: num(item.attempt) } : {}),
    }));
    const storyChecks: RunCheck[] = recordedChecks.length ? [] : story
      .filter((entry) => entry.phase === 'schema' && /^Checked the drafted SQL|failed a check/.test(entry.title))
      .map((entry) => ({ label: entry.state === 'failed' ? 'A check failed' : 'Checked the drafted SQL', passed: entry.state !== 'failed', message: plainRefs(entry.detail ?? entry.title) }));
    const governedChecks: RunCheck[] = executedTier && executedTier !== 'exploratory'
      ? (input.evaluations ?? []).filter((evaluation) => evaluation.id === 'pipeline-preparation' || String(evaluation.id ?? '').startsWith('pipeline-execution'))
        .map((evaluation) => ({ label: evaluation.id === 'pipeline-preparation' ? (evaluation.label ?? 'Prepared') : 'Proven before it ran', passed: evaluation.passed !== false, message: plainRefs(evaluation.message ?? '') }))
      : [];
    const checks = [...recordedChecks, ...storyChecks, ...governedChecks];
    if (checks.length > 0) {
      const lastAttempt = Math.max(...checks.map((check) => check.attempt ?? 0));
      const latest = checks.filter((check) => (check.attempt ?? 0) === lastAttempt);
      const failedNow = latest.filter((check) => !check.passed);
      const fixed = checks.filter((check) => !check.passed && (check.attempt ?? 0) < lastAttempt).length;
      push({
        id: 'checks', kind: 'checks', title: 'Checked before running', outcome: failedNow.length ? 'failed' : 'done',
        reason: failedNow.length ? `${failedNow.length} check${failedNow.length === 1 ? '' : 's'} failed: ${failedNow[0]!.message || failedNow[0]!.label}` : fixed ? `All checks passed after ${fixed} failed check${fixed === 1 ? ' was' : 's were'} fixed.` : `All ${latest.length} check${latest.length === 1 ? '' : 's'} passed.`,
        checks,
      });
    }

    // 5. The warehouse.
    const warehouse = rec(receipt.warehouse);
    const rowCount = num(executed?.rowCount);
    if (executed && ending !== 'failed') {
      const retried = (num(warehouse?.failures) ?? 0) > 0;
      push({
        id: 'warehouse', kind: 'warehouse', title: 'Ran on the warehouse', outcome: 'done',
        ...(num(executed.ms) !== undefined ? { ms: num(executed.ms) } : {}),
        reason: `${rowCount === undefined ? (str(executed.rowCountBucket) ? rowCountWords(str(executed.rowCountBucket)!) : 'Returned rows') : `${rowCount} row${rowCount === 1 ? '' : 's'}`}${retried ? ', after the warehouse rejected a first attempt' : ''}.`,
        ...(rowCount !== undefined ? { rows: rowCount } : {}),
        story: story.filter((entry) => entry.phase === 'execute'),
      });
    } else if (failure?.stage === 'execute') {
      const warehouseClass = str(rec(failure.warehouse)?.class);
      push({
        id: 'warehouse', kind: 'warehouse', title: 'Ran on the warehouse', outcome: 'failed',
        reason: `${warehouseClass ? WAREHOUSE_SENTENCES[warehouseClass] ?? 'The warehouse rejected the query.' : 'The warehouse rejected the query.'} ${plainRefs(str(failure.message) ?? '')}`.trim(),
        story: story.filter((entry) => entry.phase === 'execute'),
      });
    } else if (ending !== 'answered') {
      push({ id: 'warehouse', kind: 'warehouse', title: 'Ran on the warehouse', outcome: 'not_reached', reason: 'Nothing ran on the warehouse.' });
    }

    // 6. How it ended.
    if (ending === 'answered') {
      push({ id: 'answer', kind: 'answer', title: 'Answer', outcome: 'done', reason: `Answered from ${SOURCE_WORDS[executedTier ?? ''] ?? 'the data'}.` });
    } else if (ending === 'gap') {
      push({ id: 'gap', kind: 'gap', title: 'No answer', outcome: 'refused', reason: withoutSearchList(plainRefs(str(gap?.message) ?? str(payload.text) ?? 'Nothing in this project answers the question.')) });
    } else if (ending === 'clarify') {
      push({ id: 'clarify', kind: 'clarify', title: 'Asked which you meant', outcome: 'done', reason: plainRefs(str(payload.question) ?? str(payload.text) ?? str(payload.answer) ?? 'The question has more than one meaning.') });
    } else {
      const stage = str(payload.failedStage) ?? str(failure?.stage);
      const where = stage === 'resolve' ? 'reading the question' : stage === 'execute' ? 'running on the warehouse' : 'preparing the query';
      push({ id: 'failed', kind: 'failed', title: 'Stopped', outcome: 'failed', reason: `Stopped while ${where}. ${plainRefs(str(payload.executionError) ?? str(failure?.message) ?? '')}`.trim() });
    }
  }

  const contextMs = num(timings.context);
  const totalMs = num(timings.total) !== undefined ? num(timings.total)! + (contextMs ?? 0) : undefined;
  const aiMs = calls.reduce((sum, { call }) => sum + (call.ms ?? 0), 0);
  const end = steps[steps.length - 1]!;
  const headline = ending === 'answered' ? end.reason
    : ending === 'gap' ? `No answer: ${briefly(end.reason)}`
    : ending === 'clarify' ? `Asked which you meant: ${end.reason}`
    : ending === 'failed' ? end.reason
    : 'Replied without querying data.';

  return {
    ending,
    headline,
    ...(totalMs !== undefined ? { totalMs } : {}),
    steps,
    aiCalls: calls.map(({ call }) => call),
    checks: steps.flatMap((step) => step.checks),
    dataUsed: dataUsedOf(receipt, payload),
    timings: { aiMs, ...(num(executed?.ms) !== undefined ? { warehouseMs: num(executed?.ms) } : {}), ...(contextMs !== undefined ? { contextMs } : {}) },
  };
}

/**
 * One join in plain words. An AI-written join names its tables, keys and the
 * Modeling relationship it followed ("orders → customers on customer_id =
 * customer_id (certified relationship orders_to_customers)"); a governed join
 * keeps the identifier-only form it has always had.
 */
export function describeJoin(join: Rec): string {
  const authority = str(join.authority) ?? '';
  const named = str(join.name) ?? (str(join.relationshipId) ? plainRefs(str(join.relationshipId)!) : undefined);
  const relations = arr(join.relations).map(str).filter((name): name is string => Boolean(name)).map((name) => name.replace(/"/g, ''));
  if (relations.length === 2) {
    const keys = arr(join.keys).map(rec).filter((key): key is Rec => Boolean(key)).map((key) => `${str(key.from)} = ${str(key.to)}`);
    const how = authority === 'certified' ? `certified relationship ${named}`
      : authority === 'validated' ? `validated relationship ${named}`
        : authority === 'stale' ? `relationship ${named}, certification needs a recheck`
          : authority === 'draft' ? `draft relationship ${named}`
            : named ? `written by AI, not on the keys of relationship ${named}` : 'written by AI; no relationship declared';
    return `${relations.join(' → ')}${keys.length ? ` on ${keys.join(' and ')}` : ''} (${how})`;
  }
  // The ledger keeps identifiers only: which relationship, and whose authority joined it.
  const name = plainRefs(str(join.relationshipId) ?? str(join.source) ?? 'a join');
  const how = /certified|domain/.test(authority) ? 'certified relationship' : /semantic/.test(`${authority} ${str(join.source)}`) ? 'semantic layer' : 'written by AI';
  return `${name} (${how})`;
}

function dataUsedOf(receipt: Rec, payload: Rec): RunDataUsed {
  const context = rec(receipt.context);
  const used = rec(context?.used);
  // Only the tables the answer read. The admitted bindings are every table the
  // question could have read, which is not what this answer used.
  const tables = [...new Set(arr(used?.relations).map(str).filter((name): name is string => Boolean(name)).map((name) => name.replace(/"/g, '')))];
  const joins = arr(used?.joins).map(rec).filter((join): join is Rec => Boolean(join)).map(describeJoin);
  const dql = rec(payload.dqlArtifact);
  const proofs = [...arr(payload.proof), ...arr(rec(receipt.executed)?.proofs)].map(str).filter((line): line is string => Boolean(line));
  const filters = proofs.filter((line) => /^applied on the data: /.test(line)).map((line) => line.replace(/^applied on the data: /, ''));
  const notes = arr(receipt.grounding).map(str).filter((note): note is string => Boolean(note) && !/^discovery:/.test(note!))
    .map((note) => plainRefs(note.replace(/^(identity|period|relationship|member|policy):\s*/, '')));
  const enforced = rec(context?.enforced);
  const policies = [
    ...arr(enforced?.requiredFilters).map((item) => str(item) ?? str(rec(item)?.text)).filter((text): text is string => Boolean(text)).map((text) => `Required filter: ${plainRefs(text)}`),
    ...arr(receipt.policies).map(rec).filter((item): item is Rec => Boolean(item)).map((item) => `${plainRefs(str(item.policyId) ?? 'A policy')} ${str(item.effect)?.replace(/_/g, ' ') ?? 'applied'}${str(item.field) ? ` on ${plainRefs(str(item.field)!)}` : ''}`),
  ];
  return {
    tables,
    joins,
    metrics: arr(dql?.metrics).map(str).filter((name): name is string => Boolean(name)),
    dimensions: arr(dql?.dimensions).map(str).filter((name): name is string => Boolean(name)),
    ...(str(payload.certifiedBlockRef) ? { certifiedBlock: plainRefs(str(payload.certifiedBlockRef)!) } : {}),
    filters: [...new Set(filters)],
    notes: [...new Set(notes)],
    policies: [...new Set(policies)],
  };
}
