import { describe, expect, it } from 'vitest';
import { runAskPipeline } from './pipeline.js';
import { composeAnsweredText } from './outcomes.js';
import { clauseQuestion } from './resolve-intent.js';
import type { AnalyticalIntentV1 } from './intent.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import type { AgentProvider } from '../providers/types.js';

/**
 * A slow model's reading must leave the run time to write the SQL, and a run that still runs out of time says so
 * (new-user test of the ZLens app for Snowflake, V11 retest: on Cortex a 83 s reading and a 74 s correction left no
 * time to draft, and K4, G1 and N5 were told the question did not match the project's fields).
 */
const source: VocabularySource = {
  metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' }],
  dimensions: [{ name: 'region', model: 'orders', label: 'Region', dataType: 'string' }],
  relations: [{ schema: 'dev', name: 'orders', columnCompleteness: 'complete', columns: [{ name: 'amount', dataType: 'NUMBER' }, { name: 'region', dataType: 'VARCHAR' }] }],
};
const vocabulary = buildVocabularyIndex(source);

/** A model whose readings never parse, so each reading asks for a correction; every call takes `callMs` on the run's clock. */
function unreadableModel(clock: { now: number }, callMs: number): AgentProvider & { calls: number } {
  const provider = {
    name: 'ollama' as const,
    calls: 0,
    available: async () => true,
    generate: async () => { provider.calls += 1; clock.now += callMs; return 'I think the question is about orders.'; },
  };
  return provider;
}

/** The host's window for new AI calls: 120 s on Cortex, counted on the run's clock. */
const run = (clock: { now: number }, provider: AgentProvider, drafts: Array<{ hasReading: boolean }>, windowMs = 120_000) => runAskPipeline({
  question: 'Total amount of orders in the west region', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
  now: () => clock.now, deadlineMs: 180_000, dispatchWindowMs: () => windowMs - clock.now,
  prepareDeps: {
    draftSql: async (draft) => {
      drafts.push({ hasReading: Boolean(draft.intent) });
      return { sql: "SELECT SUM(amount) AS amount FROM dev.orders WHERE region = 'west'", relations: ['dev.orders'], proof: [] };
    },
  },
  executeDeps: { run: async () => ({ columns: ['amount'], rows: [{ amount: 42 }], rowCount: 1, executionTimeMs: 1 }) },
});

describe('a slow reading keeps the time the SQL needs (V11 retest)', () => {
  it('skips a correction the SQL would not fit after, and drafts from the question itself', async () => {
    // An 83 s reading on a 120 s window: a correction would end past it.
    const clock = { now: 0 };
    const provider = unreadableModel(clock, 83_000);
    const drafts: Array<{ hasReading: boolean }> = [];
    const outcome = await run(clock, provider, drafts);
    expect(provider.calls).toBe(1);
    expect(drafts).toEqual([{ hasReading: false }]);
    expect(outcome.kind).toBe('answered');
  });

  it('corrects the reading when the run has the time, on a slow model or a fast one', async () => {
    for (const [callMs, windowMs] of [[20_000, 120_000], [10, 30_000]] as const) {
      const clock = { now: 0 };
      const provider = unreadableModel(clock, callMs);
      const drafts: Array<{ hasReading: boolean }> = [];
      const outcome = await run(clock, provider, drafts, windowMs);
      expect(provider.calls).toBe(2);
      expect(drafts).toHaveLength(1);
      expect(outcome.kind).toBe('answered');
    }
  });

  it('a run with no time left to draft says it ran out of time, not that the question does not match the data', async () => {
    // A reading that alone took the whole window.
    const clock = { now: 0 };
    const provider = unreadableModel(clock, 125_000);
    const drafts: Array<{ hasReading: boolean }> = [];
    const outcome = await run(clock, provider, drafts);
    expect(provider.calls).toBe(1);
    expect(drafts).toEqual([]);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.text).toContain('No query was run: Ask ran out of time before the AI could write the SQL');
    expect(outcome.text).toContain('Nothing is wrong with the question: ask it again, or ask a simpler one.');
    expect(outcome.text).not.toMatch(/match this question to the project's fields|could not write SQL/);
    expect(outcome.receipt.failure).toMatchObject({ stage: 'prepare', reason: 'provider_timeout' });
  });
});

describe('a clause the reading wrote as a question is asked as written (V11 retest, Q16)', () => {
  it('never wraps a question in another question', () => {
    expect(clauseQuestion("best player — which stat should define 'best' (total points, points per game)?")).toBe("Which stat should define 'best' (total points, points per game)?");
    expect(clauseQuestion('Which season do you mean?')).toBe('Which season do you mean?');
    expect(clauseQuestion('best player')).toBe('What do you mean by "best player"?');
  });

  it('a clause that holds a question and then says what is unclear is asked plainly (V12 retest, Q17)', () => {
    const asked = clauseQuestion("How are the Warriors doing lately? — neither the measure of 'doing' (wins, points per game) nor 'lately' (no recent period is defined in this project)");
    expect(asked).toBe("Not clear yet: neither the measure of 'doing' (wins, points per game) nor 'lately' (no recent period is defined in this project). Which did you mean?");
    expect(asked).not.toMatch(/\?"\?|"[^"]*\?[^"]*"/);
    expect(clauseQuestion('how are they doing (which performance measure)')).toBe('How are they doing (which performance measure)?');
    expect(clauseQuestion("what defines 'best player' (efficiency rating, career points, or another stat)")).toBe("What defines 'best player' (efficiency rating, career points, or another stat)?");
  });
});

const priorReading = (reading: string) => ({ version: 1, kind: 'analytics', reading, measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }) as unknown as AnalyticalIntentV1;
const followUp = (clock: { now: number }, draftSql: NonNullable<Parameters<typeof runAskPipeline>[0]['prepareDeps']['draftSql']>) => runAskPipeline({
  question: 'Which of those had a winning record?', vocabulary, provider: unreadableModel(clock, 83_000), clauseCoverage: false, explorationAuto: true,
  prior: priorReading('Which 5 regions had the most orders?'),
  now: () => clock.now, deadlineMs: 180_000, dispatchWindowMs: () => 120_000 - clock.now,
  prepareDeps: { draftSql },
  executeDeps: { run: async () => ({ columns: ['region'], rows: [{ region: 'west' }], rowCount: 1, executionTimeMs: 1 }) },
});

describe('a follow-up keeps its context when the reading is slow (V12 retest, long-chat N4)', () => {
  it('the draft is told which question it follows, and the answer says the SQL was written from the words', async () => {
    const seen: Array<{ question: string; followUp?: string }> = [];
    const outcome = await followUp({ now: 0 }, async (draft) => {
      seen.push({ question: draft.question, ...(draft.followUp ? { followUp: draft.followUp } : {}) });
      return { sql: 'SELECT region FROM dev.orders', relations: ['dev.orders'], proof: [] };
    });
    expect(seen).toEqual([{ question: 'Which of those had a winning record?', followUp: 'Which 5 regions had the most orders?' }]);
    expect(outcome.kind).toBe('answered');
    // No echo of the question as its reading: the answer says no reading was made, and why.
    expect(outcome.text).toContain('The AI model took too long to read the question (83 s), so the SQL was written from your words and the question before it.');
    expect(outcome.text).not.toContain('I read this as');
    expect(outcome.receipt.reading).toBe('Which of those had a winning record? (following up on: Which 5 regions had the most orders?)');
  });

  it('a draft that cannot tell what the words mean says the run ran out of time, never that the data lacks it', async () => {
    const outcome = await followUp({ now: 0 }, async () => ({ declined: 'The question "those" does not resolve to a clear set of teams from the prior context' }));
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.text).toBe('No query was run: Ask ran out of time before the AI could read the question (reading it took the AI model 83 s), and the words alone did not say enough to write the SQL. Nothing is wrong with the question: ask it again, or say in full what it refers to.');
    expect(outcome.text).not.toMatch(/do(es)? not hold|not in this data|tables Ask searched/);
    expect(outcome.receipt.failure).toMatchObject({ stage: 'prepare', reason: 'provider_timeout' });
  });
});

describe('the answer reads as one answer sentence, the reading, and one source line (V12 retest)', () => {
  const intent = (reading: string) => priorReading(reading);
  it('says the figure first, names no identifier beside a name, and ends the reading once', () => {
    const text = composeAnsweredText(intent('Who were the top scorers in the 2016 playoffs, matching the certified block for this ranking?'), {
      columns: ['PLAYER_ID', 'PLAYER_NAME', 'PLAYOFF_POINTS_2016'],
      rows: [{ PLAYER_ID: 2544, PLAYER_NAME: 'LeBron James', PLAYOFF_POINTS_2016: 591 }, { PLAYER_ID: 201939, PLAYER_NAME: 'Stephen Curry', PLAYOFF_POINTS_2016: 477 }],
      rowCount: 2, executionTimeMs: 1,
    }, vocabulary, 'review_required', { scope: ['it counts only playoff games (GAME_ID starting with 4)'], source: 'SQL written by AI from the LOCAL_PLAYER_GAME_FACTS table, because no certified saved query or metric answers this; review it before relying on the numbers' });
    expect(text).toBe([
      '2 rows, starting with LeBron James · 591; Stephen Curry · 477.',
      'I read this as: Who were the top scorers in the 2016 playoffs, matching the certified saved query for this ranking? It counts only playoff games (GAME_ID starting with 4).',
      'Source: SQL written by AI from the LOCAL_PLAYER_GAME_FACTS table, because no certified saved query or metric answers this; review it before relying on the numbers.',
    ].join('\n\n'));
    expect(text).not.toMatch(/2544|201939|\?\.|certified block/);
  });

  it('reads one row as words: a name, then each figure by its column name in words', () => {
    const one = (columns: string[], row: Record<string, unknown>) => composeAnsweredText(intent('x'), { columns, rows: [row], rowCount: 1, executionTimeMs: 1 }, vocabulary, 'review_required').split('\n\n')[0];
    expect(one(['TEAM_ID', 'TEAM_NICKNAME', 'PRESEASON_WINS'], { TEAM_ID: 1610612766, TEAM_NICKNAME: 'Hornets', PRESEASON_WINS: 4 })).toBe('Hornets: preseason wins 4.');
    expect(one(['GAMES_PLAYED', 'POINTS_SCORED'], { GAMES_PLAYED: 79, POINTS_SCORED: 2375 })).toBe('Games played: 79, points scored: 2375.');
    expect(one(['COUNT(DISTINCT PLAYER_ID)'], { 'COUNT(DISTINCT PLAYER_ID)': 2611 })).toBe('Distinct player ID count: 2611.');
  });
});
