import type { AnswerRefusalCode } from '../answer-loop.js';

/**
 * THE writer of terminal sentences.
 *
 * Nine places used to write the sentence a reader sees when a question does
 * not end in a result — the engine's refusal-code table, its incident switch,
 * its last-resort answer, the lane's no-answer branches, the floor's refusal,
 * the CLI's headline — and they drifted: one said "snapshot", one said
 * "dispatch", one said "orchestration budget". Every producer now describes
 * its outcome as a typed SHAPE and this module turns the shape into words.
 * The internal reason codes stay for traces; the number of user sentences is
 * bounded by the shapes below, not by how many code paths exist.
 *
 * House rule for every sentence: say what happened to the QUESTION, name what
 * IS available when we know it, never name the machinery.
 */

export type TerminalIncidentCode =
  | 'CONNECTION_NOT_CONFIGURED'
  | 'PROVIDER_FAILURE'
  | 'COMPILATION_FAILED'
  | 'RESULT_CONTRACT_MISMATCH'
  | 'ANALYTICAL_COVERAGE_GAP'
  | 'ANALYTICAL_EXECUTION_FAILED'
  | 'RUN_TIMEOUT'
  | 'CANCELLED';

export type HostFloorRefusalReason = 'no measure' | 'filter' | 'time' | 'unbound' | `qualifier ${string}`;

export type TerminalAnswerShape =
  /** The coarse refusal a run recorded, when nothing more specific is known. */
  | { kind: 'refusal'; refusalCode: AnswerRefusalCode | undefined }
  /** A terminal incident the engine classified. */
  | { kind: 'incident'; code: TerminalIncidentCode | undefined; assets?: string[]; unmodeled?: { term: string; modeled: string[] } }
  /** The turn never reached a query: the assistant step failed or the room ran out. */
  | { kind: 'last_resort'; cause: 'provider' | 'budget'; assets: string[] }
  /** The analyst inspected the executable tiers and declined the exploratory one. */
  | { kind: 'remaining_tiers_declined' }
  /** A V2 lane terminal without a result. */
  | {
    kind: 'v2_no_answer';
    outcome: 'provider_failure' | 'execution_failure' | 'gap' | 'budget_exhausted' | 'denied' | 'clarification' | 'finish_answer';
    reasonCode: string;
    modelingGap?: { term: string; admitted: string[] };
  }
  /** The host floor could not bind the question to admitted columns. */
  | { kind: 'host_floor_refusal'; reason: HostFloorRefusalReason; asked?: string; admitted: string[] }
  /** A term the whole catalog does not mention. */
  | { kind: 'unmodeled_term'; term: string; modeled: string[] };

export interface ComposedAnswer {
  /** The headline a card shows first. */
  title: string;
  /** The sentence(s) the reader gets. */
  text: string;
}

const REFUSAL_TITLES: Record<AnswerRefusalCode, string> = {
  policy_blocked: 'Blocked by a governance policy',
  modeling_gap: 'Not modeled yet',
  no_data: 'No matching data',
  grounding_gap: 'Not enough context to answer safely',
  model_declined: 'The assistant declined to answer',
  provider_error: 'Could not finish working this one out',
  orchestration_budget_exhausted: 'ZLens stopped at its own orchestration budget',
  execution_error: 'The selected query did not complete on the current connection',
  ambiguous: 'Needs one detail before running',
};

const REFUSAL_TEXT: Record<AnswerRefusalCode, string> = {
  grounding_gap: 'ZLens could not match every part of this question to governed data, so no query was run.',
  modeling_gap: 'Part of this question is not modeled in this project yet, so no governed query can answer it as asked.',
  no_data: 'The governed query ran and no rows matched the requested period or filter, so there is nothing to report for it.',
  ambiguous: 'One business choice is required before ZLens can run this question.',
  provider_error: 'This question was not worked out to a query, so nothing about the data has been ruled out.',
  orchestration_budget_exhausted: 'ZLens stopped this run at its own orchestration budget before the question was settled.',
  policy_blocked: 'A governance policy blocked this request before execution.',
  execution_error: 'The selected governed query did not complete on the current connection.',
  model_declined: 'The assistant declined to answer this question.',
};

const DEFAULT_TITLE = 'No answer was produced';

function lastResort(cause: 'provider' | 'budget', assets: string[]): string {
  const opening = cause === 'provider'
    ? 'I could not finish working this question out — the assistant step did not complete, so no query was run.'
    : 'I ran out of room to work this question out before a query was accepted.';
  const closing = 'Nothing about your data has been ruled out: this run did not reach a query.'
    + ' Asking again usually works, and naming the exact field or metric you want makes it certain.';
  return assets.length > 0
    ? `${opening} What I had found so far for it: ${assets.slice(0, 6).join(', ')}. ${closing}`
    : `${opening} ${closing}`;
}

function unmodeledTerm(term: string, modeled: string[]): string {
  const alternatives = modeled.filter((label) => !/^\d/.test(label)).slice(0, 5);
  return `"${term}" is not modeled in this project, so no governed query can answer it.`
    + (alternatives.length
      ? ` The fields that are modeled here include ${alternatives.join(', ')}.`
        + ' Ask again using one of those, or tell me which should stand in for'
        + ` "${term}".`
      : '');
}

const REMAINING_TIERS_DECLINED = 'No certified saved query or semantic metric covers this question, and the analyst declined to run unverified exploratory SQL. No query was executed. Use Research for a deeper investigation, certify a saved query for this question, or name the exact model/columns to query.';

function incident(shape: Extract<TerminalAnswerShape, { kind: 'incident' }>): string {
  switch (shape.code) {
    case 'CONNECTION_NOT_CONFIGURED':
      return 'No database connection is configured yet. Add an approved connection, then retry this question.';
    case 'PROVIDER_FAILURE':
      return lastResort('provider', shape.assets ?? []);
    case 'COMPILATION_FAILED':
      return 'DQL selected a governed plan but could not compile it for the current target. Review the semantic target, then retry.';
    case 'RESULT_CONTRACT_MISMATCH':
      return 'The query ran, but its result did not match the frozen plan. Review the result contract and trace, then retry.';
    case 'ANALYTICAL_COVERAGE_GAP':
      return shape.unmodeled
        ? unmodeledTerm(shape.unmodeled.term, shape.unmodeled.modeled)
        : 'ZLens could not prove one safe analytical path from the governed data it holds. Review the available modeled fields, then retry.';
    case 'ANALYTICAL_EXECUTION_FAILED':
      return 'The selected governed query did not complete on the current connection. Review the connection and trace, then retry.';
    case 'RUN_TIMEOUT':
      return 'This Ask run reached its time limit before it finished; the trace says which phase it was in. Retry the same question, or use Research for a longer budget.';
    case 'CANCELLED':
      return 'This Ask run was cancelled before it completed.';
    default:
      return 'No executable data answer was accepted for this Ask run.';
  }
}

function v2NoAnswer(shape: Extract<TerminalAnswerShape, { kind: 'v2_no_answer' }>): string {
  const { outcome, reasonCode, modelingGap } = shape;
  if (reasonCode === 'SEMANTIC_ENGINE_UNAVAILABLE') {
    return 'The configured semantic runtime is not ready for the selected metric. Review semantic adapter readiness, then retry.';
  }
  if (reasonCode === 'SEMANTIC_EXECUTION_TARGET_MISMATCH') {
    return 'ZLens stopped before execution because the compiled semantic query did not match the frozen execution target. Review the execution target and trace; no query was run.';
  }
  if (outcome === 'budget_exhausted' && reasonCode === 'ASK_PROVIDER_DISPATCH_BUDGET_EXHAUSTED') {
    return lastResort('budget', []);
  }
  if (outcome === 'provider_failure') return REFUSAL_TEXT.provider_error;
  if (outcome === 'execution_failure') {
    return reasonCode === 'SEMANTIC_FILTER_NOT_COMPILED'
      ? 'The governed semantic engine could not apply the required member filter, and ZLens refused to run the unfiltered query in its place. Ask through a certified saved query or governed SQL, or enable the MetricFlow runtime for cross-model filters.'
      : REFUSAL_TEXT.execution_error;
  }
  if (modelingGap) {
    return `"${modelingGap.term}" is not modeled in this project's governed data, so no query can compute it.${modelingGap.admitted.length ? ` Governed groupings available: ${modelingGap.admitted.join(', ')}.` : ''} Ask with one of those instead, or model "${modelingGap.term}" and re-sync.`;
  }
  if (reasonCode === 'ASK_V2_REMAINING_TIERS_DECLINED') return REMAINING_TIERS_DECLINED;
  return 'ZLens could not complete a safe analytical path from the governed data it holds.';
}

function hostFloorRefusal(shape: Extract<TerminalAnswerShape, { kind: 'host_floor_refusal' }>): string {
  const because = shape.reason === 'filter'
    ? 'it needs a filter that no governed query here can prove'
    : shape.reason === 'time'
      ? 'it needs a time window that no governed query here expresses'
      : shape.reason.startsWith('qualifier ')
        ? `"${shape.reason.slice('qualifier '.length)}" narrows the measure in a way nothing here models`
        : shape.reason === 'no measure'
          ? 'it does not name a measure this project can compute'
          : shape.asked
            ? `"${shape.asked}" does not bind to exactly one column of the models retrieved for it`
            : 'nothing retrieved for it binds exactly';
  return `No governed query was run for this question because ${because}.${shape.admitted.length ? ` Measures available: ${shape.admitted.join('; ')}.` : ''} Name the measure and the model to use, or model it and re-sync.`;
}

/** The one place a terminal shape becomes the words a reader sees. */
export function composeAnswer(shape: TerminalAnswerShape): ComposedAnswer {
  switch (shape.kind) {
    case 'refusal':
      return {
        title: shape.refusalCode ? REFUSAL_TITLES[shape.refusalCode] : DEFAULT_TITLE,
        text: shape.refusalCode ? REFUSAL_TEXT[shape.refusalCode] : 'No executable data answer was accepted for this Ask run.',
      };
    case 'incident':
      return { title: incidentTitle(shape.code), text: incident(shape) };
    case 'last_resort':
      return { title: REFUSAL_TITLES[shape.cause === 'provider' ? 'provider_error' : 'orchestration_budget_exhausted'], text: lastResort(shape.cause, shape.assets) };
    case 'remaining_tiers_declined':
      return { title: REFUSAL_TITLES.grounding_gap, text: REMAINING_TIERS_DECLINED };
    case 'v2_no_answer':
      return { title: v2Title(shape), text: v2NoAnswer(shape) };
    case 'host_floor_refusal':
      return { title: REFUSAL_TITLES.grounding_gap, text: hostFloorRefusal(shape) };
    case 'unmodeled_term':
      return { title: REFUSAL_TITLES.modeling_gap, text: unmodeledTerm(shape.term, shape.modeled) };
    default:
      return { title: DEFAULT_TITLE, text: 'No executable data answer was accepted for this Ask run.' };
  }
}

function incidentTitle(code: TerminalIncidentCode | undefined): string {
  switch (code) {
    case 'CONNECTION_NOT_CONFIGURED': return 'No database connection is configured';
    case 'PROVIDER_FAILURE': return REFUSAL_TITLES.provider_error;
    case 'COMPILATION_FAILED': return 'ZLens could not compile the frozen plan';
    case 'RESULT_CONTRACT_MISMATCH': return 'The query result did not match the frozen plan';
    case 'ANALYTICAL_COVERAGE_GAP': return REFUSAL_TITLES.modeling_gap;
    case 'ANALYTICAL_EXECUTION_FAILED': return REFUSAL_TITLES.execution_error;
    case 'RUN_TIMEOUT': return 'The run reached its time limit';
    case 'CANCELLED': return 'Cancelled';
    default: return DEFAULT_TITLE;
  }
}

function v2Title(shape: Extract<TerminalAnswerShape, { kind: 'v2_no_answer' }>): string {
  if (shape.outcome === 'provider_failure') return REFUSAL_TITLES.provider_error;
  if (shape.outcome === 'execution_failure') return REFUSAL_TITLES.execution_error;
  if (shape.outcome === 'budget_exhausted') return REFUSAL_TITLES.orchestration_budget_exhausted;
  if (shape.modelingGap) return REFUSAL_TITLES.modeling_gap;
  return REFUSAL_TITLES.grounding_gap;
}

/**
 * The headline for a terminal answer, from the same table the text comes
 * from. A precise failure phase or a recorded deadline detail wins over the
 * coarse code: the switch alone cannot tell DQL declining to start a call
 * from a clock that ran out, and titling both as a provider outage sent
 * readers to debug the wrong system.
 */
export function terminalTitle(input: {
  refusalCode?: AnswerRefusalCode;
  failurePhase?: 'compilation' | 'validation' | 'result_validation' | string;
  detailCode?: string;
}): string {
  if (input.failurePhase === 'compilation') return 'ZLens could not compile the frozen plan';
  if (input.failurePhase === 'validation') return 'The selected governed inputs need correction';
  if (input.failurePhase === 'result_validation') return 'The query result did not match the frozen plan';
  if (input.detailCode === 'RUN_DEADLINE_INSUFFICIENT') return 'ZLens stopped before starting another AI call';
  return input.refusalCode ? REFUSAL_TITLES[input.refusalCode] : DEFAULT_TITLE;
}
