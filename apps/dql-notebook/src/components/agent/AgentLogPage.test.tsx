import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRun } from '../../api/client';
import { useNotebookStore, withoutStaleAgentLog } from '../../store/NotebookStore';
import type { NotebookFile, NotebookState } from '../../store/types';
import { themes } from '../../themes/notebook-theme';
import { AgentStepsView } from './AgentLogPage';
import { explainAskRun, type RunExplanation } from './ask-run-explanation';
import { askBlockedHeading, askRunNoAnswer } from './UnifiedAgentRunPanel';

const T0 = Date.parse('2026-11-10T20:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const QUESTION = 'How many playoff games did the Golden State Warriors win in 2015?';
const BLOCKED_ANSWER = 'No query was run: Ask could not match this question to the project’s fields, and the AI could not write SQL for it; rephrase it, or ask it in a new chat.';

/** The V11 tester's PO-2, asked in a notebook's AI chat and blocked. */
const receipt = {
  version: 1,
  reading: 'Playoff games the Golden State Warriors won in 2015.',
  intent: { kind: 'analytics', reading: 'Playoff games the Golden State Warriors won in 2015.', unresolved: [] },
  dispatches: [
    { purpose: 'intent:resolve', ms: 81_000, promptChars: 22_000, label: 'read', attempt: 1, at: 1 },
    { purpose: 'intent:correct', ms: 61_000, promptChars: 22_000, label: 'correct', attempt: 2, at: 2 },
  ],
  tiers: [],
  refusals: [],
  story: [{ phase: 'search', title: 'Did not look for "Warriors" in stored values', state: 'missed', detail: 'no text column of these tables is allowlisted for value search (agent.runtimeValueGrounding.searchSafeColumns); the AI chooses the field from names and descriptions', at: T0 + 143_120 }],
  failure: { stage: 'resolve', message: 'GAME TYPE is not in the vocabulary; TEAM NAME is not in the vocabulary' },
  timings: { resolve: 142_000, total: 143_300 },
};

function blockedRun(): AgentRun {
  const event = (ms: number, type: string, message: string, extra: Record<string, unknown> = {}) => ({ id: `e${ms}`, runId: 'run-po2', type, at: at(ms), message, ...extra });
  return {
    id: 'run-po2',
    question: QUESTION,
    route: 'generated_answer',
    status: 'blocked',
    trustState: 'blocked',
    startedAt: at(0),
    completedAt: at(143_300),
    answer: BLOCKED_ANSWER,
    summary: 'Agent run failed with a blocked outcome.',
    artifacts: [{ id: 'a1', kind: 'answer', title: 'No answer', trustState: 'blocked', payload: { kind: 'gap', askPipeline: receipt } }],
    evaluations: [],
    nextActions: [],
    diagnosticReceiptV9: receipt,
    routeDecision: { reason: 'Ask pipeline: the interpreter resolves the intent and the host prepares every governed tier.' },
    events: [
      event(0, 'run.started', 'Agent run started.'),
      event(2, 'route.decided', 'Routed.', { route: 'generated_answer' }),
      ...Array.from({ length: 15 }, (_, index) => event(1_000 + index * 9_000, 'executor.started', '', { route: 'generated_answer' })),
      event(143_300, 'run.failed', 'Agent run failed with a blocked outcome.'),
    ],
  } as unknown as AgentRun;
}

const notebook: NotebookFile = { name: 'v8_warriors_seasons_check', path: 'notebooks/v8_warriors_seasons_check.dqlnb', type: 'notebook', folder: 'notebooks' };
const initial = useNotebookStore.getState();
const page = (state: Pick<NotebookState, 'agentLogRun' | 'agentLogFromView'>) => renderToStaticMarkup(
  <AgentStepsView run={state.agentLogRun} fromView={state.agentLogFromView} t={themes.light} onBack={() => undefined} />,
);

afterEach(() => {
  useNotebookStore.setState(initial, true);
});

describe('"How it was answered" from a notebook AI chat (V11 tester, PO-2)', () => {
  it('opens over the notebook and goes back to it, leaving the notebook as it was', () => {
    useNotebookStore.setState({ mainView: 'notebook', activeFile: notebook });
    const run = blockedRun();
    useNotebookStore.getState().dispatch({ type: 'OPEN_AGENT_LOG', run });
    expect(useNotebookStore.getState()).toMatchObject({ mainView: 'notebook', agentLogRun: run, agentLogFromView: 'notebook', activeFile: notebook });

    const html = page(useNotebookStore.getState());
    expect(html).toContain('Back to the notebook');
    expect(html).not.toContain('Back to Ask AI');

    useNotebookStore.getState().dispatch({ type: 'CLOSE_AGENT_LOG' });
    expect(useNotebookStore.getState()).toMatchObject({ mainView: 'notebook', agentLogRun: undefined, activeFile: notebook });
  });

  it('leads with the reason, in the same words as the chat card, then where it stopped', () => {
    const run = blockedRun();
    const html = page({ agentLogRun: run, agentLogFromView: 'notebook' });
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

    // The card's heading and sentence, before any step.
    const noAnswer = askRunNoAnswer(run)!;
    expect(noAnswer).toEqual({ kind: 'blocked', heading: askBlockedHeading(run), text: BLOCKED_ANSWER });
    const why = text.indexOf('Why there is no answer');
    expect(why).toBeGreaterThan(-1);
    expect(text.indexOf(noAnswer.heading)).toBeGreaterThan(why);
    expect(text.indexOf(BLOCKED_ANSWER)).toBeGreaterThan(why);
    expect(why).toBeLessThan(text.indexOf('Step by step'));
    expect(why).toBeLessThan(text.indexOf('Where the time went'));

    // The step that failed, with the reason the run recorded: what the Ask page's panel shows.
    const explanation = explainAskRun({ receipt, payload: { kind: 'gap', askPipeline: receipt }, status: 'blocked' }) as RunExplanation;
    const read = explanation.steps.find((step) => step.kind === 'read')!;
    expect(read.outcome).toBe('failed');
    expect(text).toContain(`Where it stopped ${read.title}: ${read.reason}`);
  });

  it('shows plain labels, one row for the repeated steps, and no config keys or route jargon', () => {
    const html = page({ agentLogRun: blockedRun(), agentLogFromView: 'notebook' });
    expect(html).not.toMatch(/semantic compile|Composing the answer|→|governed tier|interpreter|runtimeValueGrounding|searchSafeColumns|Agent run failed with a blocked outcome|LLM generation/);
    expect(html.match(/Working on the answer/g)).toHaveLength(1);
    expect(html).toContain('15 times');
    expect(html).toContain('Searching stored values is not turned on for these tables');
    // One outcome badge, in the Ask panel's words; not "blocked" twice.
    expect(html.match(/>Blocked</g)).toHaveLength(1);
    expect(html).not.toMatch(/>blocked</);
  });

  it('keeps a config key out of the reason, on the page and on the card alike', () => {
    const setup = { ...blockedRun(), answer: 'This could not be completed while preparing the query; no warehouse query ran: this project lists no tables Ask may read: warehouse modeling is on (modeling.mode in dql.config.json) and no warehouse catalog has been synced yet.' } as AgentRun;
    expect(askRunNoAnswer(setup)?.text).toBe('This could not be completed while preparing the query; no warehouse query ran: this project lists no tables Ask may read: warehouse modeling is on and no warehouse catalog has been synced yet.');
    expect(page({ agentLogRun: setup, agentLogFromView: 'notebook' })).not.toMatch(/dql\.config\.json|modeling\.mode/);
  });

  it('closes when the person moves to another view or another notebook', () => {
    const run = blockedRun();
    useNotebookStore.setState({ mainView: 'notebook', activeFile: notebook });
    useNotebookStore.getState().dispatch({ type: 'OPEN_AGENT_LOG', run });
    useNotebookStore.getState().dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' });
    expect(useNotebookStore.getState()).toMatchObject({ mainView: 'ask', agentLogRun: undefined, agentLogFromView: undefined });

    const open = { ...useNotebookStore.getState(), mainView: 'notebook', activeFile: notebook, agentLogRun: run, agentLogFromView: 'notebook' } as NotebookState;
    const other = { ...open, activeFile: { ...notebook, path: 'notebooks/welcome.dqlnb' } } as NotebookState;
    expect(withoutStaleAgentLog(open, other).agentLogRun).toBeUndefined();
    expect(withoutStaleAgentLog(open, { ...open, cells: [] }).agentLogRun).toBe(run);
  });
});
