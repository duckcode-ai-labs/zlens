import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRun } from '@zlens/agent';
import { askedQuestionOf, captureReviewRequiredDraft, reviewRequiredAnswerOf, standaloneQuestionOf } from './review-draft-capture.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const sql = 'SELECT t.team_id, SUM(s.wins) AS total_wins FROM team_season_facts s JOIN dim_teams t ON s.team_id = t.team_id WHERE s.season = 2017 GROUP BY t.team_id ORDER BY total_wins DESC LIMIT 1';

function run(overrides: Partial<AgentRun> = {}, payload: Record<string, unknown> = {}): AgentRun {
  return {
    id: 'run-tier2',
    question: 'Which team had the most wins in season 2017?',
    requestedMode: 'ask',
    route: 'answer',
    status: 'completed',
    trustState: 'review_required',
    stopReason: 'completed',
    startedAt: '2026-10-14T00:00:00Z',
    completedAt: '2026-10-14T00:00:01Z',
    steps: [],
    summary: 'Rockets, 79 wins.',
    artifacts: [{
      id: 'answer',
      kind: 'answer',
      title: 'Answer',
      trustState: 'review_required',
      payload: {
        kind: 'uncertified',
        reviewStatus: 'review_required',
        certification: 'review_required',
        sql,
        result: { columns: ['team_id', 'total_wins'], rows: [{ team_id: 1610612745, total_wins: 79 }], rowCount: 1 },
        dqlArtifact: {
          kind: 'sql_block',
          name: 'which_team_had_the_most_wins_in_season_2017',
          persistence: 'transient',
          compiledSql: sql,
          source: `block "which_team_had_the_most_wins_in_season_2017" {\n  type = "custom"\n  status = "draft"\n  query = """\n    ${sql}\n  """\n}`,
        },
        ...payload,
      },
    }],
    evaluations: [],
    events: [],
    nextActions: [],
    repairAttempts: 0,
    ...overrides,
  } as AgentRun;
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-tier2-capture-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), '{}\n');
  return root;
}

describe('every Tier-2 (review-required) Ask answer leaves a durable draft', () => {
  it('captures the executed answer as a draft and keeps the answer artifact transient', () => {
    const root = project();
    const tier2 = run();
    const draft = captureReviewRequiredDraft(root, tier2, { owner: 'e2e' });
    expect(draft).toMatchObject({ version: 1, status: 'draft', created: true, askedTimes: 1 });
    const source = readFileSync(join(root, draft!.path), 'utf-8');
    expect(source).toContain('status = "draft"');
    expect(source).toContain('source_run_id = "run-tier2"');
    // The execution receipt is not rewritten: the artifact stays transient.
    expect((tier2.artifacts[0]!.payload as { dqlArtifact: { persistence: string } }).dqlArtifact.persistence).toBe('transient');
    // Asking again reuses the draft instead of adding a file.
    expect(captureReviewRequiredDraft(root, run({ id: 'run-2' }))).toMatchObject({ path: draft!.path, created: false, askedTimes: 2 });
  });

  it('captures nothing for certified answers, refusals, clarifications or withheld figures', () => {
    expect(reviewRequiredAnswerOf(run({ trustState: 'certified' }, { kind: 'certified', certification: 'certified', reviewStatus: 'certified' }))).toBeNull();
    expect(reviewRequiredAnswerOf(run({ status: 'blocked' }))).toBeNull();
    expect(reviewRequiredAnswerOf(run({ status: 'needs_clarification' }))).toBeNull();
    expect(reviewRequiredAnswerOf(run({}, { result: undefined }))).toBeNull();
    expect(reviewRequiredAnswerOf(run({ figuresWithheld: true }))).toBeNull();
  });

  it('names a follow-up draft from what it answered, not from its own few words', () => {
    const root = project();
    const reading = 'Find the player with the most double-double games in the 2009 season.';
    const followUp = run({ question: 'What about 2009?' }, { askIntentV1: { reading, provenance: {}, filters: [] } });
    expect(standaloneQuestionOf(followUp, { askIntentV1: { reading } })).toBe(reading);
    const draft = captureReviewRequiredDraft(root, followUp);
    expect(draft!.path).toBe('blocks/_drafts/find_player_most_double_double_games_2009_season.dql');
    expect(draft!.path).not.toContain('about_2009');
    // A question that stands on its own keeps its own words, whatever the reading says.
    expect(standaloneQuestionOf(run(), { askIntentV1: { reading: 'Rank teams by wins in 2017.' } })).toBe('Which team had the most wins in season 2017?');
    // A clause carried from the earlier answer makes it a follow-up too.
    expect(standaloneQuestionOf(run({ question: 'Which had a winning record?' }), { askIntentV1: { reading: 'Of the top 5 teams in 2019, which had a winning record?', filters: [{ source: 'inherited' }] } }))
      .toBe('Of the top 5 teams in 2019, which had a winning record?');
  });

  it('asking the same question again, in other case and punctuation, reuses its one draft', () => {
    const root = project();
    const first = captureReviewRequiredDraft(root, run());
    const again = captureReviewRequiredDraft(root, run({ id: 'run-3', question: 'which team had the most wins in season 2017' }, { sql: 'SELECT 79', dqlArtifact: undefined }));
    expect(again).toMatchObject({ path: first!.path, created: false, askedTimes: 2 });
  });

  it('a repeat in a long chat finds its draft by the asked words, however its reading came out (V14, from V13: drafts 38 to 45)', () => {
    const root = project();
    const asked = 'Which teams did Kevin Durant play for, and in which seasons?';
    // In a long chat the turn is bound to the one before, so the draft is filed under its reading.
    const first = captureReviewRequiredDraft(root, run({ question: asked, conversationBinding: 'prior_result' }, { askIntentV1: { reading: 'List the teams Kevin Durant played for in each season, from his player-season records' } }));
    const again = captureReviewRequiredDraft(root, run({ id: 'run-4', question: asked, conversationBinding: 'prior_result' }, { askIntentV1: { reading: 'Teams and seasons for Kevin Durant by team nickname' }, sql: 'SELECT 1', dqlArtifact: undefined }));
    expect(first!.created).toBe(true);
    expect(again).toMatchObject({ path: first!.path, created: false, askedTimes: 2 });
  });

  it('a follow-up is found again by the question it followed and its own words, never by its few words alone', () => {
    expect(askedQuestionOf({ question: 'Which teams did Kevin Durant play for, and in which seasons?' })).toBe('Which teams did Kevin Durant play for, and in which seasons?');
    expect(askedQuestionOf({ question: 'Which of those had a winning record?' })).toBeUndefined();
    expect(askedQuestionOf({ question: 'Which of those had a winning record?' }, 'Which 5 teams scored the most points per game in 2019?'))
      .toBe('Which 5 teams scored the most points per game in 2019? Then: Which of those had a winning record?');
    const root = project();
    const prior = 'Which 5 teams scored the most points per game in 2019?';
    const followUp = (id: string, reading: string) => run({ id, question: 'Which of those had a winning record?', conversationBinding: 'prior_result' }, { askIntentV1: { reading }, sql: `SELECT '${id}'`, dqlArtifact: undefined });
    const first = captureReviewRequiredDraft(root, followUp('run-5', 'Of the 5 teams ranked by points per game in 2019, which had a winning record?'), { priorQuestion: prior });
    const again = captureReviewRequiredDraft(root, followUp('run-6', 'Of the top 5 scoring teams of 2019, which won more than half their games?'), { priorQuestion: prior });
    expect(again).toMatchObject({ path: first!.path, created: false, askedTimes: 2 });
    // After another question, the same words are another question.
    expect(captureReviewRequiredDraft(root, followUp('run-7', 'Of the 3 teams with the most rebounds, which had a winning record?'), { priorQuestion: 'Which 3 teams had the most rebounds?' })!.created).toBe(true);
  });
});
