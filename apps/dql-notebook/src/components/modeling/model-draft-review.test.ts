import { describe, expect, it } from 'vitest';
import type { ContextAuthoringOperation } from '../../api/client';
import { isModelDraft, modelDraftReview, modelDraftSummary } from './model-draft-review';

const operations: ContextAuthoringOperation[] = [
  { id: 'warehouse:entity:nba:player_game', kind: 'modeling_change', evidence: ['warehouse relation nba.TRANSFORMED.local_player_game_facts'], change: { operation: 'upsert_entity', value: { id: 'player_game', domain: 'nba', dbtModel: 'model.nba.local_player_game_facts', businessName: 'Player game', businessContext: 'One row per game_id, player_id: 668,339 rows; season 2003–2022.', grain: 'game_id, player_id', keys: ['game_id', 'player_id'], status: 'draft' } } },
  { id: 'warehouse:entity:nba:int_player_stats', kind: 'modeling_change', evidence: ['warehouse relation nba.TRANSFORMED.int_player_stats'], change: { operation: 'upsert_entity', value: { id: 'int_player_stats', domain: 'nba', dbtModel: 'model.nba.int_player_stats', businessName: 'Player Stat', status: 'draft', useInstead: { entity: 'player_game', reason: 'covers season 2009–2019; local_player_game_facts covers season 2003–2022' } } } },
  { id: 'warehouse:relationship:nba:player_game_to_team_game', kind: 'modeling_change', change: { operation: 'upsert_relationship', value: { id: 'player_game_to_team_game', domain: 'nba', from: 'player_game', to: 'team_game', keys: [{ from: 'game_id', to: 'game_id' }, { from: 'team_id', to: 'team_id' }], cardinality: 'many_to_one', fanout: 'safe', status: 'draft', rationale: 'local_team_game_facts is one row per game_id, team_id', validation: { status: 'passed' } as never } } },
  { id: 'warehouse:relationship:nba:team_game_to_game', kind: 'modeling_change', change: { operation: 'upsert_relationship', value: { id: 'team_game_to_game', domain: 'nba', from: 'team_game', to: 'game', keys: [{ from: 'game_id', to: 'games_game_id' }], cardinality: 'many_to_many', fanout: 'forbidden', status: 'draft', validation: { status: 'failed', message: 'src_games holds up to 2 rows for one key' } as never } } },
  { id: 'warehouse:relationship:nba:x_to_y', kind: 'modeling_change', change: { operation: 'upsert_relationship', value: { id: 'x_to_y', domain: 'nba', from: 'x', to: 'nba::entity::y', keys: [{ from: 'y_id', to: 'y_id' }], cardinality: 'unknown', fanout: 'unknown', status: 'draft' } } },
  { id: 'warehouse:rule:nba:player_game_participated', kind: 'modeling_change', change: { operation: 'upsert_rule', value: { id: 'player_game_participated', domain: 'nba', expression: 'In local_player_game_facts, 109,669 of 668,339 rows (16%) have participated = false.', status: 'draft', evidence: { query: 'SELECT COUNT(*) AS row_count FROM t', measured: { rows: 668339 } } } } },
  { id: 'warehouse:concept:nba:player', kind: 'modeling_change', change: { operation: 'upsert_concept', value: { id: 'player', domain: 'nba', name: 'Player', description: 'A player, identified by player_id.', bindings: [{ entity: 'player_season' }] } } },
];

describe('reviewing a drafted model by group (RFC 0012, P5)', () => {
  it('groups tables, look-alikes, joins, rules and concepts, and says which joins passed', () => {
    const review = modelDraftReview(operations);
    expect(review.groups.map((group) => group.key)).toEqual(['tables', 'lookalikes', 'joins', 'rules', 'concepts']);
    expect(review.groups[0]!.items[0]).toMatchObject({ title: 'Player game · local_player_game_facts', detail: 'One row per game_id, player_id: 668,339 rows; season 2003–2022.', check: 'passed' });
    expect(review.groups[1]!.items[0]).toMatchObject({ detail: 'Use player_game instead.', reason: 'covers season 2009–2019; local_player_game_facts covers season 2003–2022' });
    const joins = review.groups[2]!.items;
    expect(joins.map((item) => [item.title, item.check])).toEqual([
      ['player_game → team_game on game_id, team_id', 'passed'],
      ['team_game → game on game_id = games_game_id', 'failed'],
      ['x → y on y_id', 'unchecked'],
    ]);
    expect(joins[1]!.reason).toBe('src_games holds up to 2 rows for one key');
    expect(review.groups[3]!.items[0]).toMatchObject({ query: 'SELECT COUNT(*) AS row_count FROM t' });
  });

  it('accepts everything except the joins that did not pass', () => {
    const review = modelDraftReview(operations);
    expect(review.passedIds).not.toContain('warehouse:relationship:nba:team_game_to_game');
    expect(review.passedIds).not.toContain('warehouse:relationship:nba:x_to_y');
    expect(review.passedIds).toHaveLength(operations.length - 2);
    expect(modelDraftSummary(review.counts)).toBe('1 table to answer from · 1 look-alike to skip · 3 joins (1 passed) · 1 measured rule · 1 concept. 2 joins need a look before you keep them.');
  });

  it('treats a proposal as a drafted model only when it drafts tables or joins', () => {
    expect(isModelDraft(operations)).toBe(true);
    expect(isModelDraft(operations.filter((operation) => operation.kind === 'modeling_change' && operation.change.operation === 'upsert_rule'))).toBe(false);
  });
});
