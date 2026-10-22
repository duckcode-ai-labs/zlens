import { describe, expect, it } from 'vitest';
import { extractBlockContract, fixedPeriods } from './block-contract.js';
import { parseIntent, type AnalyticalIntentV1 } from './intent.js';
import { blocksNamedByQuestion, withoutBlockNames } from './named-blocks.js';
import { heldBlockRefusal, runAskPipeline } from './pipeline.js';
import { entails } from './prepare/index.js';
import { missingStatedValues, statedValues } from './prepare/sql-checks.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import type { AgentMessage, AgentProvider } from '../providers/types.js';

/**
 * ZLens 0.1.0 second pre-publish e2e, N4 and N5: a freshly certified block was
 * bypassed, naming it made Ask treat the words of its name as values the SQL
 * had to filter on ("Eligible", "Players"), and the follow-up "Only guards."
 * wandered through AI-drafted SQL for minutes. The block below is the e2e
 * evidence block (07-eligible-top-players-with-player-id.dql).
 */

const BLOCK_NAME = 'Eligible Top Players With Player ID';
const BLOCK_SQL = `SELECT
  player_id,
  player_name,
  SUM(COALESCE(pts, 0)) AS total_points,
  COUNT(DISTINCT details_game_id) AS games_played
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) BETWEEN 2016 AND 2017
  AND player_id IS NOT NULL
  AND player_name IS NOT NULL
GROUP BY player_id, player_name
ORDER BY total_points DESC, player_id ASC
LIMIT \${top_n}`;
const BLOCK_REF = `block:nba.${BLOCK_NAME}`;

const contract = extractBlockContract({
  name: BLOCK_NAME, domain: 'nba', sql: BLOCK_SQL, grain: 'player_id', entities: ['player'],
  declaredOutputs: ['player_id', 'player_name', 'total_points', 'games_played'], dimensions: ['player_id', 'player_name'],
  allowedFilters: ['top_n'], parameters: ['top_n'],
});

const nba: VocabularySource = {
  metrics: [
    { name: 'total_points', model: 'local_player_season_facts', label: 'Total points', aggregation: 'sum', physical: { relation: 'TRANSFORMED.local_player_season_facts', column: 'total_points', aggregate: 'sum' } },
  ],
  dimensions: [
    { name: 'season', model: 'local_player_season_facts', dataType: 'integer', physical: { relation: 'TRANSFORMED.local_player_season_facts', column: 'season' } },
    { name: 'player_id', model: 'local_player_season_facts', dataType: 'integer', physical: { relation: 'TRANSFORMED.local_player_season_facts', column: 'player_id' } },
    { name: 'player_name', model: 'local_player_season_facts', dataType: 'string', physical: { relation: 'TRANSFORMED.local_player_season_facts', column: 'player_name' } },
    { name: 'game_date', model: 'local_player_game_facts', dataType: 'date', isTime: true, physical: { relation: 'TRANSFORMED.local_player_game_facts', column: 'game_date' } },
  ],
  blocks: [{ name: BLOCK_NAME, domain: 'nba', certified: true, status: 'certified', description: 'Ranks the top NBA players by summed points scored across games dated in 2016 or 2017.', contract, sql: BLOCK_SQL, sourcePath: 'blocks/nba/eligible-top-players-with-player-id.dql' }],
  relations: [
    { schema: 'TRANSFORMED', name: 'fct_player_journey', columns: [{ name: 'player_id', dataType: 'INTEGER' }, { name: 'season', dataType: 'INTEGER' }, { name: 'player_position', dataType: 'VARCHAR' }] },
  ],
};
const vocabulary = buildVocabularyIndex(nba);

const QUESTION = `Using the certified block ${BLOCK_NAME}, who are the top 5 NBA players by total points for 2016 and 2017?`;
const ROWS = [
  { player_id: 201935, player_name: 'James Harden', total_points: 5534, games_played: 189 },
  { player_id: 2544, player_name: 'LeBron James', total_points: 5331, games_played: 214 },
  { player_id: 201566, player_name: 'Russell Westbrook', total_points: 5252, games_played: 198 },
  { player_id: 201939, player_name: 'Stephen Curry', total_points: 5251, games_played: 201 },
  { player_id: 201142, player_name: 'Kevin Durant', total_points: 4835, games_played: 188 },
];

function scripted(replies: string[]): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  return { name: 'ollama', calls, available: async () => true, generate: async (messages) => { calls.push(messages); return replies[Math.min(calls.length - 1, replies.length - 1)] ?? ''; } };
}
const reading = (raw: Record<string, unknown>) => JSON.stringify({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...raw });
const intentOf = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
  const parsed = parseIntent(JSON.parse(reading(raw)));
  if (!parsed.intent) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  return parsed.intent;
};

function harness(provider: AgentProvider, extra: Partial<Parameters<typeof runAskPipeline>[0]> = {}) {
  const drafted: string[] = [];
  const executed: string[] = [];
  const bound: Array<Record<string, unknown> | undefined> = [];
  const run = runAskPipeline({
    question: QUESTION, vocabulary, provider, clauseCoverage: false, explorationAuto: true,
    prepareDeps: {
      prepareBlock: (ref, context) => {
        bound.push(context.parameters);
        return ref === BLOCK_REF ? { sql: BLOCK_SQL.replace('${top_n}', '$1'), params: [context.parameters?.top_n ?? 5], parameters: [{ name: 'top_n', position: 1, value: context.parameters?.top_n ?? 5, source: 'question' }] } : undefined;
      },
      draftSql: async (input) => { drafted.push(input.question); return { sql: "SELECT player_id FROM TRANSFORMED.fct_player_journey WHERE player_position = 'Eligible Players'", relations: ['TRANSFORMED.fct_player_journey'], proof: [] }; },
    },
    executeDeps: { run: async (sql) => { executed.push(sql); return { columns: ['player_id', 'player_name', 'total_points', 'games_played'], rows: ROWS, rowCount: ROWS.length, executionTimeMs: 3 }; } },
    ...extra,
  });
  return { run, drafted, executed, bound };
}

describe('a question that names a block as a block', () => {
  it('is recognized only when it says "block"; a phrase equal to a review draft\'s title stays an ordinary question', () => {
    expect(blocksNamedByQuestion(QUESTION, [BLOCK_NAME, 'Top Players'])).toEqual([BLOCK_NAME]);
    expect(blocksNamedByQuestion('Run the "eligible top players with player id" block for 2017', [BLOCK_NAME])).toEqual([BLOCK_NAME]);
    expect(blocksNamedByQuestion('Which team had the most wins in season 2017?', ['Which team had the most wins in season 2017'])).toEqual([]);
  });

  it('never turns the words of the block\'s name into values the SQL must apply', () => {
    const before = statedValues(QUESTION).map((item) => item.value);
    expect(before).toEqual(expect.arrayContaining(['Eligible', 'Players']));
    const stated = statedValues(QUESTION, undefined, { namedBlocks: [BLOCK_NAME] });
    expect(stated.map((item) => item.value)).not.toEqual(expect.arrayContaining(['Eligible']));
    expect(stated.map((item) => item.value)).not.toContain('Players');
    expect(stated).toEqual(expect.arrayContaining([{ value: '2016', kind: 'year' }, { value: '2017', kind: 'year' }]));
    expect(missingStatedValues('SELECT * FROM t WHERE year IN (2016, 2017)', stated)).toEqual([]);
    // An unresolved clause that only names the block is not a value either.
    const clause = intentOf({ unresolved: [{ clause: `certified block ${BLOCK_NAME}`, options: [], material: true }] });
    expect(statedValues(QUESTION, clause, { namedBlocks: [BLOCK_NAME] }).map((item) => item.value)).not.toContain('Players');
  });

  it('still checks every real value the question states beside the block\'s name', () => {
    const question = `Using block ${BLOCK_NAME}, how many points did Curry score in 2017?`;
    expect(withoutBlockNames(question, [BLOCK_NAME])).not.toMatch(/Eligible/);
    expect(statedValues(question, undefined, { namedBlocks: [BLOCK_NAME] }).map((item) => item.value)).toEqual(expect.arrayContaining(['Curry', '2017']));
  });

  it('is answered by the certified block when the reading names it, with its row count bound from the question', async () => {
    const provider = scripted([reading({ reading: 'Top 5 players by total points across games dated 2016 or 2017, from the certified block', measures: [{ ref: BLOCK_REF }], limit: 5, ordering: { ref: BLOCK_REF, direction: 'desc' }, time: { ref: 'dimension:local_player_game_facts.game_date', window: { start: '2016-01-01', end: '2018-01-01' } } })]);
    const { run, drafted, executed, bound } = harness(provider);
    const outcome = await run;
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.candidate.tier).toBe('certified');
    expect(outcome.candidate.trust).toBe('certified');
    expect(outcome.candidate.sourceRef).toBe(BLOCK_REF);
    expect(drafted).toEqual([]);
    expect(executed).toHaveLength(1);
    expect(bound.at(-1)).toEqual({ top_n: 5 });
    expect(outcome.candidate.proof.join(' ')).toMatch(/fixed to game_date_est from 2016-01-01 up to 2018-01-01/);
    expect(provider.calls).toHaveLength(1);
  });

  it('is answered by the certified block even when the reading leaves it to AI-written SQL (the e2e failure)', async () => {
    // The e2e reading: no measure, and the block's name left as an unresolved clause.
    const provider = scripted([reading({ reading: 'Using the certified block, list the top 5 NBA players by total points for 2016 and 2017.', unresolved: [{ clause: `certified block ${BLOCK_NAME}`, options: [], material: true }] })]);
    const { run, drafted } = harness(provider);
    const outcome = await run;
    expect(drafted).toEqual([]);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.candidate.tier).toBe('certified');
    expect(outcome.receipt.tiers.find((tier) => tier.tier === 'certified')?.outcome).toBe('prepared');
  });

  it('that cannot answer says exactly why, and runs no AI-written SQL', async () => {
    const provider = scripted([reading({ measures: [{ ref: 'metric:local_player_season_facts.total_points' }], groupBy: [{ ref: 'dimension:local_player_season_facts.player_id', role: 'key' }], filters: [{ ref: 'dimension:local_player_season_facts.season', op: 'eq', values: [2015], source: 'question' }], ordering: { ref: 'metric:local_player_season_facts.total_points', direction: 'desc' }, limit: 5 })]);
    const { run, drafted, executed } = harness(provider, { question: `Using the certified block ${BLOCK_NAME}, who were the top 5 players by total points in season 2015?` });
    const outcome = await run;
    expect(drafted).toEqual([]);
    expect(executed).toEqual([]);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.message).toMatch(/The certified saved query "Eligible Top Players With Player ID" cannot answer this as asked: the block does not accept a filter on season/);
    expect(outcome.message).toMatch(/accepts top_n/);
    expect(outcome.offerExploration).toBe(true);
    expect(outcome.text).toMatch(/explore the tables for a review-required answer/);
  });

  it('fixed to another period says which period it holds', () => {
    const asked = intentOf({ measures: [{ ref: BLOCK_REF }], time: { ref: 'dimension:local_player_game_facts.game_date', window: { start: '2015-01-01', end: '2016-01-01' } } });
    const verdict = entails(vocabulary.get(BLOCK_REF)!, asked, vocabulary);
    expect(verdict.ok).toBe(false);
    expect(heldBlockRefusal(vocabulary.get(BLOCK_REF)!, verdict.missing)).toMatch(/fixed to game_date_est from 2016-01-01 up to 2018-01-01 and has no filter for another period/);
  });

  it('exploring the tables stays possible once the person opts in', async () => {
    const provider = scripted([reading({ measures: [{ ref: 'metric:local_player_season_facts.total_points' }], filters: [{ ref: 'dimension:local_player_season_facts.season', op: 'eq', values: [2015], source: 'question' }] })]);
    const { run } = harness(provider, { explorationOptIn: true, question: `Using the certified block ${BLOCK_NAME}, total points in season 2015?` });
    const outcome = await run;
    expect(outcome.receipt.failure?.reason).not.toBe('named_block_not_applicable');
  });
});

describe('the block contract reads what the e2e block promises', () => {
  it('a LIMIT bound to a declared parameter and a WHERE that fixes the period', () => {
    expect(contract.limit).toBeUndefined();
    expect(contract.limitParameter).toBe('top_n');
    expect(contract.periods).toEqual([{ column: 'game_date_est', start: '2016-01-01', end: '2018-01-01' }]);
    // The period is still a restriction a block matched by its measures must have asked for.
    expect(contract.scopeUnparsed).toEqual(['EXTRACT(YEAR FROM game_date_est) BETWEEN 2016 AND 2017', 'player_id IS NOT NULL', 'player_name IS NOT NULL']);
  });
  it('reads date ranges written as comparisons or BETWEEN dates', () => {
    expect(fixedPeriods("order_date >= '2024-01-01' AND order_date < '2025-01-01'", [
      { column: 'order_date', op: 'gte', values: ['2024-01-01'] }, { column: 'order_date', op: 'lt', values: ['2025-01-01'] },
    ])).toEqual([{ column: 'order_date', start: '2024-01-01', end: '2025-01-01' }]);
    expect(fixedPeriods("order_date BETWEEN '2024-01-01' AND '2024-12-31'")).toEqual([{ column: 'order_date', start: '2024-01-01', end: '2025-01-01' }]);
    expect(fixedPeriods('YEAR(order_date) = 2024')).toEqual([{ column: 'order_date', start: '2024-01-01', end: '2025-01-01' }]);
  });
  it('a fixed period never lets a block matched only by its measures answer an unscoped question', () => {
    const verdict = entails(vocabulary.get(BLOCK_REF)!, intentOf({ measures: [{ ref: 'metric:local_player_season_facts.total_points' }], groupBy: [{ ref: 'dimension:local_player_season_facts.player_id', role: 'key' }] }), vocabulary);
    expect(verdict.ok).toBe(false);
  });
});

describe('N5: a follow-up that narrows a certified block\'s answer', () => {
  const prior = intentOf({ reading: 'Top 5 players by total points from the certified block', measures: [{ ref: BLOCK_REF }], limit: 5 });

  it('on a field the block does not hold says so after the one reading, without drafting SQL', async () => {
    const provider = scripted([reading({
      reading: `Using the certified block ${BLOCK_NAME}, list the top 5 NBA players by total points, restricted to guards.`,
      measures: [{ ref: BLOCK_REF }], limit: 5,
      filters: [{ ref: 'column:TRANSFORMED.fct_player_journey.player_position', op: 'eq', values: ['G'], source: 'question' }],
      provenance: { [BLOCK_REF]: 'inherited', 'column:TRANSFORMED.fct_player_journey.player_position': 'q:Only guards' },
    })]);
    const started = Date.now();
    const { run, drafted, executed } = harness(provider, { question: 'Only guards.', prior, priorExecuted: true });
    const outcome = await run;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(provider.calls).toHaveLength(1);
    expect(drafted).toEqual([]);
    expect(executed).toEqual([]);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.message).toMatch(/cannot answer this as asked: the block does not accept a filter on player_position/);
    expect(outcome.offerExploration).toBe(true);
  });

  it('that moves to another question is not held to the block', async () => {
    const provider = scripted([reading({ reading: 'Total points by season', measures: [{ ref: 'metric:local_player_season_facts.total_points' }], groupBy: [{ ref: 'dimension:local_player_season_facts.season', role: 'categorical' }], expectedShape: 'grouped' })]);
    const { run } = harness(provider, { question: 'And total points by season?', prior, priorExecuted: true });
    const outcome = await run;
    expect(outcome.receipt.failure?.reason).not.toBe('named_block_not_applicable');
  });
});
