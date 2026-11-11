/**
 * The reported symptom:
 *
 *   "when user having a conversation which is generating answer then if user
 *    ask different question its not giving right solution"
 *
 * Three mechanisms carried the previous question onto an unrelated one: a
 * question the planner could not parse was classified `continuation` (never a
 * shift); a detected shift cleared only `filters`, leaving the topic, entities,
 * measures and dimensions in place; and `isFilterOnlyRefinement` compared two
 * EMPTY plans as equal, so two unrelated unreadable questions reused the whole
 * prior context pack including its committed route decision.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationStore, type ConversationTurnInput } from './session-store.js';
import { advanceThreadState, buildConversationSnapshot, readsAsNewQuestion } from './snapshot.js';
import { isFilterOnlyRefinement } from '../metadata/catalog.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';

const ANSWERED: ConversationTurnInput = {
  question: 'Top customers by beverage revenue in 2024',
  answerSummary: 'Melissa Lopez leads.',
  answerText: 'Melissa Lopez leads.',
  route: 'generated_answer',
  runStatus: 'needs_review',
  trustLabel: 'review_required',
  result: { columns: ['customer_name', 'beverage_revenue'], rowCount: 5 },
  contract: {
    measures: ['beverage revenue'],
    dimensions: ['customer'],
    filters: ['2024'],
    entities: ['customer'],
  },
};

describe('topic shift clears carried context', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function threadWithAnsweredTurn(): { store: ConversationStore; threadId: string } {
    const root = mkdtempSync(join(tmpdir(), 'dql-topic-'));
    dirs.push(root);
    const store = new ConversationStore(join(root, 'conversations.sqlite'));
    const threadId = store.createThread({ surface: 'ask' }).id;
    advanceThreadState(store, threadId, store.appendTurn(threadId, ANSWERED));
    return { store, threadId };
  }

  it('carries context for a genuine follow-up', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    const snapshot = buildConversationSnapshot(store, threadId, {
      question: 'break that down by region',
    })!;
    expect(snapshot.topicRelation).not.toBe('shift');
    expect(snapshot.workingState).toBeDefined();
  });

  it('drops the whole carried shape on a new topic, not just the filters', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    const snapshot = buildConversationSnapshot(store, threadId, {
      question: 'How many warehouse shipments were delayed last quarter?',
    })!;

    expect(snapshot.topicRelation).toBe('shift');
    const carried = JSON.stringify(snapshot.workingState ?? {});
    for (const stale of ['customer', 'beverage', '2024']) {
      expect(carried, `leaked "${stale}" onto a new topic`).not.toContain(stale);
    }
  });

  // A short fragment the planner cannot read is the MOST COMMON follow-up shape.
  // Treating those as a new topic threw away the measure and timeframe the
  // follow-up depends on — which is how a MetricFlow query lost `metric_time`.
  // Preserving context is the safer default: a stale carry gives a wrong-ish
  // answer the user can redirect, a dropped carry breaks the follow-up outright.
  it('keeps context for short follow-up fragments the planner cannot read', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    for (const question of [
      'and by month?', 'now by region', 'what about 2023', 'show monthly', 'by month', 'also weekly',
    ]) {
      const snapshot = buildConversationSnapshot(store, threadId, { question })!;
      expect(snapshot.topicRelation, question).not.toBe('shift');
      expect(JSON.stringify(snapshot.workingState ?? {}), question).toContain('beverage');
    }
  });

  it('still shifts on a self-contained new question', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    const snapshot = buildConversationSnapshot(store, threadId, {
      question: 'How many warehouse shipments were delayed last quarter?',
    })!;
    expect(snapshot.topicRelation).toBe('shift');
  });

  // The reported regression. "who are the top customers" answered, then
  // "what region he belongs to" was classified a SHIFT — five words, opening
  // with an interrogative, and no deictic token the classifier recognised,
  // because third-person pronouns were missing from `referencesPriorTurn`.
  // A shift discards the whole follow-up context, so the member the pronoun
  // referred to was gone before the router ran, and the turn died as
  // "Not enough context to answer safely". Rephrasing could never recover:
  // the retry compared against the same retained topic key and shifted again.
  it('keeps context for an attribute question carrying a third-person pronoun', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    for (const question of [
      'what region he belongs to',
      'which region he belongs to',
      'what region does she belong to',
      'which region do they belong to',
    ]) {
      const snapshot = buildConversationSnapshot(store, threadId, { question })!;
      expect(snapshot.topicRelation, question).not.toBe('shift');
      expect(JSON.stringify(snapshot.workingState ?? {}), question).toContain('customer');
    }
  });

  // Turn 4 of the reported journey. Naming the member outright removes ALL
  // ambiguity, and is the one case where dropping the prior result is most
  // clearly wrong — yet it shifted too (seven words, leading "which", no
  // recognised deictic token), which sent the run hunting without a binding
  // until it burned its dispatch budget.
  it('keeps context when the question names a value the prior answer displayed', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-topic-named-'));
    dirs.push(root);
    const store = new ConversationStore(join(root, 'conversations.sqlite'));
    const threadId = store.createThread({ surface: 'ask' }).id;
    advanceThreadState(store, threadId, store.appendTurn(threadId, {
      ...ANSWERED,
      result: {
        columns: ['customer_name', 'lifetime_spend'],
        rowCount: 10,
        dimensionValues: { customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner', 'Angela Moyer'] },
      },
    }));

    const snapshot = buildConversationSnapshot(store, threadId, {
      question: 'which region "Mr. Matthew Meyer" belongs to',
    })!;
    expect(snapshot.topicRelation).toBe('refinement');
    expect(snapshot.workingState).toBeDefined();
  });

  // The narrow anaphora rule must not swallow genuinely new questions just
  // because they contain a common connective. Only pronouns and
  // demonstratives keep a question attached to the prior topic.
  it('still shifts on a new question that merely contains a connective', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    const snapshot = buildConversationSnapshot(store, threadId, {
      question: 'How many warehouse shipments and delivery routes were delayed?',
    })!;
    expect(snapshot.topicRelation).toBe('shift');
  });
});

describe('isFilterOnlyRefinement requires evidence of sameness', () => {
  it('does not treat two unreadable questions as the same query', () => {
    const prior = buildAnalysisQuestionPlan('zzqq frobnication');
    const next = buildAnalysisQuestionPlan('wibble plough');
    // Both plans are empty; a pure set comparison called them equal, which
    // reused the earlier context pack AND its route decision for an unrelated
    // question.
    expect(isFilterOnlyRefinement(prior, next)).toBe(false);
  });

  it('still recognises a real filter-only refinement', () => {
    const prior = buildAnalysisQuestionPlan('revenue by region in 2024');
    const next = buildAnalysisQuestionPlan('revenue by region in 2025');
    expect(isFilterOnlyRefinement(prior, next)).toBe(true);
  });
});

describe('a whole new question in a chat is read on its own (new-user test B2, 2026-11-10)', () => {
  it('reads complete questions as new, even with "and" or "that" inside them', () => {
    for (const question of [
      'What was the total number of points scored in the 2016 regular season?',
      'Which team won the most regular season games in 2015?',
      "Who were the Lakers' top 3 rebounders in the 2009 season?",
      'Which teams did Kevin Durant play for, and in which seasons?',
      'How many home games did the Boston Celtics win in the 2008 regular season?',
      'Which teams that won more than 60 games made the finals?',
      // A pronoun the question itself gives a referent to (V11 retest, N5).
      'What was the biggest winning margin in a single game, and who won it?',
      'Which player scored the most points in 2016, and what team was he on?',
    ]) expect(readsAsNewQuestion(question), question).toBe(true);
  });

  it('keeps fragments and questions that point back as edits of the previous answer', () => {
    for (const question of [
      'and by month?',
      'What about the 2016 season?',
      'How did he do in the playoffs that year?',
      'Which of those teams made the playoffs?',
      'Show the same numbers for the Lakers',
      'Break it down by season',
      'Now show only the home games please',
      'What was it in 2014 instead?',
      // The golden NBA conversation's second turn: a command that edits the answer on screen.
      'Show only calendar year 2017, and expand that to the top ten players.',
      'List the top ten players by points per game this season',
      'Which players should we build around, and what would expand that list?',
      // A pronoun before the question names anything, or after too short a start, still points back.
      'How many points did he score, and in which season?',
      'Who won it, and by how much?',
      'What did it cost and who paid?',
    ]) expect(readsAsNewQuestion(question), question).toBe(false);
  });
});
