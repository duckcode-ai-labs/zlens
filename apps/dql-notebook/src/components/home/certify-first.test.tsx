import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CERTIFY_FIRST_TITLE_NONE,
  CERTIFY_FIRST_TITLE_SOME,
  CERTIFY_GUIDE_DISMISSED_KEY,
  certifiedSavedQueryCount,
  certifyFirstView,
  certifyGuideDismissed,
  certifyQuestionKey,
  certifyStepAction,
  certifyStepLabel,
  certifyStepNote,
  certifySteps,
  setCertifyGuideDismissed,
} from './certify-first';
import { CertifyFirstCardView } from './CertifyFirstCard';
import { CertifyGuideSettingView } from '../settings/CertifyGuideSetting';
import { themes } from '../../themes/notebook-theme';

/** Snowflake app fix plan, Risk 1 (B1): the certify-first guide on Ask's home. */
type Run = Parameters<typeof certifySteps>[0][number];
let clock = Date.parse('2026-11-20T10:00:00Z');
const run = (question: string, extra: Partial<Run> = {}): Run => {
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
  };
};

describe('certify-first guide: the questions to certify come from what the person asked', () => {
  it('labels each answer in Ask\'s own words', () => {
    expect(certifyStepLabel(run('a', { trustState: 'certified', route: 'certified_answer' }))).toBe('Certified');
    expect(certifyStepLabel(run('a', { trustState: 'governed', route: 'semantic_answer' }))).toBe('From Metrics');
    expect(certifyStepLabel(run('a'))).toBe('AI-generated');
    expect(certifyStepLabel(run('a', { status: 'blocked', trustState: 'blocked', answer: 'No query was run because the tables Ask searched do not hold it: payroll.' }))).toBe('Not in this data');
    expect(certifyStepLabel(run('a', { status: 'blocked', trustState: 'blocked', answer: 'No AI model is configured.' }))).toBe('No answer');
  });

  it('matches a question however it is cased or punctuated', () => {
    expect(certifyQuestionKey('How many games are in our data?')).toBe(certifyQuestionKey('how many  games are in our data'));
  });

  it('lists one step per question, most asked first, using the draft\'s own count', () => {
    const runs = [
      run('How many games are in our data?', { reviewDraft: { path: 'blocks/_drafts/many_games_data.dql', askedTimes: 3 } }),
      run('Which team has the biggest arena?', { reviewDraft: { path: 'blocks/_drafts/biggest_arena.dql', askedTimes: 9 } }),
      run('how many games are in our data', { reviewDraft: { path: 'blocks/_drafts/many_games_data.dql', askedTimes: 4 } }),
      run('Who won the 2016 title?'),
    ];
    const steps = certifySteps(runs, 10);
    expect(steps.map((step) => [step.question, step.askedTimes])).toEqual([
      ['Which team has the biggest arena?', 9],
      // Its last wording, and the draft's count (4), not the two runs read.
      ['how many games are in our data', 4],
      ['Who won the 2016 title?', 1],
    ]);
    expect(steps[0]!.draftPath).toBe('blocks/_drafts/biggest_arena.dql');
    expect(steps[2]!.draftPath).toBeUndefined();
  });

  it('never invents a question and leaves out follow-ups, questions back, other modes and certified ones', () => {
    const runs = [
      run('What about 2009?'),
      run('And for the Lakers?'),
      run('Which of those had a winning record?', { conversationBinding: 'prior_result' }),
      run('Who is the best player?', { status: 'needs_clarification', route: 'clarify', trustState: 'not_applicable' }),
      run('Build me an App about sales', { requestedMode: 'app', route: 'app_build' }),
      run('Research churn drivers', { requestedMode: 'research', route: 'research' }),
      run('How many teams are there?', { trustState: 'certified', route: 'certified_answer' }),
      run('Hello', { route: 'conversation' }),
    ];
    expect(certifySteps(runs, 10)).toEqual([]);
  });

  it('does not read the route decision\'s followsUp as a follow-up: every Ask pipeline run carries it', () => {
    expect(certifySteps([run('How many games are in our data?', { routeDecision: { followsUp: true } })], 10)).toHaveLength(1);
  });

  it('leaves out a question Ask last asked back about, and keeps one it answered after asking back', () => {
    expect(certifySteps([
      run('How are the Warriors doing lately?', { reviewDraft: { path: 'blocks/_drafts/warriors.dql', askedTimes: 2 } }),
      run('How are the Warriors doing lately?', { status: 'needs_clarification', route: 'clarify', trustState: 'not_applicable' }),
    ], 10)).toEqual([]);
    const answered = certifySteps([
      run('Who is the best scorer?', { status: 'needs_clarification', route: 'clarify', trustState: 'not_applicable' }),
      run('Who is the best scorer?', { reviewDraft: { path: 'blocks/_drafts/best_scorer.dql', askedTimes: 1 } }),
    ], 10);
    expect(answered.map((step) => [step.label, step.askedTimes])).toEqual([['AI-generated', 2]]);
  });

  it('a stopped run is not the last answer', () => {
    const [step] = certifySteps([
      run('How many teams are there?', { reviewDraft: { path: 'blocks/_drafts/teams.dql', askedTimes: 1 } }),
      run('How many teams are there?', { status: 'cancelled', route: 'cancelled', trustState: 'not_applicable' }),
    ], 10);
    expect(step!.label).toBe('AI-generated');
    expect(step!.draftPath).toBe('blocks/_drafts/teams.dql');
  });

  it('two wordings that share one draft saved query are one step', () => {
    const steps = certifySteps([
      run('How many games are in our data?', { reviewDraft: { path: 'blocks/_drafts/many_games_data.dql', askedTimes: 7 } }),
      run('Total number of games we have?', { reviewDraft: { path: 'blocks/_drafts/many_games_data.dql', askedTimes: 8 } }),
    ], 10);
    expect(steps.map((step) => step.question)).toEqual(['Total number of games we have?']);
  });

  it('a question whose last answer is Certified is done, even if earlier answers were not', () => {
    const runs = [
      run('How many teams are there?', { reviewDraft: { path: 'blocks/_drafts/teams.dql', askedTimes: 5 } }),
      run('How many teams are there?', { trustState: 'certified', route: 'certified_answer' }),
    ];
    expect(certifySteps(runs, 10)).toEqual([]);
  });

  it('offers Compare with the old report only where a draft saved query exists to compare', () => {
    const steps = certifySteps([
      run('A?', { reviewDraft: { path: 'blocks/_drafts/a.dql', askedTimes: 3 } }),
      run('B?'),
      run('C?', { status: 'blocked', trustState: 'blocked', answer: 'the tables Ask searched do not hold it', reviewDraft: { path: 'blocks/_drafts/c.dql', askedTimes: 1 } }),
    ], 10);
    const [withDraft, without, gap] = ['A?', 'B?', 'C?'].map((question) => steps.find((step) => step.question === question));
    expect(certifyStepAction(withDraft!)).toEqual({ kind: 'open_draft', label: 'Compare with the old report' });
    expect(certifyStepNote(withDraft!)).toBe('Asked 3 times. Its saved query is a draft: compare it, then certify.');
    expect(certifyStepAction(without!)).toEqual({ kind: 'ask', label: 'Ask it' });
    expect(certifyStepNote(without!)).toBe('Asked once. Ask it, then Save as saved query: its page has Compare with the old report.');
    expect(gap!.label).toBe('Not in this data');
    expect(gap!.draftPath).toBeUndefined();
    expect(certifyStepAction(gap!)).toEqual({ kind: 'ask', label: 'Ask again' });
  });
});

describe('certify-first guide: progress to ten', () => {
  it('counts certified saved queries, not drafts or replaced ones', () => {
    expect(certifiedSavedQueryCount([
      { status: 'certified' }, { status: 'certified', replacedBy: 'newer' }, { status: 'draft' }, { status: 'certified', deprecatedOn: '2026-11-01' }, { status: 'certified' },
    ])).toBe(2);
  });

  it('says nothing is certified yet on a fresh install, and the count after that', () => {
    const fresh = certifyFirstView({ certified: 0, runs: [] })!;
    expect(fresh.title).toBe('Nothing is certified yet. Certify your 10 most-asked questions');
    expect(fresh.progress).toBe('0 of 10 certified');
    expect(fresh.steps).toEqual([]);
    const two = certifyFirstView({ certified: 2, runs: [] })!;
    expect(two.title).toBe(CERTIFY_FIRST_TITLE_SOME);
    expect(two.progress).toBe('2 of 10 certified');
  });

  it('lists at most what is left to ten, and is gone at ten', () => {
    const runs = Array.from({ length: 12 }, (_, index) => run(`Question ${index + 1}?`));
    expect(certifyFirstView({ certified: 7, runs })!.steps).toHaveLength(3);
    expect(certifyFirstView({ certified: 10, runs })).toBeNull();
    expect(certifyFirstView({ certified: 14, runs })).toBeNull();
  });
});

describe('certify-first guide: the card', () => {
  const steps = certifySteps([
    run('How many games are in our data?', { reviewDraft: { path: 'blocks/_drafts/many_games_data.dql', askedTimes: 6 } }),
    ...Array.from({ length: 6 }, (_, index) => run(`Question ${index + 1}?`)),
  ], 10);
  const view = { certified: 2, goal: 10, progress: '2 of 10 certified', title: CERTIFY_FIRST_TITLE_SOME, steps };
  const render = (extra: Partial<Parameters<typeof CertifyFirstCardView>[0]> = {}) => renderToStaticMarkup(
    <CertifyFirstCardView view={view} onOpenDraft={() => undefined} onAsk={() => undefined} onDismiss={() => undefined} {...extra} />,
  );

  it('shows the title, the progress and the steps, three at first', () => {
    const html = render();
    expect(html).toContain('Certify your 10 most-asked questions');
    expect(html).toContain('2 of 10 certified');
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain('From your Ask history, most asked first');
    expect(html.match(/data-testid="certify-step"/g)).toHaveLength(3);
    expect(html).toContain('Show 4 more');
    expect(render({ showAll: true }).match(/data-testid="certify-step"/g)).toHaveLength(7);
  });

  it('leads each step into Compare with the old report, then certify', () => {
    const html = render();
    expect(html).toContain('How many games are in our data?');
    expect(html).toContain('>Compare with the old report<');
    expect(html).toContain('certify it with &quot;I reviewed it&quot;');
    expect(html).toContain('>AI-generated<');
  });

  it('lets a person type their own question, and can be dismissed', () => {
    const html = render();
    expect(html).toContain('A question you ask often:');
    expect(html).toContain('placeholder="Type it in your own words"');
    expect(html).toContain('aria-label="Dismiss the certify guide"');
    expect(html).toContain('Settings » Appearance shows it again.');
  });

  it('on a fresh install says nothing is certified yet and asks for the first questions', () => {
    const html = renderToStaticMarkup(
      <CertifyFirstCardView view={certifyFirstView({ certified: 0, runs: [] })!} onOpenDraft={() => undefined} onAsk={() => undefined} onDismiss={() => undefined} />,
    );
    expect(html).toContain(CERTIFY_FIRST_TITLE_NONE);
    expect(html).toContain('0 of 10 certified');
    expect(html).toContain('Nothing asked yet.');
  });
});

describe('certify-first guide: dismissed in this browser, back only from Settings', () => {
  const memory = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  };

  it('remembers a dismissal and forgets it when Settings shows the guide again', () => {
    const store = memory();
    expect(certifyGuideDismissed(store)).toBe(false);
    setCertifyGuideDismissed(true, store);
    expect(store.getItem(CERTIFY_GUIDE_DISMISSED_KEY)).toBe('1');
    expect(certifyGuideDismissed(store)).toBe(true);
    setCertifyGuideDismissed(false, store);
    expect(certifyGuideDismissed(store)).toBe(false);
  });

  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(certifyGuideDismissed(broken)).toBe(false);
    expect(() => setCertifyGuideDismissed(true, broken)).not.toThrow();
  });

  it('Settings » Appearance offers it again once dismissed', () => {
    const t = themes.paper;
    const onChange = vi.fn();
    const dismissed = renderToStaticMarkup(<CertifyGuideSettingView t={t} dismissed onChange={onChange} />);
    expect(dismissed).toContain('Certify guide');
    expect(dismissed).toContain('Dismissed in this browser.');
    expect(dismissed).toContain('>Show it again<');
    const shown = renderToStaticMarkup(<CertifyGuideSettingView t={t} dismissed={false} onChange={onChange} />);
    expect(shown).toContain('>Hide it<');
  });
});
