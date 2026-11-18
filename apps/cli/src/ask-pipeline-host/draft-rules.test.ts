import { describe, expect, it } from 'vitest';
import type { DQLManifest } from '@zlens/core';
import type { ContextAuthoringProposalV1 } from '@zlens/agent';
import { waitingDraftRules, withWaitingDraftRules } from './draft-rules.js';
import { codeKindsFrom } from './host.js';

/**
 * New-user test V17 p6, fresh install of the ZLens app for Snowflake: the first start drafted the NBA models
 * and measured that GAME_ID's first character is the kind of game, but the draft waited for review and Ask read
 * only saved rules. "2015 playoffs" found no field for playoffs; "2016 regular season" counted 89 wins.
 */
const CODE_RULE = 'Every GAME_ID in RAW_GAMES has 8 characters, and the first one takes 4 values: 1 (3,548 rows), 2 (46,488 rows), 4 (3,182 rows), 5 (26 rows). The first character is a code, such as a type: filter on it with CAST(GAME_ID AS VARCHAR) LIKE \'2%\'.';

function draft(id: string, status: ContextAuthoringProposalV1['status'], rules: Array<{ id: string; expression: string; evidence?: boolean; status?: string }>, createdAt = '2026-11-17T20:53:00Z'): ContextAuthoringProposalV1 {
  return {
    version: 1,
    id,
    origin: 'warehouse_discovery',
    status,
    trustState: 'review_required',
    createdAt,
    baseSnapshotId: 'snap',
    dependencyFingerprints: {},
    operations: rules.map((rule) => ({
      id: `warehouse:rule:nba:${rule.id}`,
      kind: 'modeling_change',
      change: {
        operation: 'upsert_rule',
        value: {
          id: rule.id,
          domain: 'nba',
          kind: 'custom',
          expression: rule.expression,
          status: (rule.status ?? 'draft') as never,
          entities: ['raw_games'],
          ...(rule.evidence === false ? {} : { evidence: { query: 'SELECT SUBSTR(CAST("GAME_ID" AS VARCHAR), 1, 1) AS first_char, COUNT(*) AS n FROM RAW_GAMES GROUP BY 1', measured: { length: 8, first_1: 3548, first_2: 46488, first_4: 3182, first_5: 26 } } }),
        },
      },
    })),
    patches: [],
    diagnostics: [],
  } as unknown as ContextAuthoringProposalV1;
}

const manifest = (rules: Record<string, unknown> = {}) => ({ modeling: { mode: 'warehouse-first', entities: {}, relationships: {}, rules } }) as unknown as DQLManifest;

describe('the measured rules of a draft waiting for review', () => {
  it('reach Ask on a fresh install, where no rule is saved yet, so Ask knows the kinds of game', () => {
    const read = withWaitingDraftRules(manifest(), [draft('p1', 'proposed', [{ id: 'game_id_first_character', expression: CODE_RULE }])]);
    expect(Object.keys(read.modeling!.rules)).toEqual(['nba::rule::game_id_first_character']);
    expect(read.modeling!.rules['nba::rule::game_id_first_character']).toMatchObject({ status: 'draft', localId: 'game_id_first_character', entities: ['nba::entity::raw_games'] });
    const kinds = codeKindsFrom(read.modeling!.rules);
    expect(kinds).toHaveLength(1);
    expect(kinds[0]).toMatchObject({ code: 'GAME_ID', table: 'RAW_GAMES' });
    expect(kinds[0]!.values.map((value) => value.first)).toEqual(['1', '2', '4', '5']);
  });

  it('never replace a saved rule, and leave the manifest as it is when nothing is added', () => {
    const saved = manifest({ 'nba::rule::game_id_first_character': { id: 'nba::rule::game_id_first_character', expression: 'saved words', status: 'certified' } });
    const read = withWaitingDraftRules(saved, [draft('p1', 'proposed', [{ id: 'game_id_first_character', expression: CODE_RULE }])]);
    expect(read).toBe(saved);
    expect(read.modeling!.rules['nba::rule::game_id_first_character']!.expression).toBe('saved words');
  });

  it('come only from waiting drafts, only measured, never deprecated; the newest draft wins', () => {
    const rules = waitingDraftRules([
      draft('old', 'proposed', [{ id: 'game_id_first_character', expression: `${CODE_RULE} (older)` }], '2026-11-17T19:00:00Z'),
      draft('new', 'proposed', [{ id: 'game_id_first_character', expression: CODE_RULE }], '2026-11-17T21:00:00Z'),
      draft('saved', 'committed', [{ id: 'committed_rule', expression: 'already written' }]),
      draft('gone', 'discarded', [{ id: 'discarded_rule', expression: 'turned down' }]),
      draft('words', 'proposed', [{ id: 'unmeasured', expression: 'no query measured this', evidence: false }, { id: 'old_rule', expression: 'deprecated', status: 'deprecated' }]),
    ]);
    expect(Object.keys(rules)).toEqual(['nba::rule::game_id_first_character']);
    expect(rules['nba::rule::game_id_first_character']!.expression).toBe(CODE_RULE);
    expect(rules['nba::rule::game_id_first_character']!.sourcePath).toBe('draft:new');
  });
});
