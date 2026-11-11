import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handleAppsApi } from './apps-api.js';
import { withRequestContext, type DqlRequestContext } from './host/request-context.js';
import { answerLongRequest, clearLongRequestsForTests, handleLongRequestPoll, LONG_REQUEST_PATH } from './long-request.js';

/**
 * New-user test V10 on the Snowflake Native App: "Describe with AI" showed
 * "AI picks · Looking…" for 80–90 s, then a red "upstream request timeout",
 * 3 of 3 times. The Snowflake ingress ends a request with no answer after
 * 90 s and sends its own 504; the planner call on Cortex took longer.
 *
 * Here a proxy does what the ingress does: a request that has no answer
 * within ROUTE_LIMIT_MS gets 504 "upstream request timeout". The planner takes
 * PLANNER_MS, longer than that. The times are 90 s and ~120 s, scaled down.
 */
const ROUTE_LIMIT_MS = 1_500;
const PLANNER_MS = 4_000;
/** The client's `Prefer: wait`, in seconds: under the route limit. */
const WAIT_S = 1;

const dirs: string[] = [];
const servers: Server[] = [];
let root = '';
let direct = '';
let proxied = '';
let plannerReply: () => string = () => '';

function brief(sourceId: string): string {
  return JSON.stringify({
    frame: { goal: 'Regional order health', metrics: ['orders'], dimensions: ['region'], filters: ['order_date'] },
    requirements: [
      { id: 'r-orders', question: 'Orders by region', role: 'breakdown', required: true, measures: ['orders'], dimensions: ['region'], filters: ['order_date'] },
    ],
    components: [
      { id: 'orders-chart', title: 'Orders by region', sourceId, requirementIds: ['r-orders'], role: 'breakdown', view: 'bar', rationale: 'Exact regional draft block' },
    ],
  });
}

/** ZLens's App Builder routes and the long-request poll, with a planner as slow as Cortex was. */
function startAppsServer(): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (await handleLongRequestPoll(req, res, url.pathname)) return;
      const handled = await handleAppsApi({
        req,
        res,
        url,
        path: url.pathname,
        projectRoot: root,
        planAppBuild: async () => {
          await new Promise((done) => setTimeout(done, PLANNER_MS));
          return { content: plannerReply(), providerId: 'cortex' };
        },
      });
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    })();
  });
  servers.push(server);
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}

/** A proxy that answers 504 "upstream request timeout" for a request with no answer within `limitMs`, as the ingress does. */
function startIngressLikeProxy(upstream: string, limitMs: number): Promise<{ url: string; cuts: () => number }> {
  let cuts = 0;
  const target = new URL(upstream);
  const server = createServer((req, res) => {
    const forward = httpRequest({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
      clearTimeout(timer);
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    const timer = setTimeout(() => {
      cuts += 1;
      forward.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('upstream request timeout');
      } else res.destroy();
    }, limitMs);
    forward.on('error', () => undefined);
    req.pipe(forward);
  });
  servers.push(server);
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    cuts: () => cuts,
  })));
}

async function call(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: response.status, body, text };
}

/** What the notebook's `requestLong` does: ask with `Prefer: respond-async`, then poll by id. */
async function askLong(base: string, path: string, payload: unknown): Promise<{ status: number; body: any; text: string; polls: number }> {
  let answer = await call(base, path, { method: 'POST', body: JSON.stringify(payload), headers: { Prefer: `respond-async, wait=${WAIT_S}` } });
  let polls = 0;
  while (answer.status === 202 && answer.body?.longRequest?.state === 'running') {
    polls += 1;
    answer = await call(base, `${LONG_REQUEST_PATH}${answer.body.longRequest.id}`, { headers: { Prefer: `wait=${WAIT_S}` } });
  }
  return { ...answer, polls };
}

async function newDraft(): Promise<{ id: string; revision: number; proposalHash: string; sourceId: string }> {
  const created = await call(direct, '/api/app-builds', {
    method: 'POST',
    body: JSON.stringify({ name: 'Regional orders', goal: 'Show orders by region', authoringMode: 'ai', sourcePolicy: 'include_review_required', domain: 'sales' }),
  });
  const draft = created.body.draft;
  const catalog = await call(direct, `/api/app-builds/${draft.id}/source-candidates?q=orders&limit=50`);
  return { id: draft.id, revision: draft.revision, proposalHash: draft.proposalHash, sourceId: catalog.body.items[0].sourceId };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'zlens-app-builder-long-'));
  dirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), '{}\n');
  mkdirSync(join(root, 'blocks', 'sales'), { recursive: true });
  writeFileSync(join(root, 'blocks', 'sales', 'orders-by-region.dql'), `block "Orders by Region" {
  domain = "sales"
  status = "draft"
  type = "custom"
  description = "Draft regional order totals"
  owner = "analytics@local"
  tags = ["orders", "region"]
  dimensions = ["region"]
  allowedFilters = ["order_date", "region"]

  query = """
SELECT 'west' AS region, 10 AS orders
"""

  visualization {
    chart = "bar"
  }
}
`);
  direct = await startAppsServer();
  proxied = (await startIngressLikeProxy(direct, ROUTE_LIMIT_MS)).url;
}, 60_000);

afterAll(async () => {
  clearLongRequestsForTests();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Describe with AI behind an ingress that ends slow requests', () => {
  it('as one long request (before), the ingress answers "upstream request timeout" and no proposal arrives', async () => {
    const draft = await newDraft();
    plannerReply = () => brief(draft.sourceId);
    const answer = await call(proxied, `/api/app-builds/${draft.id}/ai-proposals`, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Show orders by region', expectedRevision: draft.revision, proposalHash: draft.proposalHash }),
    });
    expect(answer.status).toBe(504);
    expect(answer.text).toBe('upstream request timeout');
  }, 30_000);

  it('asked as a long request, the proposal arrives after the planner, with no request outlasting the limit', async () => {
    const draft = await newDraft();
    plannerReply = () => brief(draft.sourceId);
    const started = Date.now();
    const answer = await askLong(proxied, `/api/app-builds/${draft.id}/ai-proposals`, {
      prompt: 'Show orders by region', expectedRevision: draft.revision, proposalHash: draft.proposalHash,
    });
    expect(Date.now() - started).toBeGreaterThan(ROUTE_LIMIT_MS);
    expect(answer.status, answer.text.slice(0, 300)).toBe(201);
    expect(answer.body.proposal.plannerProvenance).toMatchObject({ mode: 'ai', providerInvocation: 'succeeded', providerId: 'cortex' });
    expect(answer.polls).toBeGreaterThan(0);
  }, 30_000);

  it('a real failure arrives as the route\'s own answer, not as a proxy timeout', async () => {
    const draft = await newDraft();
    plannerReply = () => 'not json';
    const answer = await askLong(proxied, `/api/app-builds/${draft.id}/ai-proposals`, {
      prompt: 'Show orders by region', expectedRevision: draft.revision, proposalHash: draft.proposalHash,
    });
    expect(answer.status).toBe(400);
    // The page turns this code into plain words (app-studio-words.ts).
    expect(answer.body.error).toMatch(/^APP_BUILD_PLANNER_OUTPUT_INVALID/);
    expect(answer.text).not.toMatch(/upstream request timeout/);
  }, 30_000);

  it('a quick answer comes back at once, in one request', async () => {
    const draft = await newDraft();
    const answer = await askLong(proxied, `/api/app-builds/${draft.id}/ai-proposals`, {
      prompt: 'Show orders by region', expectedRevision: draft.revision - 1, proposalHash: draft.proposalHash,
    });
    expect(answer.status).toBe(409);
    expect(answer.polls).toBe(0);
  }, 30_000);
});

describe('the long-request answer', () => {
  it('is kept for the person who started it, and nobody else reads it', async () => {
    const ana: DqlRequestContext = { requestId: 'r1', principal: { id: 'ana', source: 'host' } as DqlRequestContext['principal'] };
    const ben: DqlRequestContext = { requestId: 'r2', principal: { id: 'ben', source: 'host' } as DqlRequestContext['principal'] };
    const captured: Array<{ status: number; body: any }> = [];
    const response = (): ServerResponse => {
      const entry = { status: 0, body: undefined as any };
      captured.push(entry);
      return {
        writeHead(status: number) { entry.status = status; return this; },
        end(chunk?: string) { entry.body = chunk ? JSON.parse(chunk) : undefined; return this; },
      } as unknown as ServerResponse;
    };
    const asking = (prefer: string): IncomingMessage => {
      const req = Readable.from([]) as IncomingMessage;
      req.method = 'GET';
      req.headers = { prefer };
      return req;
    };
    const post = asking('respond-async, wait=0');
    post.resume();
    await new Promise((done) => post.once('end', done));
    await withRequestContext(ana, () => answerLongRequest(post, response(), async () => {
      await new Promise((done) => setTimeout(done, 200));
      return { status: 201, body: { ok: true, secret: 'ana-only' } };
    }));
    const started = captured[0]!;
    expect(started.status).toBe(202);
    const pollPath = `${LONG_REQUEST_PATH}${started.body.longRequest.id}`;
    await withRequestContext(ben, () => handleLongRequestPoll(asking('wait=1'), response(), pollPath));
    expect(captured[1]).toMatchObject({ status: 404, body: { code: 'LONG_REQUEST_NOT_FOUND' } });
    await withRequestContext(ana, () => handleLongRequestPoll(asking('wait=1'), response(), pollPath));
    expect(captured[2]).toEqual({ status: 201, body: { ok: true, secret: 'ana-only' } });
  });

  it('says in plain words when it no longer has the request', async () => {
    const answer = await call(direct, `${LONG_REQUEST_PATH}no-such-request`);
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ ok: false, code: 'LONG_REQUEST_NOT_FOUND', error: 'ZLens no longer has this request. It may have restarted. Try again.' });
  });

  it('a caller that does not ask is answered in one request, as before', async () => {
    const draft = await newDraft();
    plannerReply = () => brief(draft.sourceId);
    const answer = await call(direct, `/api/app-builds/${draft.id}/ai-proposals`, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Show orders by region', expectedRevision: draft.revision, proposalHash: draft.proposalHash }),
    });
    expect(answer.status).toBe(201);
    expect(answer.body.proposal).toBeTruthy();
  }, 30_000);
});
