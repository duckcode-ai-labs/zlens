import { describe, expect, it } from 'vitest';
import type { WarehouseSetupStatus } from '../../api/client';
import { checkEstimates, setupStageLines, shortDuration } from './SetupStatusPanel';

const base = (setup: Partial<NonNullable<WarehouseSetupStatus['setup']>>, stage: WarehouseSetupStatus['stage'], operation: WarehouseSetupStatus['operation'] = null): WarehouseSetupStatus => ({
  stage,
  operation,
  setup: { version: 1, connectionId: 'default', scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC', 'FINANCE'] }], check: true, read: { state: 'done', relations: 1240 }, ...setup },
});

describe('the Setup page (onboarding design P5)', () => {
  it('says every stage with its counts', () => {
    const operation = { id: 'op', type: 'warehouse-check', scope: 's', status: 'running' as const, phase: 'check', progress: 60, message: 'Checking keys and joins in SALES: 312 of 1,240 tables · 41 of 200 joins · 18 on samples · 3 min 05 s', cancellable: true, createdAt: '', updatedAt: '' };
    expect(setupStageLines(base({ checks: { state: 'running' } }, 'checking', operation)).map((line) => [line.tone, line.text])).toEqual([
      ['done', 'Read 1,240 tables in 2 schemas in SALES: names, types, comments, keys.'],
      ['done', 'Ready to ask. Answers are labeled AI-generated until you review the drafts.'],
      ['running', operation.message],
    ]);
    const done = setupStageLines(base({ checks: { state: 'done', proposalId: 'p', drafted: 1100, sampled: 18, search: 'meaning' } }, 'checked'));
    expect(done.map((line) => line.text).slice(2)).toEqual([
      expect.stringMatching(/^Data checks done.* · 18 tables checked on samples\.$/),
      'Search by meaning: on.',
      'Drafts ready: 1,100 models wait for review.',
    ]);
    expect(setupStageLines(base({ checks: { state: 'stopped' } }, 'ready'))[2]).toEqual({ key: 'checks', tone: 'caution', text: 'Data checks: stopped. Resume picks up where they stopped.' });
    expect(setupStageLines(base({ read: { state: 'failed', error: 'no access' } }, 'failed'))).toEqual([{ key: 'read', tone: 'caution', text: 'Reading names failed: no access' }]);
  });

  it('says whether Ask\'s Snowflake Cortex is set up, after the ready line (fix plan risk 3)', () => {
    const notReady = {
      state: 'missing_grant' as const, headline: 'Ask is not ready: ZLens may not use Snowflake Cortex yet.', message: 'The role cannot use Cortex.',
      fixIntro: 'An ACCOUNTADMIN runs this one line in Snowsight:', fixSql: 'GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;', checkedAt: '2026-11-26T18:00:00.000Z',
    };
    const lines = setupStageLines({ ...base({ checks: { state: 'stopped' } }, 'ready'), askReadiness: notReady });
    expect(lines.map((line) => line.key)).toEqual(['read', 'ready', 'ask', 'checks']);
    expect(lines[2]).toEqual({ key: 'ask', tone: 'caution', text: 'Ask is not ready: ZLens may not use Snowflake Cortex yet. The role cannot use Cortex. An ACCOUNTADMIN runs this one line in Snowsight: GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;' });
    const ready = setupStageLines({ ...base({ checks: { state: 'stopped' } }, 'ready'), askReadiness: { state: 'ready', headline: 'Ask is ready: it uses claude-sonnet-5-5 through Cortex SQL (AI_COMPLETE).', checkedAt: '' } });
    expect(ready[2]).toEqual({ key: 'ask', tone: 'done', text: 'Ask is ready: it uses claude-sonnet-5-5 through Cortex SQL (AI_COMPLETE).' });
    // Not checked yet, or Ask does not use Cortex: no Ask line.
    expect(setupStageLines({ ...base({ checks: { state: 'stopped' } }, 'ready'), askReadiness: null }).map((line) => line.key)).toEqual(['read', 'ready', 'checks']);
    expect(setupStageLines({ ...base({ checks: { state: 'stopped' } }, 'ready'), askReadiness: { state: 'not_applicable' } }).map((line) => line.key)).toEqual(['read', 'ready', 'checks']);
  });

  it('estimates the time left from the speed so far, and the credits on the app\'s X-Small warehouse', () => {
    const detail = { elapsedMs: 120_000, checks: { tablesChecked: 300, tables: 1200, joins: { done: 0, total: 0 }, largeTables: 0, resumed: 0 } };
    expect(checkEstimates({ detail }, true)).toBe('2 min so far · about 6 min left · about 0.03 credits (estimate)');
    expect(checkEstimates({ detail }, false)).toBe('2 min so far · about 6 min left (estimate)');
    // Too early to tell the time left.
    expect(checkEstimates({ detail: { ...detail, elapsedMs: 4_000, checks: { ...detail.checks, tablesChecked: 1 } } }, true)).toBe('4 s so far · under 0.01 credits (estimate)');
    expect(checkEstimates(null, true)).toBeNull();
    expect(shortDuration(5_400_000)).toBe('1.5 h');
  });
});
