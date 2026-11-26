import { afterEach, describe, expect, it, vi } from 'vitest';
import { CortexClaudeProvider, type CortexAskReadiness } from '@zlens/agent';
import { AskReadinessCheck } from './ask-readiness.js';

/** Ask readiness as the server keeps it (the launcher's copy rides in core.setup_status: setup-status-sql.test.ts). No Snowflake. */
const token = async () => ({ token: 't', type: 'OAUTH' as const });
const provider = (model?: string) => new CortexClaudeProvider({ host: 'acct.snowflakecomputing.com', token, ...(model ? { model } : {}) });

const notReady: CortexAskReadiness = {
  state: 'missing_grant',
  headline: 'Ask is not ready: ZLens may not use Snowflake Cortex yet.',
  message: "The Snowflake role ZLens signs in with cannot use Cortex. It's the CORTEX_USER grant (HTTP 403).",
  fixSql: 'GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;',
  fixIntro: 'An ACCOUNTADMIN runs this one line in Snowsight:',
  model: 'claude-sonnet-5-5',
  route: 'sql',
  checkedAt: '2026-11-25T18:00:00.000Z',
};
const ready: CortexAskReadiness = { state: 'ready', headline: 'Ask is ready: it uses claude-sonnet-5-5 through Cortex SQL (AI_COMPLETE).', model: 'claude-sonnet-5-5', route: 'sql', checkedAt: '2026-11-25T18:05:00.000Z' };

afterEach(() => vi.useRealTimers());

describe('the server\'s Ask readiness', () => {
  it('is not applicable when Ask does not use Cortex, and checks nothing', async () => {
    const check = vi.fn();
    const readiness = new AskReadinessCheck({ provider: () => null, check });
    expect(await readiness.read()).toEqual({ state: 'not_applicable' });
    expect(await readiness.check({ fresh: true })).toEqual({ state: 'not_applicable' });
    expect(check).not.toHaveBeenCalled();
  });

  it('says it is checking until the first check answers, then keeps the result for a while, and "Check again" runs fresh', async () => {
    let clock = 0;
    let answer!: (value: CortexAskReadiness) => void;
    const check = vi.fn((_provider: CortexClaudeProvider, _options?: { fresh?: boolean }) => new Promise<CortexAskReadiness>((resolve) => { answer = resolve; }));
    const readiness = new AskReadinessCheck({ provider: () => provider(), check, now: () => clock, ttlMs: 1_000, retryMs: 60_000 });
    expect(await readiness.read()).toMatchObject({ state: 'checking' });
    // A second read while the check runs does not start another.
    expect(await readiness.read()).toMatchObject({ state: 'checking' });
    expect(check).toHaveBeenCalledTimes(1);
    expect(readiness.latest()).toBeNull();
    answer(ready);
    await vi.waitFor(async () => expect(await readiness.read()).toEqual(ready));
    expect(readiness.latest()).toEqual(ready);
    expect(check).toHaveBeenCalledTimes(1);
    // Stale: answered at once with the last result, while a new check runs.
    clock = 2_000;
    expect(await readiness.read()).toEqual(ready);
    expect(check).toHaveBeenCalledTimes(2);
    answer(ready);
    const again = readiness.check({ fresh: true });
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(3));
    answer(notReady);
    expect(await again).toEqual(notReady);
    expect(check.mock.calls.at(-1)![1]).toMatchObject({ fresh: true });
    readiness.stop();
  });

  it('checks for the provider\'s own grantee (the app), and a changed model is a new check', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const check = vi.fn(async (_provider: CortexClaudeProvider, options?: object) => { seen.push({ ...options }); return ready; });
    let current = new CortexClaudeProvider({ host: 'acct.snowflakecomputing.com', token, grantee: { appName: 'ZLENS_APP' } });
    const readiness = new AskReadinessCheck({ provider: () => current, check });
    await readiness.check();
    expect(seen[0]).toMatchObject({ appName: 'ZLENS_APP', fresh: false });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    current = provider('claude-opus-5-5');
    expect(await readiness.read()).toMatchObject({ state: 'checking' });
    readiness.stop();
  });

  it('while Ask is not ready, checks again every few minutes for an hour, and tells each result with whether it changed', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const results = [notReady, notReady, ready];
    const check = vi.fn(async () => results.shift() ?? ready);
    const told: Array<[string, boolean]> = [];
    const readiness = new AskReadinessCheck({
      provider: () => provider(), check, now: () => clock, retryMs: 5 * 60_000, retryForMs: 60 * 60_000,
      onResult: (result, changed) => { told.push([result.state, changed]); },
    });
    await readiness.check();
    expect(told).toEqual([['missing_grant', true]]);
    clock += 5 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(told).toEqual([['missing_grant', true], ['missing_grant', false]]);
    clock += 5 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(told.at(-1)).toEqual(['ready', true]);
    // Ready: no more checks by themselves.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('stops checking by itself an hour after Ask was first seen not ready', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const check = vi.fn(async () => notReady);
    const readiness = new AskReadinessCheck({ provider: () => provider(), check, now: () => clock, retryMs: 20 * 60_000, retryForMs: 60 * 60_000 });
    await readiness.check();
    for (let i = 0; i < 6; i += 1) {
      clock += 20 * 60_000;
      await vi.advanceTimersByTimeAsync(20 * 60_000);
    }
    // At 0, 20, 40 and 60 minutes; none after the hour.
    expect(check).toHaveBeenCalledTimes(4);
  });
});
