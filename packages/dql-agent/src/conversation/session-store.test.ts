import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationStore,
  defaultConversationPath,
  legacyConversationPath,
  prepareConversationPath,
} from './session-store.js';

describe('ConversationStore', () => {
  let root: string;
  let store: ConversationStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dql-conversation-'));
    store = new ConversationStore(defaultConversationPath(root));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('binds a conversation to the App page it is first asked from, once', () => {
    const thread = store.createThread({ surface: 'apps' });
    expect(store.getThread(thread.id)?.scopeKey).toBeUndefined();
    expect(store.bindThreadScope(thread.id, 'app:top-5:overview')).toBe(true);
    expect(store.getThread(thread.id)?.scopeKey).toBe('app:top-5:overview');
    // Never rebound to another App page.
    expect(store.bindThreadScope(thread.id, 'app:certified:overview')).toBe(false);
    expect(store.getThread(thread.id)?.scopeKey).toBe('app:top-5:overview');
  });

  it('finds the conversation an answer was given in', () => {
    const thread = store.createThread({ surface: 'notebook' });
    store.appendTurn(thread.id, { question: 'claims by region', agentRunId: 'run-42' });
    expect(store.threadIdForRun('run-42')).toBe(thread.id);
    expect(store.threadIdForRun('run-unknown')).toBeNull();
  });

  it('creates threads and appends turns with monotonic seq', () => {
    const thread = store.createThread({ surface: 'notebook' });
    const first = store.appendTurn(thread.id, { question: 'revenue by category' });
    const second = store.appendTurn(thread.id, { question: 'top 5 customers for these categories?' });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    const recent = store.recentTurns(thread.id, 4);
    expect(recent.map((turn) => turn.question)).toEqual([
      'revenue by category',
      'top 5 customers for these categories?',
    ]);
    // Thread title defaults to the first question.
    expect(store.getThread(thread.id)?.title).toBe('revenue by category');
  });

  it('keeps conversation history in durable local state', () => {
    expect(defaultConversationPath(root)).toBe(join(root, '.dql', 'local', 'agent-conversations.sqlite'));
  });

  it('persists a content-free narration integrity receipt with the conversation turn', () => {
    const thread = store.createThread({ surface: 'ask' });
    const receipt = {
      version: 1 as const,
      mode: 'verified_facts' as const,
      outcome: 'deterministic_fallback' as const,
      attempted: true,
      factCount: 2,
      maxRows: 10,
      validationFailures: ['UNPARSEABLE_CLAIMS'],
    };
    store.appendTurn(thread.id, { question: 'revenue by region', narrationIntegrityReceipt: receipt });
    expect(store.recentTurns(thread.id)[0]?.narrationIntegrityReceipt).toEqual(receipt);
  });

  it('migrates the legacy cache database including committed WAL state', async () => {
    store.close();
    rmSync(defaultConversationPath(root), { force: true });
    const legacyStore = new ConversationStore(legacyConversationPath(root));
    const thread = legacyStore.createThread({ surface: 'ask', title: 'Revenue history' });
    legacyStore.appendTurn(thread.id, {
      question: 'Who are the top revenue customers?',
      answerSummary: 'Melissa Lopez is first.',
    });
    legacyStore.close();

    const migratedPath = await prepareConversationPath(root);
    expect(migratedPath).toBe(defaultConversationPath(root));
    expect(existsSync(migratedPath)).toBe(true);
    expect(existsSync(legacyConversationPath(root))).toBe(true);

    store = new ConversationStore(migratedPath);
    expect(store.getThread(thread.id)?.title).toBe('Revenue history');
    expect(store.recentTurns(thread.id)).toEqual([
      expect.objectContaining({
        question: 'Who are the top revenue customers?',
        answerSummary: 'Melissa Lopez is first.',
      }),
    ]);
  });

  it('persists turn payloads with caps applied', () => {
    const thread = store.createThread();
    const turn = store.appendTurn(thread.id, {
      question: 'revenue by category',
      answerSummary: 'Food and Drink revenue split.',
      route: 'certified_answer',
      trustLabel: 'certified',
      runStatus: 'completed',
      stopReason: 'certified_answer_found',
      sourceCertifiedBlock: 'food_vs_drink_revenue',
      contextPackId: 'ctx_abc',
      knowledgeLens: {
        mode: 'pinned', activeDomainId: 'commerce', skillRefs: ['commerce::skill::revenue'],
        snapshotId: 'snapshot-1', capsuleFingerprint: 'capsule-1',
      },
      cascade: {
        terminalLane: 'semantic',
        routeTier: 'semantic_metric',
        label: 'Lane 2 semantic DQL artifact was terminal',
        artifactKind: 'semantic_block',
        outcome: {
          lane: 'semantic',
          routeTier: 'semantic_metric',
          metrics: ['revenue'],
          dimensions: ['category'],
          rowCount: 2,
        },
      },
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'food_vs_drink_revenue',
        source: 'block "food_vs_drink_revenue" {\n  type = "semantic"\n  metric = "revenue"\n}',
        metrics: ['revenue'],
        dimensions: ['category'],
        orderBy: [{ name: 'revenue', direction: 'desc' }],
        limit: 10,
        parameters: [{
          name: 'region',
          type: 'string',
          required: false,
          default: 'North America',
          policy: 'dynamic',
          binding: { kind: 'semantic_filter', field: 'customer.region', operator: 'equals' },
        }],
        parameterValues: { region: 'North America' },
        persistence: 'transient',
        trustState: 'governed',
        compiledSql: 'SELECT category, SUM(revenue) AS revenue FROM analytics.orders GROUP BY category',
        executionReceipt: {
          sourceFingerprint: 'a'.repeat(64),
          compiledSqlFingerprint: 'b'.repeat(64),
          parameterFingerprint: 'c'.repeat(64),
          resultFingerprint: 'd'.repeat(64),
        },
      },
      result: {
        columns: Array.from({ length: 40 }, (_, i) => `col_${i}`),
        rowsSample: Array.from({ length: 20 }, () => ['Food', 240877]),
        dimensionValues: { category: Array.from({ length: 40 }, (_, i) => `value_${i}`) },
        resultFingerprint: 'f'.repeat(64),
        memberSets: [{
          version: 1,
          entity: 'product',
          displayColumn: 'product_name',
          displayValues: Array.from({ length: 40 }, (_, i) => `product_${i}`),
          keyColumn: 'product_id',
          keyValues: Array.from({ length: 40 }, (_, i) => `product_${i}`),
          resultFingerprint: 'e'.repeat(64),
        }],
        rowCount: 2,
      },
      contract: { measures: ['revenue'], dimensions: ['category'] },
    });

    const [stored] = store.recentTurns(thread.id, 1);
    expect(stored.id).toBe(turn.id);
    expect(stored.result?.columns).toHaveLength(24);
    // The sample is retained up to MAX_SAMPLE_ROWS (50) so cross-result
    // follow-up compute covers a realistic top-N result.
    expect(stored.result?.rowsSample).toHaveLength(20);
    expect(stored.result?.dimensionValues?.category).toHaveLength(24);
    expect(stored.result?.memberSets).toEqual([expect.objectContaining({
      entity: 'product',
      displayColumn: 'product_name',
      displayValues: expect.arrayContaining(['product_0']),
      resultFingerprint: 'e'.repeat(64),
    })]);
    expect(stored.result?.memberSets?.[0]?.displayValues).toHaveLength(24);
    expect(stored.result?.resultFingerprint).toBe('f'.repeat(64));
    expect(stored.result?.rowCount).toBe(2);
    expect(stored.contract).toEqual({ measures: ['revenue'], dimensions: ['category'] });
    expect(stored.sourceCertifiedBlock).toBe('food_vs_drink_revenue');
    expect(stored.runStatus).toBe('completed');
    expect(stored.stopReason).toBe('certified_answer_found');
    expect(stored.contextPackId).toBe('ctx_abc');
    expect(stored.knowledgeLens).toEqual({
      mode: 'pinned', activeDomainId: 'commerce', skillRefs: ['commerce::skill::revenue'],
      snapshotId: 'snapshot-1', capsuleFingerprint: 'capsule-1',
    });
    expect(stored.cascade).toMatchObject({
      terminalLane: 'semantic',
      routeTier: 'semantic_metric',
      outcome: {
        lane: 'semantic',
        metrics: ['revenue'],
        dimensions: ['category'],
      },
    });
    expect(stored.dqlArtifact).toMatchObject({
      kind: 'semantic_block',
      name: 'food_vs_drink_revenue',
      metrics: ['revenue'],
      dimensions: ['category'],
      source: expect.stringContaining('metric = "revenue"'),
      orderBy: [{ name: 'revenue', direction: 'desc' }],
      limit: 10,
      parameters: [expect.objectContaining({
        name: 'region',
        binding: { kind: 'semantic_filter', field: 'customer.region', operator: 'equals' },
      })],
      parameterValues: { region: 'North America' },
      persistence: 'transient',
      trustState: 'governed',
      compiledSql: expect.stringContaining('SELECT category'),
      executionReceipt: {
        sourceFingerprint: 'a'.repeat(64),
        compiledSqlFingerprint: 'b'.repeat(64),
        parameterFingerprint: 'c'.repeat(64),
        resultFingerprint: 'd'.repeat(64),
      },
    });
  });

  it('aggregates tier distribution across threads', () => {
    const t1 = store.createThread();
    const t2 = store.createThread();
    store.appendTurn(t1.id, { question: 'a', cascade: { terminalLane: 'certified', routeTier: 'certified_block', label: 'x', outcome: { lane: 'certified', routeTier: 'certified_block', executionStatus: 'executed' } } });
    store.appendTurn(t1.id, { question: 'b', cascade: { terminalLane: 'semantic', routeTier: 'semantic_metric', label: 'x', outcome: { lane: 'semantic', routeTier: 'semantic_metric' } } });
    store.appendTurn(t2.id, { question: 'c', cascade: { terminalLane: 'semantic', routeTier: 'semantic_metric', label: 'x', outcome: { lane: 'semantic', routeTier: 'semantic_metric' } } });
    store.appendTurn(t2.id, { question: 'd', cascade: { terminalLane: 'generated', routeTier: 'generated_sql', label: 'x', outcome: { lane: 'generated', routeTier: 'generated_sql', hasSqlPreview: true, executionStatus: 'executed' } } });

    const dist = store.tierDistribution();
    expect(dist.total).toBe(4);
    expect(dist.byRouteTier).toMatchObject({ certified_block: 1, semantic_metric: 2, generated_sql: 1 });
    expect(dist.byTerminalLane).toMatchObject({ certified: 1, semantic: 2, generated: 1 });
  });

  it('counts only one owner\'s turns when asked for an owner', () => {
    const mine = store.createThread({ ownerId: 'u-priya' });
    const theirs = store.createThread({ ownerId: 'u-dan' });
    store.appendTurn(mine.id, { question: 'a', cascade: { terminalLane: 'certified', routeTier: 'certified_block', label: 'x', outcome: { lane: 'certified', routeTier: 'certified_block' } } });
    store.appendTurn(theirs.id, { question: 'b', cascade: { terminalLane: 'generated', routeTier: 'generated_sql', label: 'x', outcome: { lane: 'generated', routeTier: 'generated_sql' } } });
    expect(store.tierDistribution({ ownerId: 'u-priya' })).toMatchObject({ total: 1, byRouteTier: { certified_block: 1 } });
    expect(store.tierDistribution().total).toBe(2);
  });

  it('searches turns by keyword, scoped to a thread', () => {
    const revenueThread = store.createThread();
    const signupThread = store.createThread();
    store.appendTurn(revenueThread.id, {
      question: 'revenue split between food and drink',
      answerSummary: 'Food and Drink revenue totals.',
    });
    store.appendTurn(signupThread.id, {
      question: 'how many signups last quarter',
      answerSummary: 'Signup counts by month.',
    });

    const hits = store.searchTurns({ query: 'revenue drink', threadId: revenueThread.id });
    expect(hits).toHaveLength(1);
    expect(hits[0].question).toContain('revenue split');

    const crossThread = store.searchTurns({ query: 'signups' });
    expect(crossThread).toHaveLength(1);
    expect(crossThread[0].threadId).toBe(signupThread.id);
  });

  it('updates working state, rolling summary, and the compaction cursor', () => {
    const thread = store.createThread();
    store.updateThreadState(thread.id, {
      workingState: { measures: ['revenue'], topicKey: 'orders|revenue' },
      rollingSummary: 'Q: revenue by category | A: Food/Drink split',
      summaryTurnSeq: 3,
    });
    const loaded = store.getThread(thread.id);
    expect(loaded?.workingState).toEqual({ measures: ['revenue'], topicKey: 'orders|revenue' });
    expect(loaded?.rollingSummary).toContain('Food/Drink');
    expect(loaded?.summaryTurnSeq).toBe(3);
  });

  it('lists non-archived threads by recency and archives on request', () => {
    const a = store.createThread({ title: 'thread a' });
    const b = store.createThread({ title: 'thread b' });
    store.archiveThread(a.id);
    const active = store.listThreads();
    expect(active.map((thread) => thread.id)).toEqual([b.id]);
    const all = store.listThreads({ includeArchived: true });
    expect(all).toHaveLength(2);
  });

  it("lists only one notebook's Notebook AI conversations when asked", () => {
    const here = store.createThread({ surface: 'notebook', title: 'Fix this query', notebookPath: 'notebooks/stores.dqlnb' });
    store.createThread({ surface: 'notebook', title: 'Elsewhere', notebookPath: 'notebooks/other.dqlnb' });
    store.createThread({ surface: 'ask', title: 'An Ask chat' });
    expect(store.listThreads({ notebookPath: 'notebooks/stores.dqlnb' }).map((thread) => thread.id)).toEqual([here.id]);
    expect(store.listThreads()).toHaveLength(3);
  });

  it('permanently deletes a thread, its turns, and its search index entries', () => {
    const thread = store.createThread({ surface: 'ask', title: 'Delete me' });
    store.appendTurn(thread.id, {
      question: 'Show permanently deleted revenue history',
      answerSummary: 'This result must not return after refresh.',
    });

    expect(store.searchTurns({ query: 'permanently deleted', threadId: thread.id })).toHaveLength(1);
    expect(store.deleteThread(thread.id)).toBe(true);
    expect(store.getThread(thread.id)).toBeNull();
    expect(store.recentTurns(thread.id)).toEqual([]);
    expect(store.searchTurns({ query: 'permanently deleted' })).toEqual([]);
    expect(store.deleteThread(thread.id)).toBe(false);
  });

  it('returns turns for compaction between the cursor and the recent window', () => {
    const thread = store.createThread();
    for (let i = 1; i <= 6; i++) {
      store.appendTurn(thread.id, { question: `question ${i}` });
    }
    // Cursor at 1, recent window starts at seq 5 → compact turns 2..4.
    const compactable = store.turnsForCompaction(thread.id, 1, 5);
    expect(compactable.map((turn) => turn.seq)).toEqual([2, 3, 4]);
  });

  it('prunes archived threads older than the cutoff', () => {
    const thread = store.createThread();
    store.appendTurn(thread.id, { question: 'old question' });
    store.archiveThread(thread.id);
    // Archived just now — a 0-day cutoff prunes anything archived before "now".
    const pruned = store.pruneThreads(-1);
    expect(pruned).toBe(1);
    expect(store.getThread(thread.id)).toBeNull();
    expect(store.searchTurns({ query: 'old question' })).toHaveLength(0);
  });
});

describe('renaming and pinning a conversation', () => {
  function store(): { store: ConversationStore; threadId: string } {
    const root = mkdtempSync(join(tmpdir(), 'dql-thread-meta-'));
    const conversations = new ConversationStore(join(root, 'c.sqlite'));
    return { store: conversations, threadId: conversations.createThread({ surface: 'ask' }).id };
  }

  it('renames a thread', () => {
    const { store: s, threadId } = store();
    expect(s.renameThread(threadId, '  Q3 pipeline review  ')).toBe(true);
    expect(s.getThread(threadId)?.title).toBe('Q3 pipeline review');
  });

  it('clears the title when renamed to blank', () => {
    const { store: s, threadId } = store();
    s.renameThread(threadId, 'something');
    s.renameThread(threadId, '   ');
    expect(s.getThread(threadId)?.title).toBeUndefined();
  });

  it('reports false for an unknown thread', () => {
    const { store: s } = store();
    expect(s.renameThread('thr_missing', 'x')).toBe(false);
    expect(s.setThreadFavorite('thr_missing', true)).toBe(false);
  });

  // Renaming or pinning is housekeeping. Bumping `updated_at` would jump the
  // thread to the top of a recency-ordered list and reshuffle the sidebar under
  // the user's cursor.
  it('does not change recency', () => {
    const { store: s, threadId } = store();
    const before = s.getThread(threadId)!.updatedAt;
    s.renameThread(threadId, 'renamed');
    s.setThreadFavorite(threadId, true);
    expect(s.getThread(threadId)!.updatedAt).toBe(before);
  });

  it('lists pinned conversations first, then by recency', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-thread-order-'));
    const s = new ConversationStore(join(root, 'c.sqlite'));
    const older = s.createThread({ surface: 'ask', title: 'older' }).id;
    const newer = s.createThread({ surface: 'ask', title: 'newer' }).id;
    s.appendTurn(newer, { question: 'q' });      // makes `newer` the most recent
    s.setThreadFavorite(older, true);

    expect(s.listThreads({ limit: 10 }).map((thread) => thread.id)).toEqual([older, newer]);
    expect(s.getThread(older)?.favorite).toBe(true);
    expect(s.getThread(newer)?.favorite).toBe(false);
  });
});
