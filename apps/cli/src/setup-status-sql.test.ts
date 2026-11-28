import { describe, expect, it } from 'vitest';
import { SetupStatusWriter, launcherAskReadiness, setupStatusStatement, setupStatusTable } from './setup-status-sql.js';
import { setupStatusLine, type WarehouseSetupStateV1 } from './warehouse-setup-state.js';

/** Onboarding design P5: setup's one line, kept in the app's core.setup_status for the launcher page. */
describe('setup status for the launcher page', () => {
  const state = (read: WarehouseSetupStateV1['read'], checks?: WarehouseSetupStateV1['checks']): WarehouseSetupStateV1 => ({
    version: 1, connectionId: 'default', scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC'] }], check: true, read, ...(checks ? { checks } : {}),
  });

  it('says where setup stands in one line', () => {
    expect(setupStatusLine(null, null)).toEqual({ stage: 'choose', line: 'Open ZLens and choose the data it reads.', percent: null });
    expect(setupStatusLine(state({ state: 'running' }), { status: 'running', progress: 18, type: 'warehouse-read', message: 'Reading names in SALES: 420 of 1,240 tables so far (statement 1 of 1) · 12 s' }))
      .toEqual({ stage: 'reading', line: 'Reading names: 420 of 1,240 tables so far (statement 1 of 1) · 12 s', percent: 18 });
    expect(setupStatusLine(state({ state: 'running' }), { status: 'running', progress: 1, type: 'warehouse-read', message: 'Reading names.' }).line).toBe('Reading names.');
    expect(setupStatusLine(state({ state: 'running' }), { status: 'running', progress: 40, type: 'warehouse-read', message: 'Reading keys and comments in SALES (statement 2 of 5): 85 tables · 3 s' }).line)
      .toBe('Reading keys and comments (statement 2 of 5): 85 tables · 3 s');
    expect(setupStatusLine(state({ state: 'done' }, { state: 'off' }), null).line).toBe('ZLens is ready to ask. Background checks are starting.');
    expect(setupStatusLine(state({ state: 'done' }, { state: 'running' }), { status: 'running', progress: 62, type: 'warehouse-check', message: '' }))
      .toEqual({ stage: 'checking', line: 'ZLens is ready to ask. Background checks: 24%.', percent: 24 });
    expect(setupStatusLine(state({ state: 'done' }, { state: 'done', proposalId: 'p1', problems: [{ relations: ['A'], kind: 'too_big', text: '' }] }), null))
      .toEqual({ stage: 'checked', line: 'ZLens is ready to ask. Background checks done: drafts wait for review; 1 table not checked.', percent: 100 });
    expect(setupStatusLine(state({ state: 'done' }, { state: 'stopped' }), null).line).toBe('ZLens is ready to ask. The background checks were stopped.');
  });

  // V18 p2 test (28 Nov 2026): after "Accept all that passed" and a save, the launcher still said drafts waited.
  it('says drafts wait for review only while some do', () => {
    const checked = state({ state: 'done' }, { state: 'done', proposalId: 'p1' });
    expect(setupStatusLine(checked, null, null, { draftsWaiting: () => true }).line).toBe('ZLens is ready to ask. Background checks done: drafts wait for review.');
    expect(setupStatusLine(checked, null, null, { draftsWaiting: () => false }))
      .toEqual({ stage: 'checked', line: 'ZLens is ready to ask. Background checks done.', percent: 100 });
    const withProblems = state({ state: 'done' }, { state: 'done', proposalId: 'p1', problems: [{ relations: ['A'], kind: 'too_big', text: '' }, { relations: ['B'], kind: 'failed', text: '' }] });
    expect(setupStatusLine(withProblems, null, null, { draftsWaiting: () => false }).line).toBe('ZLens is ready to ask. Background checks done; 2 tables not checked.');
    // Checks that drafted nothing leave nothing to review.
    expect(setupStatusLine(state({ state: 'done' }, { state: 'done' }), null).line).toBe('ZLens is ready to ask. Background checks done.');
    // Asked only once the checks are done.
    let asked = 0;
    setupStatusLine(state({ state: 'done' }, { state: 'running' }), null, null, { draftsWaiting: () => { asked += 1; return true; } });
    expect(asked).toBe(0);
  });

  it('keeps one row in the app\'s own table, with the values as literals', () => {
    expect(setupStatusTable('ZLENS_APP')).toBe('ZLENS_APP.CORE.SETUP_STATUS');
    expect(setupStatusTable('')).toBeNull();
    const sql = setupStatusStatement('ZLENS_APP.CORE.SETUP_STATUS', { stage: 'checking', line: "It's 25%.", percent: 25 });
    expect(sql).toContain("MERGE INTO ZLENS_APP.CORE.SETUP_STATUS t");
    expect(sql).toContain("'It''s 25%.' AS line, 25 AS percent");
  });

  it('writes a change of stage at once, progress at most every interval, and stops after a failure with one warning', async () => {
    const statements: string[] = [];
    const warnings: string[] = [];
    let now = 0;
    let fail = false;
    const writer = new SetupStatusWriter({
      appName: 'ZLENS_APP',
      query: async (sql) => { if (fail) throw new Error('not allowed'); statements.push(sql); },
      minIntervalMs: 30_000,
      now: () => now,
      warn: (message) => warnings.push(message),
    });
    await writer.write({ stage: 'reading', line: 'a', percent: 1 }, { force: true });
    now = 5_000;
    await writer.write({ stage: 'reading', line: 'b', percent: 2 });
    expect(statements).toHaveLength(1);
    now = 31_000;
    await writer.write({ stage: 'reading', line: 'c', percent: 3 });
    expect(statements).toHaveLength(2);
    fail = true;
    await writer.write({ stage: 'ready', line: 'd', percent: null }, { force: true });
    await writer.write({ stage: 'checking', line: 'e', percent: 5 }, { force: true });
    expect(warnings).toHaveLength(1);
    expect(statements).toHaveLength(2);
  });

  // Ask readiness (fix plan risk 3) rides in the same row: one write path, one launcher read.
  const notReady = {
    state: 'missing_grant',
    headline: 'Ask is not ready: ZLens may not use Snowflake Cortex yet.',
    message: "The Snowflake role ZLens signs in with cannot use Cortex. It's the CORTEX_USER grant (HTTP 403).",
    fixSql: 'GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;',
    fixIntro: 'An ACCOUNTADMIN runs this one line in Snowsight:',
    model: 'claude-sonnet-5-5',
    route: 'sql' as const,
    checkedAt: '2026-11-25T18:00:00.000Z',
  };
  const ready = { state: 'ready', headline: 'Ask is ready: it uses claude-sonnet-5-5 through Cortex SQL (AI_COMPLETE).', model: 'claude-sonnet-5-5', route: 'sql' as const, checkedAt: '2026-11-25T18:05:00.000Z' };

  it('carries Ask readiness, and says Ask is not ready where the line would say it is ready to ask', () => {
    expect(launcherAskReadiness(notReady)).toEqual({
      state: 'missing_grant', headline: notReady.headline, message: notReady.message, fixSql: notReady.fixSql, fixIntro: notReady.fixIntro,
      model: 'claude-sonnet-5-5', checkedAt: '2026-11-25T18:00:00.000Z',
    });
    expect(launcherAskReadiness({ state: 'checking', headline: 'Checking…' })).toBeUndefined();
    expect(launcherAskReadiness({ state: 'not_applicable' })).toBeUndefined();
    expect(launcherAskReadiness(null)).toBeUndefined();

    const checking = setupStatusLine(state({ state: 'done' }, { state: 'running' }), { status: 'running', progress: 62, type: 'warehouse-check', message: '' }, notReady);
    expect(checking).toEqual({ stage: 'checking', line: 'Ask is not ready: ZLens may not use Snowflake Cortex yet. Background checks: 24%.', percent: 24, askReadiness: launcherAskReadiness(notReady) });
    // A line that does not say "ready to ask" stays as it is; the readiness still rides in the row.
    expect(setupStatusLine(null, null, notReady)).toMatchObject({ line: 'Open ZLens and choose the data it reads.', askReadiness: { state: 'missing_grant' } });
    // Ready: the line is setup's own, and the row says which model Ask uses.
    expect(setupStatusLine(state({ state: 'done' }, { state: 'stopped' }), null, ready))
      .toEqual({ stage: 'ready', line: 'ZLens is ready to ask. The background checks were stopped.', percent: null, askReadiness: launcherAskReadiness(ready) });
    // Not checked yet: setup's row as it was.
    expect(setupStatusLine(null, null, null)).toEqual({ stage: 'choose', line: 'Open ZLens and choose the data it reads.', percent: null });
  });

  it('writes Ask readiness as JSON in ask_readiness, quoted safely, and NULL before a check', () => {
    const sql = setupStatusStatement('ZLENS_APP.CORE.SETUP_STATUS', setupStatusLine(null, null, { ...notReady, state: 'region', fixSql: "ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';" }));
    expect(sql).toContain('PARSE_JSON(');
    expect(sql).toContain('AS ask_readiness) s');
    expect(sql).toContain("''ANY_REGION''");
    expect(sql).toContain("It''s the CORTEX_USER grant");
    expect(sql).toContain('ask_readiness = s.ask_readiness');
    expect(sql).toContain('INSERT (id, updated_at, stage, line, percent, ask_readiness)');
    expect(setupStatusStatement('ZLENS_APP.CORE.SETUP_STATUS', { stage: 'ready', line: 'x', percent: null })).toContain('NULL AS ask_readiness');
  });
});
