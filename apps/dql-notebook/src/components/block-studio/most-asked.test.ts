import { describe, expect, it } from 'vitest';
import { askedLabel, askedQuestionKey, mostAskedQuestions, type ListedRun } from './most-asked';

/** The trust flow approved 2026-11-27: Saved queries lists drafts most asked first, counted from Ask's chat runs. */
let clock = Date.parse('2026-11-20T10:00:00Z');
const run = (question: string, extra: Partial<ListedRun> = {}): ListedRun => {
  clock += 60_000;
  return {
    id: `run-${clock}`,
    question,
    requestedMode: 'auto',
    route: 'generated_answer',
    status: 'completed',
    trustState: 'review_required',
    startedAt: new Date(clock).toISOString(),
    ...extra,
  } as ListedRun;
};

describe('most asked first: counted from what the person asked in Ask', () => {
  it('labels each answer in Ask\'s own words', () => {
    expect(askedLabel(run('a', { trustState: 'certified', route: 'certified_answer' }))).toBe('Certified');
    expect(askedLabel(run('a', { trustState: 'governed', route: 'semantic_answer' }))).toBe('From Metrics');
    expect(askedLabel(run('a'))).toBe('AI-generated');
    expect(askedLabel(run('a', { status: 'blocked', trustState: 'blocked', answer: 'No query was run because the tables Ask searched do not hold it: payroll.' }))).toBe('Not in this data');
    expect(askedLabel(run('a', { status: 'blocked', trustState: 'blocked', answer: 'No AI model is configured.' }))).toBe('No answer');
  });

  it('matches a question however it is cased or punctuated', () => {
    expect(askedQuestionKey('How many games are in our data?')).toBe(askedQuestionKey('how many  games are in our data'));
  });

  it('lists one entry per question, most asked first, then the most recently asked', () => {
    const asked = mostAskedQuestions([
      run('How many games are in our data?'),
      run('Which team has the biggest arena?'),
      run('how many games are in our data'),
      run('Who won the 2016 title?'),
      run('How many games are in our data'),
    ]);
    expect(asked.map((entry) => [entry.question, entry.askedTimes])).toEqual([
      // Its last wording.
      ['How many games are in our data', 3],
      ['Who won the 2016 title?', 1],
      ['Which team has the biggest arena?', 1],
    ]);
  });

  it('never invents a question and leaves out follow-ups, other modes and chat replies', () => {
    expect(mostAskedQuestions([
      run('What about 2009?'),
      run('And for the Lakers?'),
      run('Which of those had a winning record?', { conversationBinding: 'prior_result' }),
      run('Build me an App about sales', { requestedMode: 'app', route: 'app_build' }),
      run('Research churn drivers', { requestedMode: 'research', route: 'research' }),
      run('Hello', { route: 'conversation' }),
    ])).toEqual([]);
  });

  it('does not read the route decision\'s followsUp as a follow-up: every Ask pipeline run carries it', () => {
    expect(mostAskedQuestions([run('How many games are in our data?', { routeDecision: { followsUp: true } })])).toHaveLength(1);
  });

  it('counts a question Ask asked back about, and labels it from the last answer it got', () => {
    const [answered] = mostAskedQuestions([
      run('Who is the best scorer?'),
      run('Who is the best scorer?', { status: 'needs_clarification', route: 'clarify', trustState: 'not_applicable' }),
      run('Who is the best scorer?', { status: 'cancelled', route: 'cancelled', trustState: 'not_applicable' }),
    ]);
    expect(answered).toMatchObject({ askedTimes: 3, label: 'AI-generated' });
    const [never] = mostAskedQuestions([run('How are the Warriors doing lately?', { status: 'needs_clarification', route: 'clarify', trustState: 'not_applicable' })]);
    expect(never!.askedTimes).toBe(1);
    expect(never!.label).toBeUndefined();
  });
});
