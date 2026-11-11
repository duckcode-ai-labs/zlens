import { describe, expect, it } from 'vitest';
import type { AgentRun, AgentRunEvent } from '../../api/client';
import { agentStepsBackLabel, buildAgentStepRows, foldRepeatedRows, isGenericRouteReason, stoppingSteps, type AgentStepRow } from './agent-steps';
import { containsInternalCode, type RunStep } from './ask-run-explanation';

const T0 = Date.parse('2026-11-10T20:00:00.000Z');
const QUESTION = 'How many playoff games did the Golden State Warriors win in 2015?';
const at = (ms: number) => new Date(T0 + ms).toISOString();
let counter = 0;
function event(ms: number, type: AgentRunEvent['type'], extra: Partial<AgentRunEvent> = {}): AgentRunEvent {
  counter += 1;
  return { id: `e${String(counter).padStart(3, '0')}`, runId: 'run-po2', type, at: at(ms), message: '', ...extra };
}
const step = (ms: number, title: string, state: 'done' | 'missed' | 'failed' = 'done', detail?: string) => event(ms, 'executor.started', {
  message: title,
  route: 'generated_answer',
  payload: { askStep: { version: 1, phase: 'search', title, state, at: T0 + ms, ...(detail ? { detail } : {}) } },
});
const timer = (ms: number, stage: string, took: number) => event(ms, 'executor.started', { message: `${stage} ${took} ms`, route: 'generated_answer' });
const run = (events: AgentRunEvent[]) => ({ events, startedAt: at(0), question: QUESTION }) as Pick<AgentRun, 'events' | 'startedAt' | 'question'>;

/**
 * The V11 tester's PO-2: a Notebook AI question that was blocked after about
 * 2.5 minutes. The old page showed 17 rows, every one named "Composing the
 * answer (semantic compile → generation)".
 */
function po2Events(): AgentRunEvent[] {
  return [
    event(0, 'run.started', { message: 'Agent run started.' }),
    event(1, 'plan.created', { message: 'Planned.' }),
    event(1, 'step.started', { message: 'Working.', payload: { goal: QUESTION } }),
    event(2, 'route.decided', { route: 'generated_answer', message: 'Ask pipeline: the interpreter resolves the intent and the host prepares every governed tier.' }),
    event(3, 'executor.started', { route: 'generated_answer', message: 'Assembling the governed context for this question.' }),
    step(1_100, 'Searched the project: 3 certified saved queries, 18 tables, 344 columns'),
    event(1_101, 'executor.started', { route: 'generated_answer', message: 'Context assembled in 1098 ms: 344 governed objects · semantic engine duckdb (vocabulary 80 ms).' }),
    event(1_102, 'executor.started', { route: 'generated_answer', message: 'Reading the question against the governed vocabulary.' }),
    timer(82_102, 'resolve', 81_000),
    step(82_103, 'Asked the AI to read the question'),
    step(143_103, 'Asked the AI to correct its reading'),
    step(143_120, 'Did not look for "Warriors" in stored values', 'missed', 'no text column of these tables is allowlisted for value search (agent.runtimeValueGrounding.searchSafeColumns); the AI chooses the field from names and descriptions'),
    timer(143_121, 'ground', 1),
    step(143_150, 'Looked for a certified saved query'),
    step(143_160, 'Looked for a certified saved query'),
    step(143_190, 'Looked for a certified saved query'),
    timer(143_191, 'prepare', 40),
    event(143_300, 'run.failed', { message: 'Agent run failed with a blocked outcome.' }),
  ];
}

describe('steps page rows (V11 tester, PO-2)', () => {
  it('names each step in plain words, never the route jargon the old page repeated', () => {
    const rows = buildAgentStepRows(run(po2Events()));
    const text = rows.map((row) => `${row.label} ${row.detail ?? ''}`).join('\n');
    expect(text).not.toMatch(/semantic compile|→|Composing the answer|governed tier|interpreter/i);
    expect(rows.map((row) => row.label)).toEqual([
      'Started',
      'Planned the approach',
      'Chose how to answer',
      'Searched the project: 3 certified saved queries, 18 tables, 344 columns',
      'Gathered the project’s tables, fields and metrics',
      'Started reading the question',
      'Asked the AI to read the question',
      'Asked the AI to correct its reading',
      'Did not look for "Warriors" in stored values',
      'Looked for a certified saved query',
      'Stopped',
    ]);
    expect(rows.find((row) => row.label === 'Chose how to answer')?.detail).toBe('Certified saved queries first, then metrics, then SQL written by AI');
  });

  it('keeps config keys out of every row and says what is missing instead', () => {
    const rows = buildAgentStepRows(run(po2Events()));
    for (const row of rows) {
      expect(containsInternalCode(row.label)).toBe(false);
      expect(containsInternalCode(row.detail ?? '')).toBe(false);
    }
    expect(rows.find((row) => row.label.startsWith('Did not look for'))).toMatchObject({
      state: 'missed',
      detail: 'Searching stored values is not turned on for these tables, so the AI chose the field from its name and description',
    });
  });

  it('folds repeated steps into one row with a count and their total time', () => {
    const rows = buildAgentStepRows(run(po2Events()));
    const repeated = rows.filter((row) => row.label === 'Looked for a certified saved query');
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ count: 3, ms: 30 + 10 + 30, longestMs: 30 });
  });

  it('gives a stage timer’s time to the next step a reader can name, and loses none', () => {
    const rows = buildAgentStepRows(run(po2Events()));
    // The 81 s AI call ends at the `resolve` timer; the row a reader sees is the call itself.
    expect(rows.find((row) => row.label === 'Asked the AI to read the question')?.ms).toBe(81_001);
    expect(rows.some((row) => /\d+ ms$/.test(row.label))).toBe(false);
    expect(rows.reduce((sum, row) => sum + row.ms, 0)).toBe(143_300);
  });

  it('drops the generic failure message: the reason sits at the top of the page', () => {
    const stopped = buildAgentStepRows(run(po2Events())).at(-1)!;
    expect(stopped).toMatchObject({ label: 'Stopped', state: 'failed' });
    expect(stopped.detail).toBeUndefined();
  });

  it('turns 17 unnamed steps of one route into one plain row', () => {
    const events = [event(0, 'run.started'), ...Array.from({ length: 17 }, (_, index) => event(1_000 * (index + 1), 'executor.started', { route: 'generated_answer' })), event(18_500, 'run.failed', { message: 'Agent run failed with a blocked outcome.' })];
    const rows = buildAgentStepRows(run(events));
    expect(rows.map((row) => [row.label, row.count])).toEqual([['Started', 1], ['Working on the answer', 17], ['Stopped', 1]]);
    expect(rows[1]!.ms).toBe(17_000);
  });

  it('hides the engine’s own bookkeeping and gives its time to the next row', () => {
    const events = [
      event(0, 'run.started'),
      event(5, 'executor.started', { route: 'generated_answer', message: 'Running generated answer executor.' }),
      step(4_005, 'Asked the AI to read the question'),
      event(4_010, 'executor.started', { route: 'generated_answer', message: 'Re-running generated answer executor (repair attempt 1).' }),
    ];
    const rows = buildAgentStepRows(run(events));
    expect(rows.map((row) => [row.label, row.ms])).toEqual([['Started', 0], ['Asked the AI to read the question', 4_005], ['Fixed the query and tried again', 5]]);
  });

  it('folds only rows that follow each other', () => {
    const row = (key: string, label: string, ms: number): AgentStepRow => ({ key, label, ms, count: 1, longestMs: ms, state: 'done', tool: false });
    expect(foldRepeatedRows([row('a', 'A', 1), row('b', 'B', 2), row('c', 'A', 3)]).map((item) => item.count)).toEqual([1, 1, 1]);
  });

  it('a route reason that is the same for every Ask run is not shown as this run’s reason', () => {
    expect(isGenericRouteReason('Ask pipeline: the interpreter resolves the intent and the host prepares every governed tier.')).toBe(true);
    expect(isGenericRouteReason('Matched the certified saved query "Wins by season".')).toBe(false);
  });
});

describe('back link', () => {
  it('names the view the page was opened from', () => {
    expect(agentStepsBackLabel('notebook')).toBe('Back to the notebook');
    expect(agentStepsBackLabel('ask')).toBe('Back to Ask AI');
    expect(agentStepsBackLabel('apps')).toBe('Back to Apps');
    expect(agentStepsBackLabel(undefined)).toBe('Back');
  });
});

describe('where it stopped', () => {
  const s = (id: string, kind: RunStep['kind'], outcome: RunStep['outcome'], reason: string): RunStep => ({ id, n: 0, kind, title: id, outcome, reason, aiCalls: [], checks: [], notes: [], story: [] });

  it('names the steps that failed, not the closing "Stopped" step that repeats them', () => {
    const steps = [s('read', 'read', 'failed', 'The AI could not read the question.'), s('warehouse', 'warehouse', 'not_reached', 'Nothing ran.'), s('failed', 'failed', 'failed', 'Stopped while reading the question.')];
    expect(stoppingSteps({ steps }).map((step) => step.id)).toEqual(['read']);
  });

  it('falls back to the closing step, then to the sources that could not answer', () => {
    expect(stoppingSteps({ steps: [s('failed', 'failed', 'failed', 'Stopped.')] }).map((step) => step.id)).toEqual(['failed']);
    const gap = [s('read', 'read', 'done', 'Read.'), s('tier-certified', 'certified', 'refused', 'No certified saved query matches this question.'), s('ai-sql', 'ai_sql', 'refused', 'The AI looked at the tables and found nothing that answers this.'), s('gap', 'gap', 'refused', 'No answer.')];
    expect(stoppingSteps({ steps: gap }).map((step) => step.id)).toEqual(['tier-certified', 'ai-sql']);
    expect(stoppingSteps(undefined)).toEqual([]);
  });
});
