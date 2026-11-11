import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from './client';

/**
 * New-user test V10: "Describe with AI" ended 3 of 3 times in a red
 * "upstream request timeout". The Snowflake ingress ends a request that has no
 * answer after 90 s, and the App Builder planner on Cortex took longer. The
 * page now asks for a long request and follows it by id, and a proxy's own
 * failure text is never shown.
 */
let client: typeof ClientModule;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  client = await import('./client');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const running = (id = 'job-1') => json(202, { ok: true, longRequest: { id, state: 'running', poll: `/api/long-requests/${id}` } });
const proposal = { ok: true, proposal: { id: 'proposal-1' } };
const input = { prompt: 'Warriors scoring by season', expectedRevision: 3, proposalHash: 'sha256:h' };

function scripted(responses: Array<Response | Error>): { calls: Array<{ url: string; method: string; prefer: string | null }> } {
  const calls: Array<{ url: string; method: string; prefer: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method ?? 'GET'), prefer: new Headers(init?.headers).get('Prefer') });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return next;
  }));
  return { calls };
}

describe('Describe with AI as a long request', () => {
  it('asks for an asynchronous answer, then follows the request by id until its own answer arrives', async () => {
    const { calls } = scripted([running(), running(), json(201, proposal)]);
    const answer = await client.api.proposeAppBuildChanges('draft-1', input);
    expect(answer).toEqual(proposal);
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://localhost').pathname, call.prefer])).toEqual([
      ['POST', '/api/app-builds/draft-1/ai-proposals', `respond-async, wait=${client.LONG_REQUEST_WAIT_SECONDS}`],
      ['GET', '/api/long-requests/job-1', `wait=${client.LONG_REQUEST_WAIT_SECONDS}`],
      ['GET', '/api/long-requests/job-1', `wait=${client.LONG_REQUEST_WAIT_SECONDS}`],
    ]);
  });

  it('a quick answer needs no second request', async () => {
    const { calls } = scripted([json(201, proposal)]);
    expect(await client.api.proposeAppBuildChanges('draft-1', input)).toEqual(proposal);
    expect(calls).toHaveLength(1);
  });

  it('asks again after a dropped poll, and keeps following the same request', async () => {
    const { calls } = scripted([
      running(),
      new TypeError('network error'),
      new Response('upstream request timeout', { status: 504, headers: { 'content-type': 'text/plain' } }),
      json(201, proposal),
    ]);
    const answer = await client.requestLong('/api/app-builds/draft-1/ai-proposals', { method: 'POST', body: '{}' }, { retryDelayMs: () => 1 });
    expect(answer).toEqual(proposal);
    expect(calls.slice(1).every((call) => new URL(call.url, 'http://localhost').pathname === '/api/long-requests/job-1')).toBe(true);
  });

  it('a failure of the work is the route\'s own error, as one request would have given it', async () => {
    scripted([running(), json(400, { ok: false, error: 'APP_BUILD_PLANNER_OUTPUT_INVALID: the configured App Builder provider did not return valid JSON for the build brief.' })]);
    await expect(client.api.proposeAppBuildChanges('draft-1', input)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/^APP_BUILD_PLANNER_OUTPUT_INVALID/),
    });
  });

  it('says so in plain words when the server no longer has the request', async () => {
    scripted([running(), json(404, { ok: false, code: 'LONG_REQUEST_NOT_FOUND', error: 'ZLens no longer has this request. It may have restarted. Try again.' })]);
    await expect(client.api.proposeAppBuildChanges('draft-1', input)).rejects.toMatchObject({
      code: 'LONG_REQUEST_NOT_FOUND',
      message: 'ZLens no longer has this request. It may have restarted. Try again.',
    });
  });

  it('stops after a few dropped polls in a row', async () => {
    const dropped = () => new TypeError('network error');
    scripted([running(), dropped(), dropped(), dropped(), dropped(), dropped(), dropped()]);
    await expect(client.requestLong('/api/app-builds/draft-1/ai-proposals', { method: 'POST', body: '{}' }, { retryDelayMs: () => 1 }))
      .rejects.toThrow(/Unable to reach/);
  });

  it('the other long App Builder requests are asked the same way', async () => {
    const { calls } = scripted([json(201, proposal), json(201, { ok: true }), json(200, { ok: true }), json(200, { ok: true }), json(200, { ok: true })]);
    await client.api.reviseAppBuildProposal('draft-1', 'p-1', { expectedRevision: 3, expectedProposalHash: 'sha256:h' });
    await client.api.generateAppBuildGap('draft-1', 'p-1', { expectedRevision: 3, expectedProposalHash: 'sha256:h', requirementId: 'r-1' });
    await client.api.composeAppBuild('draft-1', { expectedRevision: 3, expectedProposalHash: 'sha256:h', mode: 'ai', proposalId: 'p-1', selectedSourceIds: [] });
    await client.api.draftAppBuildStory('draft-1', 'overview', 'run-1');
    await client.api.draftAppBuildCanvas('draft-1', 'overview', 'run-1');
    expect(calls.every((call) => call.prefer === `respond-async, wait=${client.LONG_REQUEST_WAIT_SECONDS}`)).toBe(true);
  });
});

describe('a proxy\'s own failure, in plain words', () => {
  it('never shows "upstream request timeout"', async () => {
    scripted([new Response('upstream request timeout', { status: 504, headers: { 'content-type': 'text/plain' } })]);
    const failure = await client.api.listAppBuilds().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(client.DqlApiError);
    expect((failure as Error).message).toBe('This took longer than the connection to ZLens allows, so it was cut off. Try again.');
    expect((failure as InstanceType<typeof client.DqlApiError>).details).toEqual({ technicalDetails: 'upstream request timeout' });
  });

  it('reads only proxy pages, never ZLens\'s own JSON', () => {
    expect(client.proxyFailureWords(504, 'upstream request timeout')).toMatch(/took longer than the connection/);
    expect(client.proxyFailureWords(503, 'no healthy upstream')).toBe('ZLens is starting or restarting. Try again in a minute.');
    expect(client.proxyFailureWords(502, 'upstream connect error or disconnect/reset before headers')).toBe('ZLens could not be reached just now. Try again in a minute.');
    expect(client.proxyFailureWords(503, JSON.stringify({ error: 'The warehouse is busy.' }))).toBeUndefined();
    expect(client.proxyFailureWords(400, 'bad input')).toBeUndefined();
  });
});
