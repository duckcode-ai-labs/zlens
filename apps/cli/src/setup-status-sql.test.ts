import { describe, expect, it } from 'vitest';
import { SetupStatusWriter, setupStatusStatement, setupStatusTable } from './setup-status-sql.js';
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
    expect(setupStatusLine(state({ state: 'done' }, { state: 'done', problems: [{ relations: ['A'], kind: 'too_big', text: '' }] }), null))
      .toEqual({ stage: 'checked', line: 'ZLens is ready to ask. Background checks done: drafts wait for review; 1 table not checked.', percent: 100 });
    expect(setupStatusLine(state({ state: 'done' }, { state: 'stopped' }), null).line).toBe('ZLens is ready to ask. The background checks were stopped.');
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
});
