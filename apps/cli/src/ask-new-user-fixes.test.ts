import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { summaryKindsRead } from './ask-pipeline-host/host.js';
import { activeProviderForDeadline, askTraceReason, deadlineScaleForProvider } from './local-runtime.js';

/**
 * Fixes from the new-user test of the ZLens app for Snowflake on NBA data (2026-11-10): Ask's time budget for
 * Cortex (B3), the trace label for a time-out (B3), and the summary tables that mix every kind of game (B1).
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Ask's time budget follows the provider it runs on (B3)", () => {
  it('reads the provider the install chose when nothing is saved: the Snowflake app allows only Cortex', () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-deadline-'));
    roots.push(root);
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'p' }));
    expect(activeProviderForDeadline(root, { ZLENS_MODEL_PROVIDERS: 'cortex' })).toBe('cortex');
    expect(activeProviderForDeadline(root, { ZLENS_MODEL_PROVIDERS: 'cortex,anthropic' })).toBeUndefined();
    expect(activeProviderForDeadline(root, {})).toBeUndefined();
  });

  it('gives Cortex four times the base budget: through SQL each call is a whole statement of 8 to 20 s', () => {
    expect(deadlineScaleForProvider('cortex')).toBe(4);
    expect(deadlineScaleForProvider('ollama')).toBe(6);
    expect(deadlineScaleForProvider('anthropic')).toBe(2);
    expect(deadlineScaleForProvider(undefined)).toBe(1);
  });

  it('labels a time-out as stopped, not refused', () => {
    const base = { status: 'blocked', stopReason: 'blocked', artifacts: [], evaluations: [] } as never as Parameters<typeof askTraceReason>[0];
    expect(askTraceReason({ ...base, summary: 'This question reached its time limit before it finished. Retry it, or ask a narrower question.' })).toBe('Stopped: reached the time limit before an answer.');
    expect(askTraceReason({ ...base, summary: 'No query was run: the table is not modeled.' })).toBe('Refused: no governed answer was available.');
  });
});

describe('a summary table that adds up every kind of game is said in the answer (B1)', () => {
  const rules = {
    'nba.team_season_sums_every_game_id': {
      localId: 'team_season_sums_every_game_id',
      expression: "LOCAL_TEAM_SEASON_FACTS adds up every row of LOCAL_TEAM_GAME_FACTS, every first character of GAME_ID included: TOTAL_POINTS totals 5,412,766, as TEAM_POINTS does in LOCAL_TEAM_GAME_FACTS. For one kind (one first character of GAME_ID), sum LOCAL_TEAM_GAME_FACTS filtered on it: CAST(GAME_ID AS VARCHAR) LIKE '2%' gives 4,759,243.",
      status: 'draft',
    },
    'nba.game_id_first_character': {
      localId: 'game_id_first_character',
      expression: "Every GAME_ID in LOCAL_PLAYER_GAME_FACTS has 8 characters, and the first one takes 4 values.",
      status: 'draft',
    },
  };

  it('names the summary, the table it adds up and the code, when the statement reads the summary', () => {
    expect(summaryKindsRead(rules, ['NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS', 'NBA.TRANSFORMED.DIM_TEAMS_CLEANSED'])).toEqual([
      { summary: 'LOCAL_TEAM_SEASON_FACTS', detail: 'LOCAL_TEAM_GAME_FACTS', code: 'GAME_ID', rule: 'team_season_sums_every_game_id' },
    ]);
  });

  it('says nothing when the statement reads the detail table, or the rule is retired', () => {
    expect(summaryKindsRead(rules, ['NBA.TRANSFORMED.LOCAL_TEAM_GAME_FACTS'])).toEqual([]);
    expect(summaryKindsRead({ x: { ...rules['nba.team_season_sums_every_game_id'], status: 'deprecated' } }, ['NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS'])).toEqual([]);
    expect(summaryKindsRead(undefined, ['NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS'])).toEqual([]);
  });
});
