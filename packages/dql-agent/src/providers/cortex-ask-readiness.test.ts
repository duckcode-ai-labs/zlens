import { afterEach, describe, expect, it, vi } from 'vitest';
import { CortexClaudeProvider, cortexModelChoice, resetCortexModelChoice, resetCortexRoute } from './claude-cortex.js';
import { checkCortexAsk } from './cortex-ask-readiness.js';

/**
 * Ask readiness, checked against a fake fetch and SQL runner with Snowflake's error shapes (its REST API docs and
 * the live 003001 refusal). Never calls Snowflake.
 */
const token = async () => ({ token: 't', type: 'OAUTH' as const });
const now = () => new Date('2026-11-25T18:00:00Z');
const ok = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200 });
const bodyModel = (init: RequestInit | undefined) => JSON.parse(String(init?.body)).model as string;

afterEach(() => {
  vi.unstubAllGlobals();
  resetCortexModelChoice();
  resetCortexRoute();
});

describe('the Ask readiness check', () => {
  it('is ready with one one-token call, and says which model Ask uses', async () => {
    const fetch = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetch);
    const readiness = await checkCortexAsk(new CortexClaudeProvider({ host: 'ready.snowflakecomputing.com', token }), { appName: 'ZLENS_APP', now });
    expect(readiness).toEqual({
      state: 'ready',
      headline: 'Ask is ready: it uses claude-sonnet-5-5 through Snowflake Cortex.',
      model: 'claude-sonnet-5-5',
      route: 'rest',
      checkedAt: '2026-11-25T18:00:00.000Z',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ max_tokens: 1 });
  });

  it('is ready with no admin step when Snowflake keeps the REST API off (003001) and AI_COMPLETE answers, the usual case', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: '003001', message: 'This account is not allowed to access this endpoint. Please contact Snowflake support.' }), { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const statements: string[] = [];
    const sql = async (statement: string) => { statements.push(statement); return [{ R: JSON.stringify({ choices: [{ messages: 'OK' }], usage: {} }) }]; };
    const readiness = await checkCortexAsk(new CortexClaudeProvider({ host: 'sqlonly.snowflakecomputing.com', token, sql, grantee: { appName: 'ZLENS_APP' } }), { now });
    expect(readiness).toEqual({
      state: 'ready',
      headline: 'Ask is ready: it uses claude-sonnet-5-5 through Cortex SQL (AI_COMPLETE).',
      model: 'claude-sonnet-5-5',
      route: 'sql',
      checkedAt: '2026-11-25T18:00:00.000Z',
    });
    expect(statements).toHaveLength(1);
    expect(JSON.stringify(readiness)).not.toMatch(/support|GRANT|ALTER/i);
  });

  it('names the grant with the app\'s real name when CORTEX_USER is missing (REST 403, or SQL "Unknown function")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Not Authorized' }), { status: 403 })));
    const rest = await checkCortexAsk(new CortexClaudeProvider({ host: 'grant.snowflakecomputing.com', token }), { appName: 'ZLENS_APP', now });
    expect(rest).toMatchObject({
      state: 'missing_grant',
      headline: 'Ask is not ready: ZLens may not use Snowflake Cortex yet.',
      fixSql: 'GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;',
      fixIntro: 'An ACCOUNTADMIN runs this one line in Snowsight:',
    });
    expect(rest.message).toContain('grant it the SNOWFLAKE.CORTEX_USER database role (for the ZLens app: GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP)');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: '003001', message: 'This account is not allowed to access this endpoint.' }), { status: 403 })));
    const sql = async () => { throw new Error('SQL compilation error:\nUnknown function AI_COMPLETE'); };
    const viaSql = await checkCortexAsk(new CortexClaudeProvider({ host: 'grant-sql.snowflakecomputing.com', token, sql }), { role: 'ANALYST', now });
    expect(viaSql).toMatchObject({ state: 'missing_grant', fixSql: 'GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE ANALYST;', route: 'sql' });
  });

  it('falls back by region and says so; with no Claude model in the region, gives the cross-region line', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (bodyModel(init) === 'claude-opus-5-5'
      ? ok()
      : new Response(JSON.stringify({ message: `Model ${bodyModel(init)} is not available in your region.` }), { status: 400 }))));
    const japan = await checkCortexAsk(new CortexClaudeProvider({ host: 'jp.snowflakecomputing.com', token }), { now });
    expect(japan).toMatchObject({
      state: 'ready',
      model: 'claude-opus-5-5',
      fellBackFrom: 'claude-sonnet-5-5',
      headline: 'Ask is ready: it uses claude-opus-5-5 through Snowflake Cortex, because Snowflake Cortex does not offer claude-sonnet-5-5 to your account.',
    });

    // Every Claude model refused (an Azure account, or cross-region DISABLED), whether as "region" or "unknown model".
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ message: `unknown model "${bodyModel(init)}"` }), { status: 400 })));
    const azure = await checkCortexAsk(new CortexClaudeProvider({ host: 'azure.snowflakecomputing.com', token }), { appName: 'ZLENS_APP', now });
    expect(azure).toMatchObject({
      state: 'region',
      headline: 'Ask is not ready: Snowflake Cortex offers no Claude model to your account in its region.',
      fixSql: "ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';",
      fixIntro: 'An ACCOUNTADMIN runs this one line in Snowsight:',
    });
    expect(azure.message).toContain('allow cross-region inference');
  });

  it('tells a model a person named that Cortex does not offer, with no SQL to run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'unknown model "claude-opus-4-1"' }), { status: 400 })));
    const named = await checkCortexAsk(new CortexClaudeProvider({ host: 'named.snowflakecomputing.com', model: 'claude-opus-4-1', token }), { now });
    expect(named).toMatchObject({
      state: 'model_unavailable',
      model: 'claude-opus-4-1',
      headline: 'Ask is not ready: Snowflake Cortex does not offer claude-opus-4-1 in your account.',
    });
    expect(named.fixSql).toBeUndefined();
    expect(named.message).toContain('Pick another Claude model in Settings » AI');
  });

  it('keeps anything else in Snowflake\'s words, and a check that runs out of time says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"The request body is too large."}', { status: 413 })));
    const busy = await checkCortexAsk(new CortexClaudeProvider({ host: 'busy.snowflakecomputing.com', token }), { now });
    expect(busy).toMatchObject({ state: 'other', headline: 'Ask is not ready: Snowflake Cortex did not answer a one-word test.' });
    expect(busy.message).toContain('413');
    expect(busy.message).toContain('The request body is too large.');

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      // As fetch does: an aborted signal ends the request, also one aborted before it was sent.
      if (init?.signal?.aborted) reject(init.signal.reason);
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    const controller = new AbortController();
    const slow = checkCortexAsk(new CortexClaudeProvider({ host: 'slow.snowflakecomputing.com', token }), { signal: controller.signal, now });
    controller.abort(new Error('time limit'));
    expect(await slow).toMatchObject({ state: 'other', message: 'Snowflake Cortex did not answer within the time the check allows. Try again in a minute.' });
  });

  it('"Check again" forgets a fallback, so an account whose admin allowed cross-region returns to the default', async () => {
    const fetch = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetch);
    const provider = new CortexClaudeProvider({ host: 'later.snowflakecomputing.com', token });
    // As if an earlier check had fallen back.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (bodyModel(init) === 'claude-sonnet-5-5'
      ? new Response(JSON.stringify({ message: 'Model claude-sonnet-5-5 is not available in your region.' }), { status: 400 })
      : ok())));
    await checkCortexAsk(provider, { now });
    expect(cortexModelChoice('later.snowflakecomputing.com')?.model).toBe('claude-opus-5-5');
    vi.stubGlobal('fetch', fetch);
    const again = await checkCortexAsk(provider, { fresh: true, now });
    expect(again).toMatchObject({ state: 'ready', model: 'claude-sonnet-5-5' });
    expect(again.fellBackFrom).toBeUndefined();
    expect(cortexModelChoice('later.snowflakecomputing.com')).toBeUndefined();
  });
});
