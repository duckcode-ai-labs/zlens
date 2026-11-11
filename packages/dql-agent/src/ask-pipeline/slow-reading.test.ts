import { describe, expect, it } from 'vitest';
import { runAskPipeline } from './pipeline.js';
import { clauseQuestion } from './resolve-intent.js';
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
    expect(clauseQuestion('best player')).toBe('Which did you mean for "best player"?');
  });
});
