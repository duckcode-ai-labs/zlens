/**
 * THE STEPS OF ONE AGENT RUN, IN PLAIN WORDS, WITH WHERE THE TIME WENT.
 *
 * Pure helpers for the steps page ("How it was answered" outside Ask). Each
 * row is one thing the run did, named in the reader's words; the time beside
 * it is the time since the row before, which is where the wall-clock went.
 * Steps that repeat one after another fold into one row with a count, and
 * the pipeline's own stage timers (`resolve 81000 ms`) are not steps: their
 * time goes to the next row a reader can name.
 */
import type { AgentRun, AgentRunEvent } from '../../api/client';
import type { MainView } from '../../store/types';
import { plainRefs, withoutConfigHints, type RunExplanation, type RunStep } from './ask-run-explanation';

export interface AgentStepRow {
  key: string;
  label: string;
  detail?: string;
  /** Time since the previous row; the sum for a folded row. */
  ms: number;
  /** How many steps this row stands for (more than 1 when repeated steps were folded). */
  count: number;
  /** The longest single step inside a folded row. */
  longestMs: number;
  state: 'done' | 'missed' | 'failed';
  /** A tool call rather than a step of the run itself. */
  tool: boolean;
}

/** Where "Back" goes, named by the view the page was opened from. */
const BACK_LABELS: Partial<Record<MainView, string>> = {
  notebook: 'Back to the notebook',
  ask: 'Back to Ask AI',
  apps: 'Back to Apps',
  block_studio: 'Back to the saved query',
  home: 'Back to Home',
};

export function agentStepsBackLabel(view: MainView | undefined): string {
  return (view && BACK_LABELS[view]) ?? 'Back';
}

/** What a route means for the reader: how ZLens chose to answer. */
const ROUTE_WORDS: Partial<Record<AgentRun['route'], string>> = {
  certified_answer: 'A certified saved query',
  semantic_answer: 'The project’s metrics',
  generated_answer: 'Certified saved queries first, then metrics, then SQL written by AI',
  research: 'Research across several queries',
  sql_cell: 'Write a query',
  dql_block_draft: 'Draft a saved query',
  modeling_draft: 'Draft modeling changes',
  skill_draft: 'Draft Skill guidance',
  app_build: 'Build an App',
  conversation: 'Reply without querying data',
  clarify: 'Ask which you meant',
};

export function routeWords(route: AgentRun['route'] | undefined): string | undefined {
  return route ? ROUTE_WORDS[route] : undefined;
}

/** What a run is doing while its executor works, when the event names nothing more. */
const WORKING_WORDS: Partial<Record<AgentRun['route'], string>> = {
  certified_answer: 'Looking for a certified saved query or metric',
  semantic_answer: 'Working out the answer from the metrics',
  generated_answer: 'Working on the answer',
  research: 'Researching',
  app_build: 'Building the App',
  sql_cell: 'Writing the query',
  dql_block_draft: 'Drafting the saved query',
  modeling_draft: 'Drafting modeling changes',
  skill_draft: 'Drafting Skill guidance',
  conversation: 'Replying',
};

/** A route's reason that is the same sentence for every Ask run says nothing about this one. */
export function isGenericRouteReason(reason: string | undefined): boolean {
  return !reason || /^Ask pipeline:/i.test(reason.trim());
}

/** A stage timer the pipeline emits as it finishes a stage: `resolve 81000 ms`, `ground 12 ms`. */
function isStageTimer(message: string): boolean {
  return /^[a-z][a-z0-9_:]*(?: \d+ ms)?$/.test(message.trim());
}

/** The words the old page used for every step of an answer; no reader can tell them apart. */
const MESSAGE_WORDS: Array<[RegExp, string | null]> = [
  // The engine's own bookkeeping as the executor starts: its time goes to the next row.
  [/^Running [a-z ]+ executor\.?$/i, null],
  [/^Re-running [a-z ]+ executor \(repair attempt \d+\)\.?$/i, 'Fixed the query and tried again'],
  [/^Assembling the governed context\b/i, null],
  [/^Context assembled in\b/i, 'Gathered the project’s tables, fields and metrics'],
  [/^Reading the question as an edit of the previous analysis\b/i, 'Started reading the question as a follow-up'],
  [/^Reading the question against\b/i, 'Started reading the question'],
];

/** The generic run-failed message carries no reason; the reason sits at the top of the page. */
const GENERIC_FAILURE = /^Agent run (?:failed|stopped)\b/i;

interface StepLike { title?: unknown; detail?: unknown; state?: unknown }

function askStepOf(event: AgentRunEvent): StepLike | undefined {
  const step = (event.payload as { askStep?: unknown } | undefined)?.askStep;
  return step && typeof step === 'object' && typeof (step as StepLike).title === 'string' ? step as StepLike : undefined;
}

function sentence(text: string, max = 160): string {
  const plain = plainRefs(text).replace(/[.\s]+$/, '');
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** One event as a row a reader can name, or null for an event that is not a step of its own. */
export function agentStepLabel(event: AgentRunEvent, question?: string): Pick<AgentStepRow, 'label' | 'detail' | 'state'> | null {
  const step = askStepOf(event);
  if (step) {
    const detail = typeof step.detail === 'string' ? withoutConfigHints(step.detail) : undefined;
    return {
      label: withoutConfigHints(String(step.title)),
      // SQL has its own place in "How it was answered"; a row keeps to words.
      ...(detail && !/^\s*(?:select|with)\b/i.test(detail) ? { detail: sentence(detail, 300) } : {}),
      state: step.state === 'missed' || step.state === 'failed' ? step.state : 'done',
    };
  }
  const message = typeof event.message === 'string' ? event.message.trim() : '';
  switch (event.type) {
    case 'run.started': return { label: 'Started', state: 'done' };
    case 'route.decided': {
      const how = routeWords(event.route);
      return { label: 'Chose how to answer', ...(how ? { detail: how } : {}), state: 'done' };
    }
    case 'plan.created': return { label: 'Planned the approach', state: 'done' };
    case 'step.started': {
      const goal = (event.payload as { goal?: unknown } | undefined)?.goal;
      if (typeof goal !== 'string' || !goal.trim() || goal.trim() === question?.trim()) return null;
      return { label: `Working on: ${sentence(goal, 80)}`, state: 'done' };
    }
    case 'executor.started': {
      if (!message) return { label: WORKING_WORDS[event.route ?? 'generated_answer'] ?? 'Working on the answer', state: 'done' };
      if (isStageTimer(message)) return null;
      for (const [pattern, words] of MESSAGE_WORDS) {
        if (pattern.test(message)) return words ? { label: words, state: 'done' } : null;
      }
      return { label: sentence(message), state: 'done' };
    }
    case 'evaluation.recorded': return { label: 'Ran the checks', state: 'done' };
    case 'repair.attempted': return { label: 'Fixed the query and tried again', state: 'done' };
    case 'replan.decided': return { label: 'Changed the approach', state: 'done' };
    case 'escalated': return { label: 'Tried a deeper approach', state: 'done' };
    case 'artifact.created': return { label: 'Produced the answer', state: 'done' };
    case 'step.completed': return null;
    case 'run.completed': return { label: 'Done', state: 'done' };
    case 'run.cancelled': return { label: 'Stopped by you', state: 'failed' };
    case 'run.failed': return { label: 'Stopped', ...(message && !GENERIC_FAILURE.test(message) ? { detail: sentence(message, 300) } : {}), state: 'failed' };
    default: return null;
  }
}

function toolOf(event: AgentRunEvent): string | undefined {
  const tool = (event.payload as { tool?: unknown } | undefined)?.tool;
  return typeof tool === 'string' && tool.trim() ? tool : undefined;
}

function timeOf(at: string | undefined): number | undefined {
  if (!at) return undefined;
  const value = Date.parse(at);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * The run's rows in order. The time of an event that is not a step of its own
 * (a stage timer, a bookkeeping event) goes to the next row, so no time is
 * lost and none is shown twice; repeated rows in a row fold into one.
 */
export function buildAgentStepRows(run: Pick<AgentRun, 'events' | 'startedAt' | 'question'>): AgentStepRow[] {
  const events = [...run.events].sort((a, b) => a.at.localeCompare(b.at));
  const rows: AgentStepRow[] = [];
  let previous = timeOf(run.startedAt) ?? timeOf(events[0]?.at);
  for (const event of events) {
    const tool = toolOf(event);
    const named = tool ? { label: `Used ${tool.replace(/[_.]+/g, ' ')}`, state: 'done' as const } : agentStepLabel(event, run.question);
    if (!named) continue;
    const at = timeOf(event.at);
    const ms = at !== undefined && previous !== undefined ? Math.max(0, at - previous) : 0;
    if (at !== undefined) previous = at;
    rows.push({ key: event.id, ...named, ms, count: 1, longestMs: ms, tool: Boolean(tool) });
  }
  return foldRepeatedRows(rows);
}

/** Rows that say the same thing one after another, as one row with a count and their total time. */
export function foldRepeatedRows(rows: AgentStepRow[]): AgentStepRow[] {
  const folded: AgentStepRow[] = [];
  for (const row of rows) {
    const last = folded[folded.length - 1];
    if (last && last.label === row.label && last.detail === row.detail && last.state === row.state && last.tool === row.tool) {
      folded[folded.length - 1] = { ...last, ms: last.ms + row.ms, count: last.count + 1, longestMs: Math.max(last.longestMs, row.ms) };
    } else {
      folded.push(row);
    }
  }
  return folded;
}

/** A duration in the same words "How it was answered" uses. */
export function formatStepMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1) return '';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

/**
 * The steps that explain the stop, in order: the steps that failed (the
 * closing "Stopped" step only when no earlier one did), else the last
 * sources that could not answer.
 */
export function stoppingSteps(explanation: Pick<RunExplanation, 'steps'> | undefined): RunStep[] {
  if (!explanation) return [];
  const failed = explanation.steps.filter((step) => step.outcome === 'failed');
  const specific = failed.filter((step) => step.kind !== 'failed');
  if (failed.length) return (specific.length ? specific : failed).slice(0, 3);
  return explanation.steps.filter((step) => step.outcome === 'refused' && step.kind !== 'gap').slice(-2);
}
