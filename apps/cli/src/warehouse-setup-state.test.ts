import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { plainSetupError, readWarehouseSetupState, setupStatusLine, timeLimitProblemText, warehouseSetupStatePath } from './warehouse-setup-state.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('setup errors in plain words (the Snowflake large test, 26 Nov 2026)', () => {
  it('says a statement ran into its time limit, never the driver\'s words', () => {
    expect(plainSetupError('Snowflake query failed: SQL execution canceled')).toBe('a statement took longer than its time limit, so ZLens stopped it');
    expect(plainSetupError('Snowflake query exceeded the 60000ms deadline.')).toBe('a statement took longer than 60 seconds, so ZLens stopped it');
    expect(plainSetupError('Statement reached its statement or warehouse timeout of 60 second(s) and was canceled.')).toBe('a statement took longer than its time limit, so ZLens stopped it');
    // Any other error keeps its own words.
    expect(plainSetupError('Snowflake query failed: SQL compilation error: Object does not exist')).toBe('Snowflake query failed: SQL compilation error: Object does not exist');
  });

  it('says what a skipped check means: not checked, the drafts do not rely on it, Ask still uses it', () => {
    expect(timeLimitProblemText('LINEITEM', 1, 60)).toBe('LINEITEM: not checked. A check took longer than the 60-second limit for background checks, so ZLens skipped it, and the drafts do not rely on it. Ask can still use it: its columns were read.');
    expect(timeLimitProblemText('LINEITEM and ORDERS', 2, 60)).toContain('Ask can still use them: their columns were read.');
  });

  it('a state an earlier build saved reads the same plain way, on the page and on the launcher', () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-setup-state-'));
    roots.push(root);
    const path = warehouseSetupStatePath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 1,
      connectionId: 'default',
      scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC'] }],
      check: true,
      read: { state: 'failed', error: 'Snowflake query failed: SQL execution canceled' },
      checks: {
        state: 'done',
        problems: [
          { relations: ['SALES.VIEWS.LINEITEM', 'SALES.VIEWS.ORDERS'], kind: 'failed', text: 'LINEITEM and ORDERS: a check failed: Snowflake query failed: SQL execution canceled' },
          { relations: ['SALES.PUBLIC.EVENTS'], kind: 'failed', text: 'EVENTS: a check failed: Snowflake query failed: SQL compilation error: invalid identifier' },
        ],
      },
    }));
    const state = readWarehouseSetupState(root)!;
    expect(state.read.error).toBe('a statement took longer than its time limit, so ZLens stopped it');
    expect(state.checks?.problems).toEqual([
      { relations: ['SALES.VIEWS.LINEITEM', 'SALES.VIEWS.ORDERS'], kind: 'too_big', text: timeLimitProblemText('LINEITEM and ORDERS', 2, 60) },
      { relations: ['SALES.PUBLIC.EVENTS'], kind: 'failed', text: 'EVENTS: a check failed: Snowflake query failed: SQL compilation error: invalid identifier' },
    ]);
    expect(JSON.stringify(state)).not.toContain('SQL execution canceled');
    const line = setupStatusLine(state, null, null);
    expect(line.line).toBe('ZLens could not read the chosen schemas: a statement took longer than its time limit, so ZLens stopped it');
  });
});
