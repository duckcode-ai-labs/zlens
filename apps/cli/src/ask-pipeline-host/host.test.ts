import { answeredArtifactTitle } from './host.js';
import { describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@zlens/agent';
import type { ConnectionConfig } from '@zlens/connectors';
import { buildVocabularyIndex, classifyWarehouseError, createAgentRunBudget, parseIntent, physicalRelationBinding, type AnalyticalIntentV1 } from '@zlens/agent';
import { SemanticLayer, type DQLManifest } from '@zlens/core';
import { preferredJoinHints, resultShapeForReview, preferredJoinLine, skillsForDraft, mentionsName, joinHintUsed, hintsForQuestion, joinsAnyRelation, sharedKeyPair, relationsFromCatalogHits, missingFieldWords, relationsWithColumnWords, columnProbeBudgetMs, columnsForPhysicalEntry, connectionKey, physicalRelationName, relationColumnsProbeSql, relationDatabases, relationsFromProbeRows, relevantRelationsForQuestion, snowflakeShowColumnsRows, underAskedNames, coverageEvaluations, governedCoverageDoubt, effectiveAnsweredTrust, withJoinTrust, createAskPipelineRouteExecutor, explainOutOfScope, explainOutOfScopeWords, gapPresentation, groundIntentLiterals, knownMissingRelation, memberCandidatesSql, normalizeExecutedRow, prepareBlockForAsk, recordRelationEvidence, resetRelationEvidence, runtimeSchemaForVocabulary, toExecutorResult, tracedProbes, vocabularyViewKey } from './host.js';

function scripted(replies: string[]): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  return {
    name: 'ollama',
    calls,
    available: async () => true,
    generate: async (messages) => { calls.push(messages); return replies[Math.min(calls.length - 1, replies.length - 1)] ?? ''; },
  };
}

const conversation = JSON.stringify({
  version: 1, kind: 'conversation', reading: 'A greeting.', reply: 'Hello! Ask me about the governed data.',
  measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
});
const analytics = JSON.stringify({
  version: 1, kind: 'analytics', reading: 'Total revenue.', measures: [{ ref: 'metric:order_item.revenue' }],
  groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' }, expectedShape: 'scalar',
});

function executorFor(provider: AgentProvider, manifest: unknown) {
  return createAskPipelineRouteExecutor({
    projectRoot: '/tmp/none',
    executor: {} as QueryExecutor,
    resolveConnection: async () => { throw new Error('No database connection is configured yet. Open Connections, add a warehouse or local DuckDB/file connection, then retry.'); },
    getSemanticLayer: () => undefined,
    getManifest: () => ({ manifest: manifest as never, snapshotId: 'snapshot:test' }),
    selectProvider: async () => provider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
}

const run = (executor: ReturnType<typeof createAskPipelineRouteExecutor>, question: string) => executor({
  runId: 'run-1', request: { question, requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
});

describe('a ref outside the envelope is explained as out of scope, never as nonexistent (Codex E02)', () => {
  const inventory = buildVocabularyIndex({
    relations: [
      { schema: 'TRANSFORMED', name: 'team_directory', columns: [{ name: 'team_id', dataType: 'INTEGER' }, { name: 'city', dataType: 'VARCHAR' }], domain: 'nba.games', domains: ['nba.games'] },
      { schema: 'TRANSFORMED', name: 'player_game_facts', columns: [{ name: 'points', dataType: 'INTEGER' }], domain: 'nba.performance', domains: ['nba.performance'] },
    ],
  });
  const problems = [{ path: 'display[0]', message: 'column:TRANSFORMED.team_directory.city is not in the vocabulary' }];
  it('names the owning domain, the scope that lacks it and what admits it — and nothing of its data', () => {
    const explained = explainOutOfScope(problems, inventory, { activeDomain: 'nba.performance', purpose: undefined })!;
    expect(explained.refs).toEqual([{ ref: 'column:TRANSFORMED.team_directory.city', domain: 'nba.games' }]);
    expect(explained.message).toContain('owned by nba.games');
    expect(explained.message).toContain('the nba.performance scope (no purpose given)');
    expect(explained.message).toContain('purpose whose import carries it');
    expect(explained.message).toContain('Nothing outside the scope was read');
    expect(explainOutOfScope(problems, inventory, { activeDomain: 'nba.performance', purpose: 'player_team_reporting' })!.message).toContain('for purpose player_team_reporting');
  });
  it('a word of the question or of the gap that names an object another domain owns is explained the same way; words in scope are not', () => {
    const scoped = buildVocabularyIndex({ relations: [{ schema: 'TRANSFORMED', name: 'player_game_facts', columns: [{ name: 'points', dataType: 'INTEGER' }], domain: 'nba.performance' }] });
    const explained = explainOutOfScopeWords('show the top five team cities by total player points; no city label or dimension is defined for it', inventory, scoped, { activeDomain: 'nba.performance' })!;
    expect(explained.refs).toEqual([{ ref: 'column:TRANSFORMED.team_directory.city', domain: 'nba.games' }]);
    expect(explained.message).toContain('"city" (column:TRANSFORMED.team_directory.city, owned by nba.games)');
    expect(explained.message).toContain('not in the nba.performance scope (no purpose given)');
    expect(explainOutOfScopeWords('total player points by team', inventory, scoped, { activeDomain: 'nba.performance' })).toBeUndefined();
  });
  it('a word of the question or of the gap that names an object another domain owns is explained the same way; words in scope are not', () => {
    const scoped = buildVocabularyIndex({ relations: [{ schema: 'TRANSFORMED', name: 'player_game_facts', columns: [{ name: 'points', dataType: 'INTEGER' }], domain: 'nba.performance' }] });
    const explained = explainOutOfScopeWords('show the top five team cities by total player points; no city label or dimension is defined for it', inventory, scoped, { activeDomain: 'nba.performance' })!;
    expect(explained.refs).toEqual([{ ref: 'column:TRANSFORMED.team_directory.city', domain: 'nba.games' }]);
    expect(explained.message).toContain('"city" (column:TRANSFORMED.team_directory.city, owned by nba.games)');
    expect(explained.message).toContain('not in the nba.performance scope (no purpose given)');
    expect(explainOutOfScopeWords('total player points by team', inventory, scoped, { activeDomain: 'nba.performance' })).toBeUndefined();
  });
  it('a ref the whole inventory does not hold stays an unknown ref', () => {
    expect(explainOutOfScope([{ path: 'measures[0]', message: 'metric:nowhere.thing is not in the vocabulary' }], inventory, { activeDomain: 'nba.performance' })).toBeUndefined();
    expect(explainOutOfScope([{ path: 'groupBy', message: 'the question asks for a total, not a breakdown' }], inventory, { activeDomain: null as never })).toBeUndefined();
  });
  it('coverage evaluations: an unapplied restriction warns, a mentioned word informs, neither passes', () => {
    const evaluations = coverageEvaluations({ uncovered: ['team_won', 'losses'], coverage: [{ word: 'team_won', state: 'unsatisfied' }, { word: 'losses', state: 'uncertain' }] });
    expect(evaluations.map((item) => [item.id, item.severity, item.passed])).toEqual([['pipeline-coverage', 'warning', false], ['pipeline-coverage-uncertain', 'info', false]]);
    expect(evaluations[0]!.message).toContain('restricts on "team_won"');
    expect(evaluations[1]!.message).toContain('may cover it under another');
    expect(coverageEvaluations({ uncovered: ['x'] })[0]!.severity).toBe('info');
    expect(coverageEvaluations({})).toEqual([]);
  });

  it('a governed label needs every thing and condition the question names, not every measure name', () => {
    // A thing the reading left out: the label goes.
    expect(governedCoverageDoubt({ coverage: [{ word: 'premium', state: 'uncertain', names: ['relation', 'entity'] }] }).reasons).toEqual(['"premium"']);
    // A restriction the reading did not apply: the label goes.
    expect(governedCoverageDoubt({ coverage: [{ word: 'team_won', state: 'unsatisfied', names: ['column'] }] }).reasons).toEqual(['"team_won"']);
    // A competing measure the reading chose not to use, and a listed facet: the label stays.
    expect(governedCoverageDoubt({ coverage: [{ word: 'revenue', state: 'uncertain', names: ['metric'] }], unmet: [{ obligation: 'coverage', message: 'this answer carries nothing for "tax"' }] }).reasons).toEqual([]);
    // A requested identity the answer could not carry: the label goes.
    expect(governedCoverageDoubt({ unmet: [{ obligation: 'display_label', message: 'the rows carry no team name' }] }).reasons).toEqual(['the rows carry no team name']);
  });

  it('downgrades every answer trust field when governed coverage is incomplete', () => {
    expect(effectiveAnsweredTrust({ certified: false, reviewRequired: false, coverageDoubt: true })).toEqual({
      trustState: 'review_required',
      certification: 'review_required',
      reviewStatus: 'review_required',
      stopReason: 'generated_review_required',
    });
    expect(effectiveAnsweredTrust({ certified: false, reviewRequired: false, coverageDoubt: false }).certification).toBe('governed');
    expect(effectiveAnsweredTrust({ certified: true, reviewRequired: false, coverageDoubt: true }).trustState).toBe('certified');
  });

  it('a governed answer downgraded for coverage says review required in the payload, the run and the result alike', () => {
    const intent = { version: 1, kind: 'analytics', reading: 'Total amount.', measures: [{ ref: 'metric:ins.amount' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {} } as unknown as AnalyticalIntentV1;
    const outcome = (uncovered: string[]) => ({
      kind: 'answered', intent, text: 'Total amount is 10.',
      result: { columns: ['amount'], rows: [{ amount: 10 }], rowCount: 1, executionTimeMs: 1 },
      candidate: { tier: 'semantic', trust: 'governed', sql: 'SELECT SUM(amount) AS amount FROM ins.claims', proof: [] },
      receipt: { version: 1, vocabularyFingerprint: 'test', dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, uncovered, coverage: uncovered.map((word) => ({ word, state: 'unsatisfied' })) },
    }) as unknown as Parameters<typeof toExecutorResult>[1];
    const downgraded = toExecutorResult('run:coverage', outcome(['premium']), Date.now());
    const payload = downgraded.artifacts![0]!.payload as Record<string, unknown> & { result: { trustState: string } };
    expect(downgraded).toMatchObject({ trustState: 'review_required', stopReason: 'generated_review_required', resolvedRoute: 'semantic_answer' });
    // No field may go on calling it governed; the route still says where it came from.
    expect(payload).toMatchObject({ trustState: 'review_required', certification: 'review_required', reviewStatus: 'review_required', sourceTier: 'semantic_layer' });
    expect(payload.result.trustState).toBe('review_required');
    const governed = toExecutorResult('run:governed', outcome([]), Date.now());
    expect(governed).toMatchObject({ trustState: 'governed', stopReason: 'governed_semantic_answer' });
    expect(governed.artifacts![0]!.payload).toMatchObject({ trustState: 'governed', certification: 'governed', reviewStatus: 'governed' });
  });

  // From Metrics means certified joins (2026-10-23: "How many large orders did
  // each location get?" joined orders to locations through the draft
  // order_to_location and was labelled Governed).
  it('a semantic answer through an uncertified join is labelled for review, keeps its semantic source, and says which join', () => {
    const intent = { version: 1, kind: 'analytics', reading: 'Large orders by location.', measures: [{ ref: 'metric:orders.large_orders' }], groupBy: [], display: [], filters: [], expectedShape: 'grouped', unresolved: [], provenance: {} } as unknown as AnalyticalIntentV1;
    const caveat = 'Orders → locations joins through relationship "order_to_location", which is draft, not certified. Certify the relationship in Modeling, with warehouse validation, for a From Metrics answer.';
    const outcome = {
      kind: 'answered', intent, text: 'Large orders by location.',
      result: { columns: ['location_name', 'large_orders'], rows: [{ location_name: 'Philadelphia', large_orders: 12 }], rowCount: 1, executionTimeMs: 1 },
      candidate: { tier: 'semantic', trust: 'review_required', trustCaveat: caveat, sql: 'SELECT 1', proof: [`joins: ${caveat}`] },
      receipt: { version: 1, vocabularyFingerprint: 'test', dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, uncovered: [], coverage: [] },
    } as unknown as Parameters<typeof toExecutorResult>[1];
    const run = toExecutorResult('run:draft-join', outcome, Date.now());
    const card = run.artifacts![0]!;
    expect(run).toMatchObject({ trustState: 'review_required', resolvedRoute: 'semantic_answer' });
    expect(card).toMatchObject({ title: 'Answer to review, from governed definitions', trustState: 'review_required' });
    // No AI wrote this SQL: never routed or titled as AI-drafted.
    expect(card.payload).toMatchObject({ route: { tier: 'semantic_metric' }, sourceTier: 'semantic_layer', certification: 'review_required' });
    expect(run.evaluations?.find((evaluation) => evaluation.id === 'pipeline-governed-joins')?.message).toContain('order_to_location');
  });

  it('a semantic compile is judged on the joins it took against the DQL relationships', () => {
    const relationship = { id: 'r', localId: 'order_to_location', qualifiedId: 'commerce::relationship::order_to_location', from: 'order', to: 'location', keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'many_to_one', fanout: 'safe', status: 'draft' };
    const manifest = {
      dbtProvenance: { nodes: { 'model.j.orders': { relation: '"j"."dev"."orders"' }, 'model.j.locations': { relation: '"j"."dev"."locations"' } } },
      modeling: { entities: { order: { dbtUniqueId: 'model.j.orders' }, location: { dbtUniqueId: 'model.j.locations' } }, relationships: { r: relationship } },
    } as unknown as DQLManifest;
    const joinPath = [{ left: 'orders', right: 'locations', leftTable: '"j"."dev"."orders"', rightTable: '"j"."dev"."locations"', keys: [{ from: 'location_id', to: 'location_id' }] }];
    const judged = withJoinTrust({ sql: 'SELECT 1', engine: 'native', joinPath }, manifest);
    expect(judged.joinTrust?.certified).toBe(false);
    expect(judged.joinTrust?.caveat).toContain('order_to_location');
    expect(withJoinTrust({ sql: 'SELECT 1', engine: 'native', joinPath: [] }, manifest).joinTrust).toEqual({ certified: true });
    // An engine that reports no joins is not judged here.
    expect(withJoinTrust({ sql: 'SELECT 1', engine: 'metricflow-cli' }, manifest).joinTrust).toBeUndefined();
  });

  // Launch blocker: an App Ask ("What is beverage revenue by product?" on the
  // jaffle Growth Review App) served the certified beverage block as evidence.
  // The run said governed, the card said "Certified block answer" and the
  // heading said "AI-generated answer".
  it('a certified block served as evidence is titled by the same trust decision as the run, never "certified" unless the run is', () => {
    const intent = { version: 1, kind: 'analytics', reading: 'Beverage revenue by product.', measures: [{ ref: 'metric:commerce.revenue' }], groupBy: [], display: [], filters: [], expectedShape: 'table', unresolved: [], provenance: {} } as unknown as AnalyticalIntentV1;
    const outcome = (uncovered: string[]) => ({
      kind: 'answered', intent, text: 'Beverage revenue by product.',
      result: { columns: ['product_name', 'beverage_revenue'], rows: [{ product_name: 'vanilla ice', beverage_revenue: 84474 }], rowCount: 1, executionTimeMs: 1 },
      candidate: { tier: 'certified', trust: 'governed', sql: 'SELECT 1', sourceRef: 'block:commerce.beverage_revenue_by_product', proof: [] },
      receipt: { version: 1, vocabularyFingerprint: 'test', dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, uncovered, coverage: uncovered.map((word) => ({ word, state: 'unsatisfied' })) },
    }) as unknown as Parameters<typeof toExecutorResult>[1];
    const governed = toExecutorResult('run:evidence', outcome([]), Date.now());
    const governedCard = governed.artifacts![0]!;
    expect(governed.trustState).toBe('governed');
    expect(governedCard).toMatchObject({ title: 'Answer from a certified saved query, not certified for this question', trustState: 'governed' });
    expect(governedCard.payload).toMatchObject({ route: { tier: 'certified_block' }, sourceTier: 'certified_artifact', certification: 'governed' });
    const doubted = toExecutorResult('run:evidence-doubt', outcome(['beverage']), Date.now());
    const doubtedCard = doubted.artifacts![0]!;
    expect(doubted.trustState).toBe('review_required');
    expect(doubtedCard).toMatchObject({ title: 'Answer to review, from a certified saved query', trustState: 'review_required' });
    for (const card of [governedCard, doubtedCard]) expect(card.title).not.toMatch(/^Certified|AI-/);
  });

  it('every answer title follows the trust decision', () => {
    expect(answeredArtifactTitle('certified', 'certified_block')).toBe('Certified answer');
    expect(answeredArtifactTitle('review_required', 'ai_sql')).toBe('AI-drafted answer');
    expect(answeredArtifactTitle('governed', 'governed_definitions')).toBe('Semantic answer');
    expect(answeredArtifactTitle('review_required', 'governed_definitions')).toBe('Answer to review, from governed definitions');
    expect(answeredArtifactTitle('governed', 'block_as_evidence')).toBe('Answer from a certified saved query, not certified for this question');
    expect(answeredArtifactTitle('review_required', 'block_as_evidence')).toBe('Answer to review, from a certified saved query');
  });
});

describe('a Snowflake relation is addressed with its database (Codex: the relational route dropped it)', () => {
  const manifest = { dbtProvenance: { nodes: { 'model.p.header': { relation: '"ANALYTICS"."CONSUMPTION_METRICS"."HEADER"' }, 'model.p.two': { relation: 'consumption_metrics.two' } } } };
  it('provenance names the database; the vocabulary name is completed only on Snowflake and only when known', () => {
    const databases = relationDatabases(manifest as never);
    expect(databases.get('consumption_metrics.header')).toBe('"ANALYTICS"');
    expect(physicalRelationName('consumption_metrics.header', databases, 'snowflake')).toBe('"ANALYTICS".consumption_metrics.header');
    expect(physicalRelationName('consumption_metrics.two', databases, 'snowflake')).toBe('consumption_metrics.two');
    expect(physicalRelationName('consumption_metrics.header', databases, 'duckdb')).toBe('consumption_metrics.header');
  });
});

describe('request-local runtime schema keeps same-tail Snowflake columns apart', () => {
  it('never gives DB_A.PUBLIC.EVENTS the columns admitted for DB_B.PUBLIC.EVENTS', () => {
    const relation = (database: string, column: string) => ({
      schema: 'PUBLIC', name: 'EVENTS', columns: [{ name: column, dataType: 'NUMBER' }], columnCompleteness: 'complete' as const,
      binding: physicalRelationBinding({
        logicalRelation: 'PUBLIC.EVENTS', physicalRelation: `${database}.PUBLIC.EVENTS`,
        source: 'warehouse_probe', columnCompleteness: 'complete', columns: [{ name: column, type: 'NUMBER' }],
      }),
    });
    const vocabulary = buildVocabularyIndex({ relations: [relation('DB_A', 'A_ONLY'), relation('DB_B', 'B_ONLY')] });
    const runtime = runtimeSchemaForVocabulary(vocabulary);
    expect(runtime.find((entry) => entry.relation === 'DB_A.PUBLIC.EVENTS')?.columns.map((column) => column.name)).toEqual(['A_ONLY']);
    expect(runtime.find((entry) => entry.relation === 'DB_B.PUBLIC.EVENTS')?.columns.map((column) => column.name)).toEqual(['B_ONLY']);
    const dbA = vocabulary.entries.find((entry) => entry.kind === 'relation' && entry.physical?.binding?.database?.value === 'DB_A');
    expect(columnsForPhysicalEntry(vocabulary, dbA).map((column) => column.name)).toEqual(['A_ONLY']);
  });

  it('hands semantic compilation the hydrated selected target binding and current vocabulary', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'event_total', label: 'Event total', description: '', domain: 'events',
        sql: 'event_value', type: 'sum', metricType: 'simple', table: 'PUBLIC.EVENTS',
      }],
      dimensions: [],
    });
    const connection: ConnectionConfig = { driver: 'snowflake', account: 'acct', database: 'DB_B', schema: 'PUBLIC', role: 'ANALYST', warehouse: 'WH' };
    const provider = scripted([JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Event total.', measures: [{ ref: 'metric:event_total' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:event_total': 'q:event total' }, expectedShape: 'scalar',
    })]);
    const executeQuery = vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return {
          columns: [], rowCount: 1, executionTimeMs: 1,
          rows: [{ table_catalog: 'DB_B', table_schema: 'PUBLIC', table_name: 'EVENTS', column_name: 'EVENT_VALUE', data_type: 'NUMBER', ordinal_position: 1, dql_column_total: 1 }],
        };
      }
      return { columns: ['event_total'], rowCount: 1, executionTimeMs: 1, rows: [{ event_total: 7 }] };
    });
    let context: { snapshotId: string; executionTargetFingerprint: string; vocabulary: ReturnType<typeof buildVocabularyIndex>; physicalBindings: Array<{ database?: { value: string }; table: { value: string }; columns: Array<{ name: string }> }> } | undefined;
    const executor = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-selected-target',
      executor: { executeQuery } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => semanticLayer,
      getManifest: () => ({
        snapshotId: 'snapshot:selected-db-b',
        manifest: {
          sources: {
            events: {
              name: 'EVENTS', origin: 'dbt', referencedBy: [],
              dbtModel: { uniqueId: 'model.events', schema: 'PUBLIC', columns: { EVENT_VALUE: { name: 'EVENT_VALUE', type: 'NUMBER' } } },
            },
          },
        } as never,
      }),
      selectProvider: async () => provider,
      semanticEngine: async () => 'native',
      compileSemantic: async (_request, _connection, compileContext) => {
        context = compileContext as typeof context;
        return { sql: 'SELECT 7 AS event_total', engine: 'native' };
      },
      priorIntent: () => undefined,
    });

    await executor({
      runId: 'run:selected-target', request: { question: 'What is event total?', requestedMode: 'ask' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });

    expect(context?.snapshotId).toBe('snapshot:selected-db-b');
    expect(context?.vocabulary.entries.some((entry) => entry.kind === 'column' && entry.name === 'EVENT_VALUE')).toBe(true);
    expect(context?.physicalBindings).toHaveLength(1);
    expect(context?.physicalBindings[0]).toMatchObject({ database: { value: 'DB_B' }, table: { value: 'EVENTS' }, columns: [{ name: 'EVENT_VALUE' }] });
  });
});

describe('the column probe is bounded', () => {
  it('returns a probed relation under the name it asked for, so the warehouse spelling merges into the manifest relation', () => {
    const named = underAskedNames([{ schema: 'CONSUMPTION_METRICS', name: 'HEADER', columns: [{ name: 'TOTAL_BCM', dataType: 'NUMBER' }] }, { schema: 'OTHER', name: 'THING', columns: [] }], ['consumption_metrics.header']);
    expect(named[0]).toMatchObject({ schema: 'consumption_metrics', name: 'header' });
    expect(named[0]!.columns[0]!.name).toBe('TOTAL_BCM');
    expect(named[1]).toMatchObject({ schema: 'OTHER', name: 'THING' });
  });
  it('has a default budget and an override', () => {
    expect(columnProbeBudgetMs({})).toBe(12_000);
    expect(columnProbeBudgetMs({ ZLENS_ASK_COLUMN_PROBE_MS: '3000' })).toBe(3_000);
    expect(columnProbeBudgetMs({ ZLENS_ASK_COLUMN_PROBE_MS: 'nope' })).toBe(12_000);
  });
});

describe('question-directed relation discovery', () => {
  it('hydrates semantic filter and time homes instead of letting repeated wide-model prose consume all three slots', () => {
    const source = {
      relations: [
        {
          schema: 'TRANSFORMED', name: 'fct_player_journey', columnCompleteness: 'partial' as const,
          // A wide season table repeats these words across many descriptions.
          description: 'Player season totals: points scored and games played. Player points scored and games played.',
          columns: [
            { name: 'total_points', description: 'Points scored by the player in games played.' },
            { name: 'games_played', description: 'Games played by the player.' },
          ],
        },
        {
          schema: 'TRANSFORMED', name: 'local_player_season_facts', columnCompleteness: 'partial' as const,
          description: 'Player-season aggregate from participated player-game rows.',
          columns: [{ name: 'games_played' }],
        },
        {
          schema: 'TRANSFORMED', name: 'local_player_game_facts', columnCompleteness: 'partial' as const,
          // The manifest has only keys and participated. `player_name`,
          // `is_home`, and points must be discovered before Ask can bind them.
          description: 'Player-game fact; participated player rows.',
          columns: [{ name: 'game_id' }, { name: 'player_id' }, { name: 'participated' }],
        },
        {
          schema: 'TRANSFORMED', name: 'local_team_game_facts', columnCompleteness: 'partial' as const,
          description: 'Team-game fact with home and away rows.',
          columns: [{ name: 'game_id' }, { name: 'is_home' }],
        },
      ],
      dimensions: [
        {
          name: 'game_date', model: 'local_player_game_facts', label: 'Game date', dataType: 'date', isTime: true,
          physical: { relation: 'TRANSFORMED.local_player_game_facts', column: 'game_date' },
        },
        {
          name: 'is_home', model: 'local_team_game_facts', label: 'Home game', dataType: 'boolean',
          physical: { relation: 'TRANSFORMED.local_team_game_facts', column: 'is_home' },
        },
      ],
    };

    const selected = relevantRelationsForQuestion(
      source,
      'For Stephen Curry, show games played and points scored by month in calendar 2017, only home games in which he participated.',
    );

    expect(selected).toHaveLength(3);
    expect(selected).toEqual(expect.arrayContaining([
      'TRANSFORMED.local_player_game_facts',
      'TRANSFORMED.local_team_game_facts',
    ]));
  });

  it('keeps a partial physical metric home when a lexical decoy also matches', () => {
    const source = {
      relations: [
        {
          schema: 'PUBLIC', name: 'FACT', columnCompleteness: 'partial' as const,
          // The manifest only documented a key. `amount` and `event_date`
          // belong to this relation through the semantic layer and must cause
          // it to be hydrated even though its current text has no lexical hit.
          columns: [{ name: 'id' }],
          binding: physicalRelationBinding({
            logicalRelation: 'PUBLIC.FACT', physicalRelation: 'DB_A.PUBLIC.FACT',
            source: 'dbt_manifest', columnCompleteness: 'partial', columns: [{ name: 'id' }],
          }),
        },
        {
          schema: 'PUBLIC', name: 'DECOY', columnCompleteness: 'partial' as const,
          description: 'Revenue overview for a different operational feed.',
          columns: [{ name: 'id' }],
          binding: physicalRelationBinding({
            logicalRelation: 'PUBLIC.DECOY', physicalRelation: 'DB_A.PUBLIC.DECOY',
            source: 'dbt_manifest', columnCompleteness: 'partial', columns: [{ name: 'id' }],
          }),
        },
      ],
      metrics: [{
        name: 'revenue', model: 'fact', label: 'Revenue', description: '',
        physical: { relation: 'PUBLIC.FACT', column: 'amount' },
      }],
      dimensions: [{
        name: 'metric_time', model: 'fact', label: 'Metric time', description: '', dataType: 'date', isTime: true,
        physical: { relation: 'PUBLIC.FACT', column: 'event_date' },
      }],
    } as never;

    const selected = relevantRelationsForQuestion(source, 'Show revenue by month');

    expect(selected).toEqual(expect.arrayContaining([
      'DB_A.PUBLIC.FACT',
      'DB_A.PUBLIC.DECOY',
    ]));
  });
});

describe('a column is found by the words of its name', () => {
  it('COMPETITOR_C is found by the word competitor', () => {
    const source = {
      relations: [
        { schema: 'sales', name: 'opportunity_enhanced', columnCompleteness: 'partial' as const, columns: [{ name: 'OPPORTUNITY_ID' }, { name: 'AMOUNT' }] },
        { schema: 'sfdc', name: 'opportunity_history', columnCompleteness: 'partial' as const, columns: [{ name: 'ID' }, { name: 'COMPETITOR_C' }] },
      ],
    } as never;
    expect(relevantRelationsForQuestion(source, 'lost deals where the competitor involved is Splunk', 3, { splitNames: true })).toEqual(['sfdc.opportunity_history']);
    // The governed context keeps whole names, so its recorded prompts do not move.
    expect(relevantRelationsForQuestion(source, 'lost deals where the competitor involved is Splunk')).toEqual([]);
  });

  it('the wider look ranks words the question used above words only the decline used', () => {
    const source = {
      relations: [
        { schema: 'crm', name: 'deal_notes', columns: [{ name: 'deal_ref' }, { name: 'rival_vendor', description: 'the competitor named on the deal' }] },
        { schema: 'crm', name: 'accounts', columns: [{ name: 'primary_owner' }] },
        { schema: 'sales', name: 'opportunities', columns: [{ name: 'deal_ref' }] },
      ],
    } as never;
    expect(relationsWithColumnWords(source, missingFieldWords('No competitor column (such as PRIMARY_COMPETITOR) is available'), 'lost to a competitor', ['sales.opportunities'])).toEqual(['crm.deal_notes', 'crm.accounts']);
  });

  it('the wider look also reads what the team wrote about a table, below its columns', () => {
    const source = {
      relations: [
        { schema: 'crm', name: 'deal_party_role', columns: [{ name: 'deal_ref' }, { name: 'party_ref' }, { name: 'role_code' }] },
        { schema: 'crm', name: 'deals', columns: [{ name: 'deal_ref' }, { name: 'amount' }] },
      ],
    } as never;
    const words = missingFieldWords('No listed relation provides the sales rep who closed it');
    // Only the bridge's Modeling context says who closed the deal.
    expect(relationsWithColumnWords(source, words, 'amounts by sales rep', ['crm.deals'])).toEqual([]);
    expect(relationsWithColumnWords(source, words, 'amounts by sales rep', ['crm.deals'], 3, (name) => (name === 'crm.deal_party_role' ? 'Role code SR marks the sales rep who closed it' : undefined))).toEqual(['crm.deal_party_role']);
  });
});

describe('the key a warehouse join proof tests', () => {
  it('pairs a key named for its table with that table id, and keeps same-name keys first', () => {
    expect(sharedKeyPair(['OPPORTUNITY_ID', 'AMOUNT'], ['ID', 'COMPETITOR_C'], 'SFDC.OPPORTUNITY')).toEqual({ from: 'OPPORTUNITY_ID', to: 'ID' });
    expect(sharedKeyPair(['customer_id', 'amount'], ['id', 'name'], 'dev.customers')).toEqual({ from: 'customer_id', to: 'id' });
    expect(sharedKeyPair(['customer_id', 'amount'], ['customer_id', 'id'], 'dev.customers')).toEqual({ from: 'customer_id', to: 'customer_id' });
    expect(sharedKeyPair(['account_id'], ['id'], 'SFDC.OPPORTUNITY')).toBeUndefined();
    expect(sharedKeyPair(['opportunity_id'], ['name'], 'SFDC.OPPORTUNITY')).toBeUndefined();
  });
});

describe('an approved hint about one thing stays with that thing', () => {
  const capitalOne = { title: 'Capital One customer filter', guidance: 'For Capital One, filter NR_CUSTOMER_ID through fpa_netsuite2.customer COMPANYNAME.', lesson: { rule: "Resolve Capital One by UPPER(COMPANYNAME) = 'CAPITAL ONE'." } };
  const general = { title: 'Revenue is pretax', guidance: 'Unqualified revenue means pretax product revenue.', lesson: { rule: 'Use the revenue metric unless the question says gross.' } };
  it('leaves a hint that names a value out of a question that never mentions it, and keeps general hints', () => {
    expect(hintsForQuestion([capitalOne, general], 'what is the total ignored usage')).toEqual([general]);
    expect(hintsForQuestion([capitalOne, general], 'total ignored usage for Capital One')).toEqual([capitalOne, general]);
  });
});

describe('a restriction has to reach the facts', () => {
  const columns: Record<string, string[]> = {
    'sales.opportunity_enhanced': ['OPPORTUNITY_ID', 'AMOUNT', 'IS_WON'],
    'sfdc.opportunity': ['ID', 'COMPETITOR_C'],
    'nr_silver_nrdb_dl_stg.competitor_agent_analysis_v2': ['ANALYSIS_ID', 'COMPETITOR_NAME', 'WIN_RATE'],
    'raw.undocumented': [],
  };
  const columnsOf = (relation: string) => columns[relation] ?? [];
  it('keeps a table that shares a key with the reading, drops a look-alike that cannot join, and never rules out an undocumented one', () => {
    const anchors = ['sales.opportunity_enhanced'];
    expect(joinsAnyRelation('sfdc.opportunity', anchors, columnsOf)).toBe(true);
    expect(joinsAnyRelation('nr_silver_nrdb_dl_stg.competitor_agent_analysis_v2', anchors, columnsOf)).toBe(false);
    expect(joinsAnyRelation('raw.undocumented', anchors, columnsOf)).toBe(true);
    expect(joinsAnyRelation('nr_silver_nrdb_dl_stg.competitor_agent_analysis_v2', [], columnsOf)).toBe(true);
  });
});

describe('catalog hits are kept only inside the request scope', () => {
  it('maps a documented column to its admitted relation and drops a relation the scope does not admit', () => {
    const scoped = { relations: [
      { schema: 'sfdc', name: 'opportunity', columns: [{ name: 'COMPETITOR_C' }] },
      { schema: 'sales', name: 'opportunity_enhanced', columns: [{ name: 'AMOUNT' }] },
    ] } as never;
    expect(relationsFromCatalogHits([
      { objectType: 'dbt_column', name: 'COMPETITOR_C', relation: 'nr_silver.sfdc.opportunity' },
      { objectType: 'dbt_column', name: 'SECRET', relation: 'finance.payroll' },
      { objectType: 'dbt_model', name: 'opportunity_enhanced', relation: 'sales.opportunity_enhanced' },
    ], scoped, ['sales.opportunity_enhanced'])).toEqual(['sfdc.opportunity']);
  });
});

describe('a question that matches no relation hydrates none', () => {
  it('returns no candidates instead of the alphabetically first partial relations', () => {
    const source = {
      relations: [
        { schema: 'PUBLIC', name: 'AAA_FIRST', columnCompleteness: 'partial' as const, columns: [{ name: 'id' }] },
        { schema: 'PUBLIC', name: 'BBB_SECOND', columnCompleteness: 'partial' as const, columns: [{ name: 'id' }] },
      ],
    } as never;
    expect(relevantRelationsForQuestion(source, 'what is the % DOD ACM value?')).toEqual([]);
  });
});

describe('the Ask host uses AgentRunBudget remaining duration at every boundary', () => {
  it('hydrates metadata and reaches SQL with positive relative deadlines from a duration budget', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'event_total', label: 'Event total', description: '', domain: 'events',
        sql: 'event_value', type: 'sum', metricType: 'simple', table: 'PUBLIC.EVENTS',
      }],
      dimensions: [],
    });
    const connection: ConnectionConfig = { driver: 'snowflake', account: 'acct', database: 'DB_B', schema: 'PUBLIC', role: 'ANALYST', warehouse: 'WH' };
    const provider = scripted([JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Event total.', measures: [{ ref: 'metric:event_total' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:event_total': 'q:event total' }, expectedShape: 'scalar',
    })]);
    const metadataDeadlines: number[] = [];
    const executionDeadlines: number[] = [];
    const executeQuery = vi.fn(async (
      sql: string,
      _params: unknown[],
      _variables: Record<string, unknown>,
      _connection: ConnectionConfig,
      options?: { deadlineMs?: number },
    ) => {
      // SHOW COLUMNS is asked first on Snowflake; this warehouse double does not answer it.
      if (/^SHOW COLUMNS IN /.test(sql)) {
        metadataDeadlines.push(options?.deadlineMs ?? 0);
        return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      }
      if (sql.includes('information_schema.columns')) {
        metadataDeadlines.push(options?.deadlineMs ?? 0);
        return {
          columns: [], rowCount: 1, executionTimeMs: 1,
          rows: [{ table_catalog: 'DB_B', table_schema: 'PUBLIC', table_name: 'EVENTS', column_name: 'EVENT_VALUE', data_type: 'NUMBER', ordinal_position: 1, dql_column_total: 1 }],
        };
      }
      executionDeadlines.push(options?.deadlineMs ?? 0);
      return { columns: ['event_total'], rowCount: 1, executionTimeMs: 1, rows: [{ event_total: 7 }] };
    });
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-budget-duration',
      executor: { executeQuery } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => semanticLayer,
      getManifest: () => ({
        snapshotId: 'snapshot:budget-duration',
        manifest: {
          sources: {
            events: {
              name: 'EVENTS', origin: 'dbt', referencedBy: [],
              dbtModel: { uniqueId: 'model.events', schema: 'PUBLIC', columns: { EVENT_VALUE: { name: 'EVENT_VALUE', type: 'NUMBER' } } },
            },
          },
        } as never,
      }),
      selectProvider: async () => provider,
      semanticEngine: async () => 'native',
      compileSemantic: async () => ({ sql: 'SELECT 7 AS event_total', engine: 'native' }),
      priorIntent: () => undefined,
    });
    const budget = createAgentRunBudget({ requestedMode: 'ask' });
    expect(budget.hardDeadlineMs).toBeGreaterThan(0);
    expect(budget.remainingMs()).toBeGreaterThan(0);

    const result = await route({
      runId: 'run:budget-duration',
      request: { question: 'What is event total?', requestedMode: 'ask', runBudget: budget, signal: budget.hardSignal } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });

    expect(result.status).toBe('completed');
    expect(metadataDeadlines).toHaveLength(2);
    expect(metadataDeadlines.every((deadline) => deadline > 0)).toBe(true);
    expect(executionDeadlines).toHaveLength(1);
    expect(executionDeadlines[0]).toBeGreaterThan(0);
  });

  it('does not begin interpretation once the real run budget has expired and its hard signal is aborted', async () => {
    const expired = new AbortController();
    expired.abort(new Error('deadline elapsed'));
    const budget = createAgentRunBudget({
      requestedMode: 'ask',
      startedAtMs: 0,
      nowMs: () => 1_000_000,
      inheritedSignal: expired.signal,
      timeoutSignal: () => expired.signal,
    });
    const provider = scripted([conversation]);
    const result = await executorFor(provider, undefined)({
      runId: 'run:expired-budget',
      request: { question: 'hello', requestedMode: 'ask', runBudget: budget, signal: budget.hardSignal } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });

    expect(budget.remainingMs()).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(result.status).toBe('blocked');
    expect(result.askPipelineReceipt?.failure).toMatchObject({ reason: 'cancelled' });
  });
});

describe('the projected vocabulary is keyed by the whole envelope selection', () => {
  const pack = { skills: [], appliedHints: [], eligible: undefined, domainBriefing: undefined };
  const envelope = (purpose: string | undefined, imports: Array<{ providerDomain: string; exportRef: string; purpose: string }>) => ({ activeDomain: 'consumer', purpose, modelAreaId: undefined, allowedImports: imports, descendants: [] });
  it('a different purpose, and therefore a different export, is a different key', () => {
    const identity = vocabularyViewKey('base', envelope('identity_lookup', [{ providerDomain: 'provider', exportRef: 'provider:provider_identity@1.0.0', purpose: 'identity_lookup' }]), pack);
    const orders = vocabularyViewKey('base', envelope('order_reporting', [{ providerDomain: 'provider', exportRef: 'provider:provider_orders@1.0.0', purpose: 'order_reporting' }]), pack);
    expect(identity).not.toBe(orders);
    expect(vocabularyViewKey('base', envelope('identity_lookup', [{ providerDomain: 'provider', exportRef: 'provider:provider_identity@1.0.0', purpose: 'identity_lookup' }]), pack)).toBe(identity);
    expect(vocabularyViewKey('base', envelope(undefined, []), pack)).not.toBe(identity);
  });
});

describe('the pipeline host without a warehouse', () => {
  it('answers a conversational turn with one interpreter send and no connection', async () => {
    const provider = scripted([conversation]);
    const result = await run(executorFor(provider, undefined), 'hi');
    expect(result.status).toBe('completed');
    expect(result.resolvedRoute).toBe('conversation');
    expect(result.answer).toBe('Hello! Ask me about the governed data.');
    expect(provider.calls).toHaveLength(1);
  });
  it('reports the missing connection verbatim only when a prepared query would execute', async () => {
    const manifest = {
      sources: [{ schema: 'dev', name: 'order_items', columns: [{ name: 'product_price', dataType: 'DOUBLE' }] }],
      blocks: [],
    };
    const provider = scripted([JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Total product price.', measures: [{ ref: 'column:dev.order_items.product_price', aggregation: 'sum' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
    }), analytics]);
    const result = await run(executorFor(provider, manifest), 'total product price');
    // Either the relational tier prepared and execution named the missing
    // connection, or no tier could prepare without a semantic layer; in
    // neither case did interpretation itself need a warehouse.
    expect(result.status).toBe('blocked');
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
    const receipt = result.askPipelineReceipt;
    expect(receipt).toBeDefined();
    if (receipt?.failure?.stage === 'execute') expect(receipt.failure.message).toMatch(/No database connection is configured yet/);
  });
});

describe('a gap is headed by what it is', () => {
  it('no matching data is not a modeling gap', () => {
    expect(gapPresentation('not_retrieved')).toEqual({ title: 'No matching data for that period', code: 'no_data' });
    // The heading names what came back empty, not always the period.
    expect(gapPresentation('not_retrieved', 'no rows matched "Totally Imaginary Person" on the warehouse').title).toBe('No matching data for that name');
    expect(gapPresentation('not_retrieved', 'no rows matched the restriction on is_drink_item').title).toBe('No matching data under those filters');
    expect(gapPresentation('not_retrieved', 'no rows fell inside the window 2030-01-01..2031-01-01').title).toBe('No matching data for that period');
    expect(gapPresentation('not_modeled').code).toBe('modeling_gap');
    expect(gapPresentation('unsupported')).toEqual({ title: 'No answer', code: 'modeling_gap' });
    expect(gapPresentation('denied').code).toBe('policy_blocked');
    expect(gapPresentation('ambiguous').code).toBe('ambiguous');
  });
});

describe('member literal grounding', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'revenue', model: 'order_item', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } }],
    dimensions: [
      { name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } },
      { name: 'customer_type', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_type' } },
    ],
    entities: [{ name: 'customer', model: 'customers', type: 'primary', physical: { relation: 'dev.customers', column: 'customer_id' } }],
  });
  const intent = (filters: AnalyticalIntentV1['filters']): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters, unresolved: [], provenance: {}, expectedShape: 'scalar' });
    if (!parsed.intent) throw new Error('bad intent');
    return parsed.intent;
  };
  const connection = { driver: 'duckdb' } as ConnectionConfig;
  const probes: string[] = [];
  const deps = {
    literalProbeAllowed: (relation: string, column: string) => `${relation}.${column}` === 'dev.customers.customer_name',
    probeLiteral: async (_relation: string, column: string, value: string) => {
      probes.push(`${column}=${value}`);
      return value.toLowerCase() === 'ryan byrd' ? ['Ryan Byrd'] : [];
    },
  };
  it('replaces a literal with its stored casing on an allowlisted column and says so', async () => {
    const grounded = await groundIntentLiterals(intent([{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan byrd'], source: 'question' }]), vocabulary, connection, deps);
    expect(grounded.intent.filters[0]!.values).toEqual(['Ryan Byrd']);
    expect(grounded.notes).toEqual(['customer_name: "Ryan byrd" is stored as "Ryan Byrd"']);
  });
  it('records an absent member and never probes a column outside the allowlist', async () => {
    probes.length = 0;
    const grounded = await groundIntentLiterals(intent([
      { ref: 'dimension:customers.customer_name', op: 'eq', values: ['Nobody Here'], source: 'question' },
      { ref: 'dimension:customers.customer_type', op: 'eq', values: ['returning'], source: 'question' },
    ]), vocabulary, connection, deps);
    expect(grounded.intent.filters.map((filter) => filter.values)).toEqual([['Nobody Here'], ['returning']]);
    expect(grounded.notes).toEqual(['customer_name: no stored value matches "Nobody Here"']);
    expect(probes).toEqual(['customer_name=Nobody Here']);
  });
});

describe('identity behind a label', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'lifetime_spend', model: 'customers', aggregation: 'sum', physical: { relation: 'dev.customers', expr: '"dev"."customers"."lifetime_spend"', aggregate: 'sum' } }],
    dimensions: [{ name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } }],
    entities: [{ name: 'customer', model: 'customers', type: 'primary', physical: { relation: 'dev.customers', column: 'customer_id' } }],
  });
  const connection = { driver: 'duckdb' } as ConnectionConfig;
  const ask = (name: string): AnalyticalIntentV1 => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:customers.lifetime_spend' }], groupBy: [], display: [], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: [name], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
  const members: Record<string, Array<{ key: string; label: string }>> = { 'jordan lee': [{ key: 'a', label: 'Jordan Lee' }, { key: 'b', label: 'Jordan Lee' }], 'ryan byrd': [{ key: 'r', label: 'Ryan Byrd' }] };
  const probed: string[] = [];
  const deps = {
    literalProbeAllowed: (relation: string, column: string) => `${relation}.${column}` === 'dev.customers.customer_name',
    probeLiteral: async (_relation: string, _column: string, value: string) => members[value.toLowerCase()]?.map((member) => member.label).slice(0, 1) ?? [],
    probeLabelKeys: async (_relation: string, key: string, label: string, value: string) => { probed.push(`${key}/${label}=${value}`); return members[value.toLowerCase()] ?? []; },
  };
  it('several keys behind one name make the answer one row per member, keyed, with the name displayed', async () => {
    const grounded = await groundIntentLiterals(ask('jordan lee'), vocabulary, connection, deps);
    expect(grounded.intent.groupBy).toEqual([{ ref: 'entity:customers.customer', role: 'key' }]);
    expect(grounded.intent.display).toEqual(['dimension:customers.customer_name']);
    expect(grounded.intent.expectedShape).toBe('grouped');
    expect(grounded.intent.filters[0]!.values).toEqual(['Jordan Lee']);
    expect(grounded.notes).toContain('identity: 2 customers share the name "Jordan Lee"; one row per customer, keyed by customer_id');
    expect(grounded.intent.provenance['entity:customers.customer']).toMatch(/host:2 customers share/);
  });
  it('one key leaves the scalar alone and says whom it identifies; a column outside the allowlist is never probed', async () => {
    probed.length = 0;
    const one = await groundIntentLiterals(ask('ryan byrd'), vocabulary, connection, deps);
    expect(one.intent.groupBy).toEqual([]);
    expect(one.notes).toContain('identity: "Ryan Byrd" identifies one customer');
    const closed = await groundIntentLiterals(ask('jordan lee'), vocabulary, connection, { ...deps, literalProbeAllowed: () => false });
    expect(closed.intent.groupBy).toEqual([]);
    expect(probed).toEqual(['customer_id/customer_name=Ryan Byrd']);
  });
});

describe('executed rows', () => {
  it('calendar cells become ISO instants so narration, persistence and the table read one value', () => {
    const row = normalizeExecutedRow({ month: new Date('2025-03-01T00:00:00.000Z'), revenue: 12.5, name: 'Ryan Byrd', empty: null });
    expect(row).toEqual({ month: '2025-03-01T00:00:00.000Z', revenue: 12.5, name: 'Ryan Byrd', empty: null });
    const untouched = { revenue: 1 };
    expect(normalizeExecutedRow(untouched)).toBe(untouched);
  });
});

describe('physical trace spans', () => {
  it('a value probe is one search_values tool span carrying fingerprints only, and a failed probe finishes as an error', async () => {
    const spans: string[] = [];
    const connection = { driver: 'duckdb' } as ConnectionConfig;
    const request = { question: 'q', requestedMode: 'ask' } as AgentRunRequest;
    const probes = tracedProbes({
      literalProbeAllowed: () => true,
      probeLiteral: async () => ['Ryan Byrd'],
      probeLabelKeys: async () => { throw new Error('boom'); },
      traceExecution: (_request, span) => { spans.push(span.name === 'tool.call' ? `${span.name}:${span.toolKind}:${span.inputFingerprint.length}` : span.name); return { finish: (outcome, extra) => { spans.push(`finish:${outcome}${extra?.safeErrorCode ? `:${extra.safeErrorCode}` : ''}`); } }; },
    }, request);
    expect(await probes.probeLiteral!('dev.customers', 'customer_name', 'ryan byrd', connection)).toEqual(['Ryan Byrd']);
    await expect(probes.probeLabelKeys!('dev.customers', 'customer_id', 'customer_name', 'ryan byrd', connection)).rejects.toThrow('boom');
    expect(spans).toEqual(['tool.call:search_values:24', 'finish:ok', 'tool.call:search_values:24', 'finish:error:probe_failure']);
    // Without a tracer the deps are handed through untouched.
    const plain = { literalProbeAllowed: () => true, probeLiteral: async () => [] };
    expect(tracedProbes(plain, request)).toBe(plain);
  });
});

describe('a certified block is compiled and bound like every other surface runs it', () => {
  const blockSource = `// dql-format: 1
block "top_players" {
  domain = "nba"
  type = "custom"
  status = "certified"
  description = "Top players by points between two calendar years."
  owner = "x"
  outputs = ["player_name", "total_points"]
  params {
    season_start = 2016
    season_end = 2017
    top_n = 5
  }
  query = """
    SELECT player_name, SUM(pts) AS total_points FROM dev.player_game_stats
    WHERE CAST(strftime('%Y', game_date) AS INTEGER) BETWEEN \${season_start} AND \${season_end}
    GROUP BY player_name ORDER BY total_points DESC LIMIT \${top_n}
  """
}
`;
  it('binds declared defaults and values the question states, in placeholder order, and leaves no template', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'dql-block-'));
    mkdirSync(join(root, 'blocks'), { recursive: true });
    writeFileSync(join(root, 'blocks', 'top_players.dql'), blockSource);
    const entry = { ref: 'block:nba.top_players', kind: 'block', name: 'top_players', aliases: [], roles: [], sourcePath: 'blocks/top_players.dql', contract: { outputs: ['player_name', 'total_points'], measures: [], groupBy: [], staticScope: [], allowedFilters: [], parameters: ['season_start', 'season_end', 'top_n'], structural: true } } as never;
    const prepared = prepareBlockForAsk(root, entry, { question: 'Top 3 players by points in 2016 and 2017' }, 'sqlite');
    expect(prepared && 'sql' in prepared ? prepared.sql : prepared).toMatch(/BETWEEN \$1 AND \$2[\s\S]*LIMIT \$3/);
    if (!prepared || !('sql' in prepared)) return;
    expect(prepared.sql).not.toMatch(/\$\{/);
    expect(prepared.params).toEqual([2016, 2017, 3]);
    expect(prepared.parameters.map((parameter) => `${parameter.name}:${parameter.source}`)).toEqual(['season_start:question', 'season_end:question', 'top_n:question']);
    const defaults = prepareBlockForAsk(root, entry, { question: 'who are the top players' }, 'sqlite');
    expect(defaults && 'params' in defaults ? defaults.params : defaults).toEqual([2016, 2017, 5]);
  });
  it('a block without a declaration on disk is usable only when it has no parameters', () => {
    const plain = { ref: 'block:x.plain', kind: 'block', name: 'plain', aliases: [], roles: [], sql: 'SELECT 1 AS one' } as never;
    expect(prepareBlockForAsk('/nowhere', plain, {})).toEqual({ sql: 'SELECT 1 AS one', params: [], parameters: [] });
    const templated = { ref: 'block:x.t', kind: 'block', name: 't', aliases: [], roles: [], sql: 'SELECT 1 WHERE y = ${limit}' } as never;
    expect(prepareBlockForAsk('/nowhere', templated, {})).toMatchObject({ error: expect.stringMatching(/not available/) });
  });
});

describe('a connection remembers what it cannot see', () => {
  const key = 'snowflake|acme|ANALYTICS';
  it('a relation the warehouse denied once is refused before the next query, and a success forgets it', () => {
    resetRelationEvidence();
    const sql = 'SELECT COUNT(*) FROM "ANALYTICS"."DEV"."FCT_PLAYER_JOURNEY" AS j JOIN "ANALYTICS"."DEV"."GAMES" g ON g.id = j.id';
    expect(knownMissingRelation(key, sql)).toBeUndefined();
    recordRelationEvidence(key, sql, classifyWarehouseError("Object 'ANALYTICS.DEV.FCT_PLAYER_JOURNEY' does not exist."), "Object 'ANALYTICS.DEV.FCT_PLAYER_JOURNEY' does not exist.");
    expect(knownMissingRelation(key, sql)).toBe('ANALYTICS.DEV.FCT_PLAYER_JOURNEY');
    // Another connection knows nothing about it.
    expect(knownMissingRelation('duckdb|jaffle', sql)).toBeUndefined();
    // The same table under a different qualifier is the same table.
    expect(knownMissingRelation(key, 'SELECT 1 FROM dev.fct_player_journey')).toBe('ANALYTICS.DEV.FCT_PLAYER_JOURNEY');
    recordRelationEvidence(key, 'SELECT 1 FROM dev.fct_player_journey');
    expect(knownMissingRelation(key, sql)).toBeUndefined();
  });
  it('a failure that names no single relation teaches nothing, and a syntax error is never a missing table', () => {
    resetRelationEvidence();
    recordRelationEvidence(key, 'SELECT 1 FROM a.b JOIN a.c ON TRUE', classifyWarehouseError('SQL compilation error: object does not exist'));
    expect(knownMissingRelation(key, 'SELECT 1 FROM a.b')).toBeUndefined();
    recordRelationEvidence(key, 'SELECT 1 FROM a.b', classifyWarehouseError('SQL compilation error: syntax error line 1 at position 7'));
    expect(knownMissingRelation(key, 'SELECT 1 FROM a.b')).toBeUndefined();
  });
  it('does not turn Snowflake’s ambiguous missing-or-not-authorized wording into cached absence', () => {
    resetRelationEvidence();
    const sql = 'SELECT 1 FROM "ANALYTICS"."DEV"."FCT_PLAYER_JOURNEY"';
    const message = "Object 'ANALYTICS.DEV.FCT_PLAYER_JOURNEY' does not exist or not authorized.";
    recordRelationEvidence(key, sql, classifyWarehouseError(message), message);
    expect(knownMissingRelation(key, sql)).toBeUndefined();
  });
  it('the key is the account and database, never a credential', () => {
    const config = { driver: 'snowflake', account: 'acme', database: 'ANALYTICS', schema: 'DEV', username: 'svc', password: 'secret', token: 'tok' } as ConnectionConfig;
    const composed = connectionKey(config);
    expect(composed).toContain('acme');
    expect(composed).toContain('ANALYTICS');
    expect(composed).not.toContain('secret');
    expect(composed).not.toContain('tok');
  });
});

describe('the members a name could mean', () => {
  it('reads the column the query already filtered, bounded and case-insensitively', () => {
    const sql = memberCandidatesSql('TRANSFORMED.local_player_game_facts', 'player_name', (name) => `"${name}"`);
    expect(sql).toContain('FROM "TRANSFORMED"."local_player_game_facts"');
    expect(sql).toContain('LOWER(CAST("player_name" AS VARCHAR)) LIKE ?');
    expect(sql).toContain('LIMIT 7');
    expect(sql).toContain('DISTINCT');
    // The exact spelling in other capitals comes first, inside the limit.
    expect(sql).toContain('ORDER BY LENGTH(CAST("player_name" AS VARCHAR)), 1');
  });
  it('keeps a quoted dot inside a physical database identifier', () => {
    const sql = memberCandidatesSql('"Db.With.Dot"."Public"."Events"', 'EventId', (name) => `"${name}"`);
    expect(sql).toContain('FROM "Db.With.Dot"."Public"."Events"');
    expect(sql).not.toContain('"Db"."With"."Dot"');
  });
});

describe('Snowflake physical metadata identity', () => {
  it('keeps quoted dotted databases separate in probes and never chooses an ambiguous short alias', () => {
    const sql = relationColumnsProbeSql([
      '"Db.With.Dot"."Public"."Events"',
      'DB_B.PUBLIC.EVENTS',
    ])!;
    expect(sql).toContain('FROM "Db.With.Dot".information_schema.columns');
    expect(sql).toContain('FROM DB_B.information_schema.columns');
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain("table_catalog");

    const databases = relationDatabases({
      dbtProvenance: {
        nodes: {
          a: { relation: 'DB_A.PUBLIC.EVENTS' },
          b: { relation: 'DB_B.PUBLIC.EVENTS' },
        },
      },
    });
    expect(databases.size).toBe(0);
    expect(physicalRelationName('PUBLIC.EVENTS', databases, 'snowflake')).toBe('PUBLIC.EVENTS');
  });

  it('keeps the relation identity while using the local information schema for DuckDB', () => {
    const sql = relationColumnsProbeSql(['MAIN.PUBLIC.EVENTS'], 1, 0, 'duckdb')!;
    expect(sql).toContain('FROM information_schema.columns');
    expect(sql).not.toContain('FROM MAIN.information_schema.columns');
    expect(sql).toContain("'MAIN' AS table_catalog");
  });

  it('reads SQLite columns from its pragmas, for every attached schema, with no catalog', async () => {
    const sql = relationColumnsProbeSql(['main.cards', 'dev.orders'], 2, 0, 'sqlite')!;
    expect(sql).not.toContain('CURRENT_DATABASE');
    expect(sql).not.toContain('information_schema.columns');
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE cards (id INTEGER, name TEXT, type TEXT); ATTACH DATABASE ':memory:' AS dev; CREATE TABLE dev.orders (order_id INTEGER, amount REAL)`);
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`)).toEqual([
      'dev.orders.order_id', 'dev.orders.amount', 'main.cards.id', 'main.cards.name', 'main.cards.type',
    ]);
    expect(rows.every((row) => row.table_catalog === null && row.dql_column_total !== undefined)).toBe(true);
    const relations = relationsFromProbeRows(rows, true, 0);
    expect(relations.find((relation) => relation.name === 'cards')).toMatchObject({ columnCompleteness: 'complete' });
    db.close();
  });

  it('maps a probe result only to the exact requested database and keys cache evidence by role', () => {
    const [mapped] = underAskedNames([
      { database: 'DB_A', schema: 'PUBLIC', name: 'EVENTS', columns: [{ name: 'EVENT_ID', dataType: 'NUMBER' }], columnCompleteness: 'partial' },
    ], ['DB_A.PUBLIC.EVENTS', 'DB_B.PUBLIC.EVENTS']);
    expect(mapped?.binding?.database?.value).toBe('DB_A');
    expect(mapped?.binding?.table.value).toBe('EVENTS');
    const base = { driver: 'snowflake', account: 'acme', database: 'DB_A', schema: 'PUBLIC', warehouse: 'WH', username: 'analyst' } as ConnectionConfig;
    expect(connectionKey({ ...base, role: 'ROLE_A' })).not.toBe(connectionKey({ ...base, role: 'ROLE_B' }));
  });

  it('marks metadata completeness per relation and carries an exact page cursor', () => {
    const rows = [
      ...Array.from({ length: 800 }, (_, index) => ({ table_catalog: 'DB_A', table_schema: 'PUBLIC', table_name: 'EVENTS', column_name: `A_${index}`, data_type: 'NUMBER', dql_column_total: 801 })),
      { table_catalog: 'DB_B', table_schema: 'PUBLIC', table_name: 'EVENTS', column_name: 'B_ONLY', data_type: 'NUMBER', dql_column_total: 1 },
    ];
    const relations = relationsFromProbeRows(rows);
    expect(relations.find((relation) => relation.database === 'DB_A')).toMatchObject({ columnCompleteness: 'partial', truncated: true });
    expect(relations.find((relation) => relation.database === 'DB_B')).toMatchObject({ columnCompleteness: 'complete' });
    expect(relationColumnsProbeSql(['DB_A.PUBLIC.EVENTS'], 1, 800)).toContain('dql_column_page > 800');
  });
});

describe('the Snowflake column probe asks SHOW COLUMNS first', () => {
  it('maps SHOW COLUMNS rows, including JSON data types, into complete probe relations', () => {
    const rows = snowflakeShowColumnsRows([
      { table_name: 'OPPORTUNITIES', schema_name: 'SALES', column_name: 'AMOUNT', data_type: '{"type":"FIXED","precision":38,"scale":2,"nullable":true}', database_name: 'DB_A' },
      { table_name: 'OPPORTUNITIES', schema_name: 'SALES', column_name: 'STAGE', data_type: '{"type":"TEXT","length":16777216,"nullable":true}', database_name: 'DB_A' },
      { table_name: 'OPPORTUNITIES', schema_name: 'SALES', column_name: 'CLOSE_DATE', data_type: '{"type":"DATE","nullable":true}', database_name: 'DB_A' },
    ]);
    expect(rows.map((row) => [row.table_catalog, row.table_schema, row.table_name, row.column_name, row.data_type, row.dql_column_total])).toEqual([
      ['DB_A', 'SALES', 'OPPORTUNITIES', 'AMOUNT', 'NUMBER(38,2)', 3],
      ['DB_A', 'SALES', 'OPPORTUNITIES', 'STAGE', 'VARCHAR(16777216)', 3],
      ['DB_A', 'SALES', 'OPPORTUNITIES', 'CLOSE_DATE', 'DATE', 3],
    ]);
    const relations = relationsFromProbeRows(rows, true, 0);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ database: 'DB_A', schema: 'SALES', name: 'OPPORTUNITIES', columnCompleteness: 'complete' });
    expect(relations[0]!.columns.map((column) => column.dataType)).toEqual(['NUMBER(38,2)', 'VARCHAR(16777216)', 'DATE']);
  });

  it('hydrates a Snowflake relation with SHOW COLUMNS and never scans information_schema when it answers', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{ name: 'event_total', label: 'Event total', description: '', domain: 'events', sql: 'event_value', type: 'sum', metricType: 'simple', table: 'PUBLIC.EVENTS' }],
      dimensions: [],
    });
    const connection: ConnectionConfig = { driver: 'snowflake', account: 'acct', database: 'DB_B', schema: 'PUBLIC', role: 'ANALYST', warehouse: 'WH' };
    const provider = scripted([JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Event total.', measures: [{ ref: 'metric:event_total' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:event_total': 'q:event total' }, expectedShape: 'scalar',
    })]);
    const statements: string[] = [];
    const executeQuery = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (/^SHOW COLUMNS IN /.test(sql)) {
        return { columns: [], rowCount: 1, executionTimeMs: 1, rows: [{ table_name: 'EVENTS', schema_name: 'PUBLIC', column_name: 'EVENT_VALUE', data_type: '{"type":"FIXED","precision":38,"scale":0}', database_name: 'DB_B' }] };
      }
      if (sql.includes('information_schema.columns')) throw new Error('information_schema must not be scanned when SHOW COLUMNS answered');
      return { columns: ['event_total'], rowCount: 1, executionTimeMs: 1, rows: [{ event_total: 7 }] };
    });
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-show-columns',
      executor: { executeQuery } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => semanticLayer,
      getManifest: () => ({
        snapshotId: 'snapshot:show-columns',
        manifest: { sources: { events: { name: 'EVENTS', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.events', schema: 'PUBLIC', columns: { EVENT_VALUE: { name: 'EVENT_VALUE', type: 'NUMBER' } } } } } } as never,
      }),
      selectProvider: async () => provider,
      semanticEngine: async () => 'native',
      compileSemantic: async () => ({ sql: 'SELECT 7 AS event_total', engine: 'native' }),
      priorIntent: () => undefined,
    });
    const result = await route({
      runId: 'run:show-columns',
      request: { question: 'What is event total?', requestedMode: 'ask' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });
    expect(result.status).toBe('completed');
    // The connection's database qualifies the relation, so SHOW asks the exact object.
    expect(statements.filter((sql) => /^SHOW COLUMNS IN /.test(sql))).toEqual(['SHOW COLUMNS IN DB_B.PUBLIC.EVENTS']);
    expect(statements.some((sql) => sql.includes('information_schema.columns'))).toBe(false);
    expect(result.askPipelineReceipt?.physicalBindings?.find((binding) => /EVENTS$/i.test(binding.relation))?.completeness).toBe('complete');
  });
});

describe('an out-of-scope ref spelled with the wrong kind and a schema is still explained', () => {
  // The fixture holds the city as a DIMENSION of the team directory; the model
  // wrote it as a schema-qualified COLUMN. The owning domain is still known.
  const inventory = buildVocabularyIndex({
    dimensions: [{ name: 'city', model: 'team_directory', label: 'City', dataType: 'string', physical: { relation: 'TRANSFORMED.dim_teams_cleansed', column: 'city' } }],
    relations: [{ schema: 'TRANSFORMED', name: 'dim_teams_cleansed', columns: [], domain: 'nba.games', domains: ['nba.games'] }],
  });
  it('finds the dimension by its dotted tail and names its owning domain', () => {
    const explained = explainOutOfScope([{ path: 'display[0]', message: 'column:TRANSFORMED.team_directory.city is not in the vocabulary' }], inventory, { activeDomain: 'nba.performance', purpose: undefined })!;
    expect(explained.refs).toEqual([{ ref: 'column:TRANSFORMED.team_directory.city', domain: 'nba.games' }]);
    expect(explained.message).toContain('owned by nba.games');
  });
  it('never guesses from a bare field name on a relation nobody holds', () => {
    expect(explainOutOfScope([{ path: 'display[0]', message: 'column:TRANSFORMED.nowhere.city is not in the vocabulary' }], inventory, { activeDomain: 'nba.performance', purpose: undefined })).toBeUndefined();
  });
});

describe('a run that cannot reach an AI model says so, with its story', () => {
  it('keeps the specific reason and a failed step instead of a generic sentence', async () => {
    const executor = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/none', executor: {} as QueryExecutor,
      resolveConnection: async () => { throw new Error('unused'); },
      getSemanticLayer: () => undefined,
      getManifest: () => ({ manifest: {} as never, snapshotId: 'snapshot:no-provider' }),
      selectProvider: async () => undefined,
      compileSemantic: async () => { throw new Error('unused'); },
      priorIntent: () => undefined,
    });
    const result = await run(executor, 'total revenue');
    expect(result.answer).toContain('No AI model is configured');
    expect(result.askPipelineReceipt?.story).toEqual([expect.objectContaining({ title: 'No AI provider is connected', state: 'failed', detail: expect.stringContaining('No AI model is configured') })]);
    // No model ran, so the run says so: nothing may label it AI-generated (round 3).
    expect(result.artifacts?.[0]).toEqual(expect.objectContaining({ title: 'Ask needs an AI provider', payload: expect.objectContaining({ providerMissing: true, refusalCode: 'provider_error' }) }));
    expect((result.artifacts?.[0]?.payload as Record<string, unknown>).executionError).toBeUndefined();
  });
});

describe('the schema lane on the host: no governed reading, the AI drafts SQL from the tables it inspects', () => {
  const connection: ConnectionConfig = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
  const manifest = { sources: { opportunities: { name: 'opportunities', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.opportunities', schema: 'sales', columns: { opportunity_id: { name: 'opportunity_id' }, stage: { name: 'stage' }, competitor: { name: 'competitor' }, amount: { name: 'amount' } } } } } };
  const unreadable = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Lost deals to a competitor.', measures: [{ ref: 'metric:crm.lost_deal_count' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
  const drafter = (draft: string): AgentProvider & { draftPrompts: string[] } => {
    const draftPrompts: string[] = [];
    return {
      name: 'ollama', draftPrompts, available: async () => true,
      generate: async (messages) => {
        if (messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) { draftPrompts.push(messages.map((message) => message.content).join('\n')); return draft; }
        return unreadable;
      },
    };
  };
  const routeFor = (provider: AgentProvider, statements: string[]) => createAskPipelineRouteExecutor({
    projectRoot: '/tmp/ask-schema-lane',
    executor: { executeQuery: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('information_schema.columns')) {
        return { columns: [], rowCount: 4, executionTimeMs: 1, rows: ['opportunity_id', 'stage', 'competitor', 'amount'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: column === 'amount' ? 'DOUBLE' : 'VARCHAR' })) };
      }
      return { columns: ['lost_deals'], rowCount: 1, executionTimeMs: 1, rows: [{ lost_deals: 12 }] };
    }) } as unknown as QueryExecutor,
    resolveConnection: async () => connection,
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: 'snapshot:schema-lane', manifest: manifest as never }),
    selectProvider: async () => provider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
  const ask = (route: ReturnType<typeof createAskPipelineRouteExecutor>) => route({
    runId: 'run:schema-lane',
    request: { question: 'How many opportunities did we lose to Splunk?', requestedMode: 'ask' } as AgentRunRequest,
    route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
  });

  it('drafts one statement over the inspected opportunities table, runs it, and labels the answer review-required', async () => {
    const provider = drafter("SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(stage) = 'closed lost' AND LOWER(competitor) = 'splunk'");
    const statements: string[] = [];
    const result = await ask(routeFor(provider, statements));
    expect(provider.draftPrompts).toHaveLength(1);
    expect(provider.draftPrompts[0]).toContain('WHY NO GOVERNED ANSWER');
    expect(provider.draftPrompts[0]).toContain('competitor');
    expect(statements.some((sql) => sql.includes('FROM sales.opportunities WHERE'))).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.askPipelineReceipt?.executed?.tier).toBe('exploratory');
    expect(result.answer).toContain('written by AI from the schema');
    expect(result.artifacts?.find((artifact) => artifact.kind === 'answer')?.title).toBe('AI-drafted answer');
    expect(result.trustState).toBe('review_required');
  });

  it('a drafted statement that leaves out a value the question states is fixed once, then run with a row guard', async () => {
    const provider = drafter('');
    const prompts: string[] = [];
    provider.generate = async (messages) => {
      if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
      prompts.push(messages.map((message) => message.content).join('\n'));
      return prompts.length === 1
        ? "SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(stage) = 'closed lost'"
        : "SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(stage) = 'closed lost' AND LOWER(competitor) = 'splunk'";
    };
    const statements: string[] = [];
    const result = await ask(routeFor(provider, statements));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('NOTE: The previous statement was not run because it does not apply "Splunk" from the question');
    expect(statements.filter((sql) => !sql.includes('information_schema'))).toEqual([
      "SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(stage) = 'closed lost' AND LOWER(competitor) = 'splunk'\nLIMIT 501",
    ]);
    expect(result.status).toBe('completed');
    expect(result.answer).toContain("it filters on LOWER(stage) = 'closed lost' AND LOWER(competitor) = 'splunk'");
    // The run keeps what each drafting call was for and what it returned, and
    // the checks as verdicts: a failed stated-value check, then a passing one.
    const drafts = (result.askPipelineReceipt?.dispatches ?? []).filter((dispatch) => dispatch.purpose === 'intent:draft');
    expect(drafts.map((dispatch) => [dispatch.label, dispatch.outcome])).toEqual([['draft', 'sql'], ['fix', 'sql']]);
    expect(drafts[1]!.reply).toContain("LOWER(competitor) = 'splunk'");
    const stated = (result.askPipelineReceipt?.checks ?? []).filter((check) => check.id === 'stated_values');
    expect(stated.map((check) => [check.attempt, check.passed])).toEqual([[1, false], [2, true]]);
    expect(stated[0]!.message).toContain('"Splunk"');
  });

  it('a statement rejected for a column the table does not have is corrected once, with the reason', async () => {
    const provider = drafter('');
    const prompts: string[] = [];
    provider.generate = async (messages) => {
      if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
      prompts.push(messages.map((message) => message.content).join('\n'));
      return prompts.length === 1
        ? "SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(rival_vendor) = 'splunk'"
        : "SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(stage) = 'closed lost' AND LOWER(competitor) = 'splunk'";
    };
    const statements: string[] = [];
    const result = await ask(routeFor(provider, statements));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('NOTE: The previous statement was rejected before running: the drafted SQL');
    expect(result.status).toBe('completed');
  });

  it('a value the draft keeps leaving out is refused, named, and never run', async () => {
    const provider = drafter("SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(stage) = 'closed lost'");
    const statements: string[] = [];
    const result = await ask(routeFor(provider, statements));
    expect(provider.draftPrompts).toHaveLength(2);
    expect(statements.every((sql) => sql.includes('information_schema'))).toBe(true);
    expect(result.status).not.toBe('completed');
    expect(JSON.stringify(result)).toContain('failed a check: it does not apply \\"Splunk\\" from the question');
  });

  it('a decline over the first tables searches every table for the missing field, adds it, and drafts again', async () => {
    const wide = { sources: {
      opportunities: { name: 'opportunities', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.opportunities', schema: 'sales', columns: { opportunity_id: { name: 'opportunity_id' }, deal_ref: { name: 'deal_ref' }, stage: { name: 'stage' } } } },
      deal_notes: { name: 'deal_notes', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.deal_notes', schema: 'crm', columns: { deal_ref: { name: 'deal_ref' }, rival_vendor: { name: 'rival_vendor', description: 'the competitor named on the deal' } } } },
    } };
    const prompts: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return prompts.length === 1
          ? 'NO_SQL: No competitor column is available in sales.opportunities.'
          : "SELECT COUNT(*) AS lost_deals FROM sales.opportunities o JOIN crm.deal_notes d ON d.deal_ref = o.deal_ref WHERE LOWER(o.stage) = 'closed lost' AND LOWER(d.rival_vendor) = 'splunk'";
      },
    };
    const statements: string[] = [];
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-schema-lane-wide',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        statements.push(sql);
        // A join key that does not repeat on either side: the probe returns no rows.
        if (/HAVING COUNT\(\*\) > 1/.test(sql)) return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
        if (sql.includes('information_schema.columns')) {
          const rows = [
            ...(/'opportunities'/.test(sql) ? ['opportunity_id', 'deal_ref', 'stage'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: 'VARCHAR' })) : []),
            ...(/'deal_notes'/.test(sql) ? ['deal_ref', 'rival_vendor'].map((column) => ({ table_schema: 'crm', table_name: 'deal_notes', column_name: column, data_type: 'VARCHAR' })) : []),
          ];
          return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
        }
        return { columns: ['lost_deals'], rowCount: 1, executionTimeMs: 1, rows: [{ lost_deals: 4 }] };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:schema-lane-wide', manifest: wide as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
    });
    const result = await ask(route);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('crm.deal_notes');
    expect(prompts[1]).toContain('crm.deal_notes');
    expect(prompts[1]).toContain('NOTE: A first draft over sales.opportunities found no field for this');
    expect(result.status).toBe('completed');
    expect(result.askPipelineReceipt?.story?.some((entry) => entry.title === 'Searched every table for the missing field: found crm.deal_notes')).toBe(true);
    // The second call looked again with more tables; it did not fix a failed check.
    const drafts = (result.askPipelineReceipt?.dispatches ?? []).filter((dispatch) => dispatch.purpose === 'intent:draft');
    expect(drafts.map((dispatch) => [dispatch.label, dispatch.outcome])).toEqual([['draft', 'declined'], ['widen', 'sql']]);
  });

  it('what the user said in the conversation chooses tables and reaches the draft', async () => {
    const wide = { sources: {
      opportunities: { name: 'opportunities', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.opportunities', schema: 'sales', columns: { deal_ref: { name: 'deal_ref' }, stage: { name: 'stage' } } } },
      deal_notes: { name: 'deal_notes', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.deal_notes', schema: 'crm', columns: { deal_ref: { name: 'deal_ref' }, rival_vendor: { name: 'rival_vendor' } } } },
    } };
    const prompts: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return 'NO_SQL: nothing to draft in this test.';
      },
    };
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-schema-lane-context',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        const rows = sql.includes('information_schema.columns') ? [
          ...(/'opportunities'/.test(sql) ? ['deal_ref', 'stage'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: 'VARCHAR' })) : []),
          ...(/'deal_notes'/.test(sql) ? ['deal_ref', 'rival_vendor'].map((column) => ({ table_schema: 'crm', table_name: 'deal_notes', column_name: column, data_type: 'VARCHAR' })) : []),
        ] : [];
        return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:schema-lane-context', manifest: wide as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
      conversation: () => ({ summary: 'The user said the competitor is kept in the deal notes rival vendor field.' }),
    });
    await ask(route);
    expect(prompts[0]).toContain('crm.deal_notes');
    expect(prompts[0]).toContain('CONTEXT:\n- conversation so far: The user said the competitor is kept in the deal notes rival vendor field.');
  });

  it('the catalog search chooses a table the question never names, before anything is drafted', async () => {
    const wide = { sources: {
      opportunities: { name: 'opportunities', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.opportunities', schema: 'sales', columns: { deal_ref: { name: 'deal_ref' }, stage: { name: 'stage' } } } },
      deal_notes: { name: 'deal_notes', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.deal_notes', schema: 'crm', columns: { deal_ref: { name: 'deal_ref' }, rival_vendor: { name: 'rival_vendor' } } } },
    } };
    const prompts: string[] = [];
    const queries: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return 'NO_SQL: nothing to draft in this test.';
      },
    };
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-schema-lane-catalog',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        const rows = sql.includes('information_schema.columns') ? [
          ...(/'opportunities'/.test(sql) ? ['deal_ref', 'stage'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: 'VARCHAR' })) : []),
          ...(/'deal_notes'/.test(sql) ? ['deal_ref', 'rival_vendor'].map((column) => ({ table_schema: 'crm', table_name: 'deal_notes', column_name: column, data_type: 'VARCHAR' })) : []),
        ] : [];
        return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:schema-lane-catalog', manifest: wide as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
      searchCatalog: (_request, _envelope, query) => { queries.push(query); return [{ objectType: 'dbt_column', name: 'rival_vendor', relation: 'crm.deal_notes', description: 'the competitor named on the deal' }]; },
    });
    await ask(route);
    expect(queries[0]).toContain('How many opportunities did we lose to Splunk?');
    expect(prompts[0]).toContain('crm.deal_notes');
  });

  it('a value the question states is looked for in allowlisted text columns, and where it lives reaches the draft', async () => {
    const wide = { sources: {
      opportunities: { name: 'opportunities', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.opportunities', schema: 'sales', columns: { deal_ref: { name: 'deal_ref' }, stage: { name: 'stage' } } } },
      deal_notes: { name: 'deal_notes', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.deal_notes', schema: 'crm', columns: { deal_ref: { name: 'deal_ref' }, tags: { name: 'tags' } } } },
    } };
    const prompts: string[] = [];
    const probed: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return 'NO_SQL: nothing to draft in this test.';
      },
    };
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-schema-lane-values',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        if (sql.includes(' LIKE ')) { probed.push(sql); return { columns: ['hit'], rowCount: 1, executionTimeMs: 1, rows: sql.includes('tags') ? [{ hit: 1 }] : [] }; }
        const rows = sql.includes('information_schema.columns') ? [
          ...(/'opportunities'/.test(sql) ? ['deal_ref', 'stage'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: 'VARCHAR' })) : []),
          ...(/'deal_notes'/.test(sql) ? ['deal_ref', 'tags'].map((column) => ({ table_schema: 'crm', table_name: 'deal_notes', column_name: column, data_type: 'VARCHAR' })) : []),
        ] : [];
        return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:schema-lane-values', manifest: wide as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
      literalProbeAllowed: (_relation, column) => column === 'tags',
    });
    const result = await ask(route);
    expect(probed).toHaveLength(1);
    expect(probed[0]).toMatch(/FROM "?crm"?\."?deal_notes"? WHERE LOWER\(CAST\("?tags"? AS VARCHAR\)\) LIKE '%splunk%'$/);
    expect(prompts[0]).toContain('- the value "Splunk" occurs in crm.deal_notes.tags');
    expect(prompts[0]).toContain('crm.deal_notes');
    expect(result.askPipelineReceipt?.story?.some((entry) => entry.title === 'Found where "Splunk" is stored: crm.deal_notes.tags')).toBe(true);
  });

  it('a governed metric the question names reaches the draft with its definition', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{ name: 'lost_amount', label: 'Lost amount', description: 'Amount on closed lost opportunities', domain: 'sales', sql: 'amount', type: 'sum', metricType: 'simple', table: 'sales.opportunities' }],
      dimensions: [],
    });
    const prompts: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return 'NO_SQL: nothing to draft in this test.';
      },
    };
    const statements: string[] = [];
    const base = routeFor(provider, statements);
    void base;
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-schema-lane-metric',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          return { columns: [], rowCount: 4, executionTimeMs: 1, rows: ['opportunity_id', 'stage', 'competitor', 'amount'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: column === 'amount' ? 'DOUBLE' : 'VARCHAR' })) };
        }
        return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => semanticLayer,
      getManifest: () => ({ snapshotId: 'snapshot:schema-lane-metric', manifest: manifest as never }),
      selectProvider: async () => provider,
      semanticEngine: async () => 'native',
      compileSemantic: async () => { throw new Error('not compiled in this test'); },
      priorIntent: () => undefined,
    });
    await route({
      runId: 'run:schema-lane-metric',
      request: { question: 'What was the lost amount to Splunk?', requestedMode: 'ask' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });
    expect(prompts[0]).toContain('- semantic metric Lost amount:');
    expect(prompts[0]).toContain('A semantic metric listed in CONTEXT is computed exactly as it is defined there.');
  });

  it('a follow-up to an AI-drafted answer hands the AI that statement to edit, with its tables', async () => {
    const provider = drafter('NO_SQL: nothing to draft in this test.');
    const statements: string[] = [];
    const base = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-schema-lane-followup',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('information_schema.columns')) {
          return { columns: [], rowCount: 4, executionTimeMs: 1, rows: ['opportunity_id', 'stage', 'competitor', 'amount'].map((column) => ({ table_schema: 'sales', table_name: 'opportunities', column_name: column, data_type: column === 'amount' ? 'DOUBLE' : 'VARCHAR' })) };
        }
        return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:schema-lane-followup', manifest: manifest as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => ({
        intent: { version: 1, kind: 'analytics', reading: 'Lost deals to Splunk.', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' } as never,
        summary: '12 lost deals',
        sql: "SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(stage) = 'closed lost' AND LOWER(competitor) = 'splunk'",
        drafted: true,
      }),
    });
    await base({
      runId: 'run:schema-lane-followup',
      request: { question: 'now only the ones over 90,000', requestedMode: 'ask', threadId: 'thread-followup' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });
    expect(provider.draftPrompts[0]).toContain("- previous AI-drafted SQL in this conversation (this question follows up on it: edit it, and keep every restriction it applies unless the question changes it): SELECT COUNT(*) AS lost_deals FROM sales.opportunities WHERE LOWER(stage) = 'closed lost' AND LOWER(competitor) = 'splunk'");
    expect(provider.draftPrompts[0]).toContain('executable relation:sales.opportunities');
  });

  it('a decline is an honest gap: nothing is executed beyond describing the table', async () => {
    const provider = drafter('NO_SQL: nothing in sales.opportunities records a lost deal count by quarter of the fiscal calendar.');
    const statements: string[] = [];
    const result = await ask(routeFor(provider, statements));
    expect(provider.draftPrompts).toHaveLength(1);
    expect(statements.every((sql) => sql.includes('information_schema'))).toBe(true);
    expect(result.status).not.toBe('completed');
    expect(JSON.stringify(result)).toContain('nothing in sales.opportunities records a lost deal count');
  });
});

describe('the tables between two named tables come from the Modeling map', () => {
  const connection: ConnectionConfig = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
  const tables: Record<string, string[]> = {
    claims: ['claim_id', 'claim_amount'],
    cc_link: ['claim_id', 'detail_id'],
    cd_link: ['detail_id', 'policy_id'],
    policies: ['policy_id', 'policy_number'],
  };
  const source = (name: string) => ({ name, origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: `model.${name}`, schema: 'ins', columns: Object.fromEntries(tables[name]!.map((column) => [column, { name: column }])) } });
  const relationship = (id: string, from: string, to: string, key: string) => ({ id, from, to, keys: [{ from: key, to: key }], cardinality: 'many_to_one', status: 'draft' });
  const manifest = {
    sources: Object.fromEntries(Object.keys(tables).map((name) => [name, source(name)])),
    dbtProvenance: { nodes: Object.fromEntries(Object.keys(tables).map((name) => [`model.${name}`, { relation: `ins.${name}` }])) },
    modeling: {
      entities: Object.fromEntries(Object.keys(tables).map((name) => [name, { id: name, dbtUniqueId: `model.${name}` }])),
      relationships: {
        a: relationship('link_to_claim', 'cc_link', 'claims', 'claim_id'),
        b: relationship('link_to_detail', 'cc_link', 'cd_link', 'detail_id'),
        c: relationship('detail_to_policy', 'cd_link', 'policies', 'policy_id'),
      },
    },
  };
  const unreadable = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Claim count by policy.', measures: [{ ref: 'metric:ins.claim_count' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });

  it('adds the linking tables to the draft and shows each hop as a join', async () => {
    const prompts: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return 'NO_SQL: nothing to draft in this test.';
      },
    };
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-modeled-route',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          const rows = Object.entries(tables).filter(([name]) => sql.includes(`'${name}'`))
            .flatMap(([name, columns]) => columns.map((column) => ({ table_schema: 'ins', table_name: name, column_name: column, data_type: 'VARCHAR' })));
          return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
        }
        return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:modeled-route', manifest: manifest as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
    });
    await route({
      runId: 'run:modeled-route',
      request: { question: 'Count claims for each of the policies', requestedMode: 'ask' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });
    expect(prompts.length).toBeGreaterThan(0);
    const first = prompts[0]!;
    expect(first).toContain('ins.cc_link');
    expect(first).toContain('ins.cd_link');
    expect(first).toContain('preferred join (declared, not validated: link_to_claim)');
    expect(first).toContain('preferred join (declared, not validated: detail_to_policy)');
  });
});

describe('a join on a composite key is judged by the whole key', () => {
  const connection = { driver: 'duckdb' } as ConnectionConfig;
  // One row per (match_id, ball_id) on each side, while each column alone
  // repeats: a ball number recurs in every match.
  const manifest = { sources: {
    deliveries: { name: 'deliveries', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.deliveries', schema: 'cricket', columns: { match_id: { name: 'match_id' }, ball_id: { name: 'ball_id' }, bowler: { name: 'bowler' } } } },
    scores: { name: 'scores', origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: 'model.scores', schema: 'cricket', columns: { match_id: { name: 'match_id' }, ball_id: { name: 'ball_id' }, runs: { name: 'runs' } } } },
  } };
  const unreadable = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Runs conceded per bowler.', measures: [{ ref: 'metric:cricket.runs' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });
  const onFullKey = 'SELECT d.bowler, SUM(s.runs) AS runs FROM cricket.deliveries d JOIN cricket.scores s ON s.match_id = d.match_id AND s.ball_id = d.ball_id GROUP BY d.bowler';
  const route = (drafts: string[], tupleRepeats: boolean, statements: string[], prompts: string[]) => createAskPipelineRouteExecutor({
    projectRoot: '/tmp/ask-composite-key',
    executor: { executeQuery: vi.fn(async (sql: string) => {
      statements.push(sql);
      const probe = /GROUP BY (.+?) HAVING COUNT\(\*\) > 1/.exec(sql);
      if (probe) {
        const columns = probe[1]!.split(',').length;
        const repeats = columns === 1 || tupleRepeats;
        return { columns: [], rowCount: repeats ? 1 : 0, executionTimeMs: 1, rows: repeats ? [{ x: 1 }] : [] };
      }
      if (sql.includes('information_schema.columns')) {
        const rows = [
          ...(/'deliveries'/.test(sql) ? ['match_id', 'ball_id', 'bowler'].map((column) => ({ table_schema: 'cricket', table_name: 'deliveries', column_name: column, data_type: 'INTEGER' })) : []),
          ...(/'scores'/.test(sql) ? ['match_id', 'ball_id', 'runs'].map((column) => ({ table_schema: 'cricket', table_name: 'scores', column_name: column, data_type: 'INTEGER' })) : []),
        ];
        return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
      }
      return { columns: ['bowler', 'runs'], rowCount: 1, executionTimeMs: 1, rows: [{ bowler: 7, runs: 120 }] };
    }) } as unknown as QueryExecutor,
    resolveConnection: async () => connection,
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: 'snapshot:composite-key', manifest: manifest as never }),
    selectProvider: async () => ({
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return drafts[Math.min(prompts.length - 1, drafts.length - 1)]!;
      },
    }) as AgentProvider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
  const run = (executor: ReturnType<typeof route>) => executor({
    runId: 'run:composite-key',
    request: { question: 'Total runs conceded by each bowler, from the deliveries and scores tables', requestedMode: 'ask' } as AgentRunRequest,
    route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
  });

  it('runs a join on every column of a unique composite key, where each column alone repeats', async () => {
    const statements: string[] = [];
    const prompts: string[] = [];
    const result = await run(route([onFullKey], false, statements, prompts));
    expect(result.status).toBe('completed');
    expect(prompts).toHaveLength(1);
    // The probe groups by the key tuple, not by one of its columns.
    expect(statements.some((sql) => /GROUP BY "match_id", "ball_id" HAVING COUNT/.test(sql))).toBe(true);
    expect(statements.some((sql) => /GROUP BY "?ball_id"? HAVING COUNT/.test(sql))).toBe(false);
  });

  it('still refuses a join whose whole key repeats on both sides', async () => {
    const statements: string[] = [];
    const prompts: string[] = [];
    const result = await run(route([onFullKey], true, statements, prompts));
    expect(result.status).not.toBe('completed');
    expect(JSON.stringify(result)).toContain('on match_id = match_id and ball_id = ball_id repeats the key on both sides');
  });
});

describe('a wide question keeps the linking tables when many tables need columns', () => {
  const connection: ConnectionConfig = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
  const tables: Record<string, string[]> = {
    claims: ['claim_id', 'claim_amount'],
    cc_link: ['claim_id', 'detail_id'],
    cd_link: ['detail_id', 'policy_id'],
    policies: ['policy_id', 'policy_number'],
    alpha: ['alpha_id', 'alpha_value'],
    bravo: ['bravo_id', 'bravo_value'],
    charlie: ['charlie_id', 'charlie_value'],
    deltas: ['delta_id', 'delta_value'],
    echoes: ['echo_id', 'echo_value'],
  };
  const relationship = (id: string, from: string, to: string, key: string) => ({ id, from, to, keys: [{ from: key, to: key }], cardinality: 'many_to_one', status: 'draft' });
  const manifest = {
    sources: Object.fromEntries(Object.keys(tables).map((name) => [name, { name, origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: `model.${name}`, schema: 'ins', columns: {} } }])),
    dbtProvenance: { nodes: Object.fromEntries(Object.keys(tables).map((name) => [`model.${name}`, { relation: `ins.${name}` }])) },
    modeling: {
      entities: Object.fromEntries(Object.keys(tables).map((name) => [name, { id: name, dbtUniqueId: `model.${name}` }])),
      relationships: {
        a: relationship('link_to_claim', 'cc_link', 'claims', 'claim_id'),
        b: relationship('link_to_detail', 'cc_link', 'cd_link', 'detail_id'),
        c: relationship('detail_to_policy', 'cd_link', 'policies', 'policy_id'),
      },
    },
  };
  const unreadable = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Claims by policy with five extras.', measures: [{ ref: 'metric:ins.claim_count' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });

  it('describes the linking tables before the rest, five at a time', async () => {
    const prompts: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return 'NO_SQL: nothing to draft in this test.';
      },
    };
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-wide-route',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          const rows = Object.entries(tables).filter(([name]) => sql.includes(`'${name}'`))
            .flatMap(([name, columns]) => columns.map((column) => ({ table_schema: 'ins', table_name: name, column_name: column, data_type: 'VARCHAR' })));
          return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
        }
        return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:wide-route', manifest: manifest as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
    });
    await route({
      runId: 'run:wide-route',
      request: { question: 'Count claims for each of the policies with alpha, bravo, charlie, deltas and echoes', requestedMode: 'ask' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('executable relation:ins.cc_link');
    expect(prompts[0]).toContain('executable relation:ins.cd_link');
    expect(prompts[0]).toContain('executable relation:ins.echoes');
  });
});

describe('on a modeled project, tables are ranked by the Modeling map', () => {
  const connection: ConnectionConfig = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
  const tables: Record<string, string[]> = {
    claims: ['claim_id', 'claim_amount'],
    cc_link: ['claim_id', 'detail_id'],
    // Look-alikes carry a claim_id too, but the team never related them to claims.
    policy_no_a: ['policy_ref', 'claim_id'],
    policy_no_b: ['policy_ref', 'claim_id'],
    policy_no_c: ['policy_ref', 'claim_id'],
  };
  const relationship = (id: string, from: string, to: string, key: string) => ({ id, from, to, keys: [{ from: key, to: key }], cardinality: 'many_to_one', status: 'draft' });
  const manifest = {
    sources: Object.fromEntries(Object.entries(tables).map(([name, columns]) => [name, { name, origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: `model.${name}`, schema: 'ins', columns: Object.fromEntries(columns.map((column) => [column, { name: column }])) } }])),
    dbtProvenance: { nodes: Object.fromEntries(Object.keys(tables).map((name) => [`model.${name}`, { relation: `ins.${name}` }])) },
    modeling: {
      entities: Object.fromEntries(Object.keys(tables).map((name) => [name, { id: name, dbtUniqueId: `model.${name}` }])),
      relationships: {
        a: relationship('link_to_claim', 'cc_link', 'claims', 'claim_id'),
        b: relationship('a_to_b', 'policy_no_a', 'policy_no_b', 'policy_ref'),
        c: relationship('b_to_c', 'policy_no_b', 'policy_no_c', 'policy_ref'),
      },
    },
  };
  const reading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Total claim amount by detail.', measures: [{ ref: 'metric:ins.unknown_total' }, { ref: 'column:ins.claims.claim_amount', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' });

  it('a table the question reaches over modeled relationships is chosen before look-alikes that do not connect', async () => {
    const prompts: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return reading;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return 'NO_SQL: nothing to draft in this test.';
      },
    };
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-modeled-rank',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          const rows = Object.entries(tables).filter(([name]) => sql.includes(`'${name}'`))
            .flatMap(([name, columns]) => columns.map((column) => ({ table_schema: 'ins', table_name: name, column_name: column, data_type: 'VARCHAR' })));
          return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
        }
        return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:modeled-rank', manifest: manifest as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
      // The catalog offers the look-alikes first.
      searchCatalog: () => ['policy_no_a', 'policy_no_b', 'policy_no_c', 'cc_link'].map((name) => ({ objectType: 'dbt_model', name, relation: `ins.${name}` })),
    });
    await route({
      runId: 'run:modeled-rank',
      request: { question: 'Total claim amount by detail', requestedMode: 'ask' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });
    expect(prompts.length).toBeGreaterThan(0);
    const relationsSection = prompts[0]!.slice(prompts[0]!.indexOf('RELATIONS AND COLUMNS'));
    // Three catalog picks: the connected table takes one of them, so the last look-alike is left out.
    expect(relationsSection).toContain('executable relation:ins.cc_link');
    expect(relationsSection).not.toContain('executable relation:ins.policy_no_c');
  });
});

describe('a question mentions a table by its words', () => {
  it('matches underscores as spaces and a plural, but not a part of another word', () => {
    expect(mentionsName('what are the loss reserve amounts', 'loss_reserve')).toBe(true);
    expect(mentionsName('total loss reserves by claim', 'loss_reserve')).toBe(true);
    expect(mentionsName('count the order_items rows', 'order_items')).toBe(true);
    expect(mentionsName('how many claims do we have', 'claim')).toBe(true);
    expect(mentionsName('the reclaimed amount', 'claim')).toBe(false);
    expect(mentionsName('loss payment and reserve', 'loss_reserve')).toBe(false);
    // Short names only match as written.
    expect(mentionsName('fire dept', 'dep')).toBe(false);
    expect(mentionsName('by dep code', 'dep')).toBe(true);
  });
});

describe('a marker table reaches the draft with the table its values live on', () => {
  const connection: ConnectionConfig = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
  const tables: Record<string, string[]> = {
    amounts: ['amount_id', 'claim_id', 'amount_value'],
    reserve_flags: ['amount_id'],
  };
  const manifest = {
    sources: Object.fromEntries(Object.entries(tables).map(([name, columns]) => [name, { name, origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: `model.${name}`, schema: 'ins', columns: Object.fromEntries(columns.map((column) => [column, { name: column }])) } }])),
    dbtProvenance: { nodes: Object.fromEntries(Object.keys(tables).map((name) => [`model.${name}`, { relation: `ins.${name}` }])) },
    modeling: {
      entities: Object.fromEntries(Object.keys(tables).map((name) => [name, { id: name, dbtUniqueId: `model.${name}` }])),
      relationships: { a: { id: 'reserve_is_amount', from: 'reserve_flags', to: 'amounts', keys: [{ from: 'amount_id', to: 'amount_id' }], cardinality: 'one_to_one', status: 'draft' } },
    },
  };
  const unreadable = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Reserve flag totals.', measures: [{ ref: 'metric:ins.reserve_total' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });

  it('names the marker, adds its base and says how to use it', async () => {
    const prompts: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async (messages) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return unreadable;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return 'NO_SQL: nothing to draft in this test.';
      },
    };
    const route = createAskPipelineRouteExecutor({
      projectRoot: '/tmp/ask-marker-table',
      executor: { executeQuery: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          const rows = Object.entries(tables).filter(([name]) => sql.includes(`'${name}'`))
            .flatMap(([name, columns]) => columns.map((column) => ({ table_schema: 'ins', table_name: name, column_name: column, data_type: 'VARCHAR' })));
          return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
        }
        return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
      }) } as unknown as QueryExecutor,
      resolveConnection: async () => connection,
      getSemanticLayer: () => undefined,
      getManifest: () => ({ snapshotId: 'snapshot:marker-table', manifest: manifest as never }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => undefined,
    });
    await route({
      runId: 'run:marker-table',
      request: { question: 'Total of the reserve flags', requestedMode: 'ask' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('executable relation:ins.amounts');
    expect(prompts[0]).toContain('- ins.reserve_flags holds no values of its own (only its key)');
    expect(prompts[0]).toContain('use the ins.amounts rows that have a matching ins.reserve_flags row');
  });
});

describe('the skills an AI-written statement reads', () => {
  const skill = (name: string, guidance: string) => ({ kind: 'skill', ref: `skill:${name}`, name, aliases: [], skill: { preferredRefs: [], requiredFilters: [], clarifyWhen: [], vocabulary: {}, guidance } }) as unknown as Parameters<typeof skillsForDraft>[0][number];
  const entries = [
    skill('locations', 'Addresses live in location_address; geographic_location holds the region.'),
    skill('premiums', 'A premium is a policy_amount row that has a premium row; sum policy_amount for premiums.'),
    skill('claims', 'Loss payments are claim_amount rows that have a loss_payment row.'),
    skill('empty', ''),
  ];

  it('keeps at most two skills that share words with the question and tables, best first', () => {
    expect(skillsForDraft(entries, 'total premiums by policy "main"."policy_amount"').map((entry) => entry.name)).toEqual(['premiums', 'claims']);
    expect(skillsForDraft(entries, 'loss payment amount by claim, with premium').map((entry) => entry.name)).toEqual(['claims', 'premiums']);
    expect(skillsForDraft(entries, 'how many orders')).toEqual([]);
  });
});

describe('preferred joins are hints for AI-written SQL, never gates', () => {
  const entries = buildVocabularyIndex({ relationships: [
    { id: 'order_to_customer', from: 'order', to: 'customer', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', joinAuthority: 'certified' },
    { id: 'return_to_order', from: 'return', to: 'order', keys: [{ from: 'order_id', to: 'order_id' }], joinAuthority: 'draft' },
  ] }).entries;
  const columns: Record<string, string[]> = { 'dev.orders': ['order_id', 'customer_id'], 'dev.customers': ['customer_id', 'name'], 'dev.returns': ['return_id', 'order_id'] };

  it('a relationship whose keys two chosen tables carry is a preferred-join line; a draft says it is not validated', () => {
    const hints = preferredJoinHints(entries, ['dev.orders', 'dev.customers', 'dev.returns'], (relation) => columns[relation] ?? []);
    expect(hints.map(preferredJoinLine)).toEqual([
      '- preferred join (certified in Domain Studio: order_to_customer): dev.orders.customer_id = dev.customers.customer_id [many_to_one]',
      '- preferred join (declared, not validated: return_to_order): dev.orders.order_id = dev.returns.order_id',
    ]);
    expect(preferredJoinHints(entries, ['dev.orders'], (relation) => columns[relation] ?? [])).toEqual([]);
  });

  it('a statement that joins on the keys is disclosed; one that only selects the column is not', () => {
    const keys = [{ from: 'customer_id', to: 'customer_id' }];
    expect(joinHintUsed('SELECT c.name FROM dev.orders o JOIN dev.customers c ON c.customer_id = o.customer_id', keys)).toBe(true);
    expect(joinHintUsed('SELECT customer_id FROM dev.orders', keys)).toBe(false);
  });
});

describe('a follow-up\'s earlier answer and the thread\'s memory reach the model only inside the privacy boundary (RFC 0010 HH-5)', () => {
  const FIGURE = 'CANARY-FIGURE-8812';
  const prior = { intent: JSON.parse(analytics) as AnalyticalIntentV1, summary: `Revenue was ${FIGURE}.`, executed: true };
  const followUp = (provider: ReturnType<typeof scripted>, valuesMayReachModel?: () => boolean) => createAskPipelineRouteExecutor({
    projectRoot: '/tmp/none',
    executor: {} as QueryExecutor,
    resolveConnection: async () => { throw new Error('No database connection is configured yet.'); },
    getSemanticLayer: () => undefined,
    getManifest: () => ({ manifest: undefined as never, snapshotId: 'snapshot:test' }),
    selectProvider: async () => provider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => prior,
    conversation: () => ({ summary: `Earlier answers: ${FIGURE} in the West.`, pendingClarification: `Which of ${FIGURE}-members?` }),
    ...(valuesMayReachModel ? { valuesMayReachModel } : {}),
  })({
    runId: 'run-follow-up', request: { question: 'And by region?', requestedMode: 'ask', threadId: 'thread-1' } as AgentRunRequest,
    route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
  });

  it('outside the boundary the model reads the earlier reading, never its answer or the thread\'s memory', async () => {
    const outside = scripted([conversation]);
    await followUp(outside, () => false);
    expect(outside.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(outside.calls)).not.toContain(FIGURE);
    expect(JSON.stringify(outside.calls)).toContain('Total revenue.');
  });

  it('inside the boundary (and without the rule: single-user, the chosen model) they are carried as before', async () => {
    const inside = scripted([conversation]);
    await followUp(inside, () => true);
    expect(JSON.stringify(inside.calls)).toContain(FIGURE);
    const noRule = scripted([conversation]);
    await followUp(noRule);
    expect(JSON.stringify(noRule.calls)).toContain(FIGURE);
  });

  it('outside the boundary the earlier reading\'s restriction values (a member, as typed or as stored) are named by position, never sent', async () => {
    const MEMBER = 'CANARY-MEMBER-5520';
    const earlier = { ...(JSON.parse(analytics) as AnalyticalIntentV1), reading: `Total revenue for ${MEMBER}.`, filters: [{ ref: 'dimension:customers.customer_name', op: 'eq' as const, values: [MEMBER], source: 'question' as const }] };
    const ask = (provider: ReturnType<typeof scripted>, valuesMayReachModel: () => boolean) => createAskPipelineRouteExecutor({
      projectRoot: '/tmp/none',
      executor: {} as QueryExecutor,
      resolveConnection: async () => { throw new Error('No database connection is configured yet.'); },
      getSemanticLayer: () => undefined,
      getManifest: () => ({ manifest: undefined as never, snapshotId: 'snapshot:test' }),
      selectProvider: async () => provider,
      compileSemantic: async () => { throw new Error('no semantic layer'); },
      priorIntent: () => ({ intent: earlier, executed: true, drafted: true, sql: `SELECT SUM(price) FROM dev.order_items WHERE customer_name = '${MEMBER}'` }),
      valuesMayReachModel,
    })({
      runId: 'run-member', request: { question: 'And by month?', requestedMode: 'ask', threadId: 'thread-2' } as AgentRunRequest,
      route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
    });
    const outside = scripted([conversation]);
    await ask(outside, () => false);
    expect(outside.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(outside.calls)).not.toContain(MEMBER);
    expect(JSON.stringify(outside.calls)).toContain('[value 1]');
    const inside = scripted([conversation]);
    await ask(inside, () => true);
    expect(JSON.stringify(inside.calls)).toContain(MEMBER);
  });
});

describe('the result review sees what a result looks like, never what it says', () => {
  it('row count, distinct and NULL counts per column, repeated rows; no value', () => {
    const result = { columns: ['day', 'driver_id', 'deliveries'], rowCount: 3, rows: [{ day: null, driver_id: 7, deliveries: 10 }, { day: null, driver_id: 7, deliveries: 10 }, { day: null, driver_id: 9, deliveries: 4 }] };
    const shape = resultShapeForReview(result);
    expect(shape).toContain('rows: 3');
    expect(shape).toContain('- day: every value NULL');
    expect(shape).toContain('- driver_id: 2 distinct');
    expect(shape).toContain('repeated rows: 1');
    expect(shape).not.toMatch(/\b(7|9|10|4)\b(?! distinct)/);
    expect(shape).not.toContain('first rows');
  });

  it('a result larger than the rows held says the shape was read from those', () => {
    const shape = resultShapeForReview({ columns: [{ name: 'n' }], rowCount: 900, rows: [{ n: 1n }, { n: 2n }] });
    expect(shape).toContain('rows: 900 (shape read from the first 2)');
    expect(shape).toContain('- n: 2 distinct');
  });
});
