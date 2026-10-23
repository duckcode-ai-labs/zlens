import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRunExecutors } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { askTraceReason, startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * Ask observability with a host: a person who reviews answers (`hint.review`, the steward) opens any person's
 * trace from the list; everyone else opens only their own.
 */
const wes: DqlPrincipal = { id: 'u-wes', kind: 'person', email: 'wes@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };
const sam: DqlPrincipal = { id: 'u-sam', kind: 'person', email: 'sam@harbor.example', source: 'host' };
const people: Record<string, DqlPrincipal> = { wes, dan, sam };

const servers: Server[] = [];
let projectRoot = '';
let base = '';
let wesRunId = '';

const call = async (person: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-person': person },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, text, body: parsed };
};

const answerExecutor = ((input: { request: { question: string } }) => ({
  summary: `Answer to ${input.request.question}`,
  answer: `Answer to ${input.request.question}`,
  status: 'completed',
  trustState: 'governed',
  stopReason: 'governed_semantic_answer',
  artifacts: [{ id: 'answer-1', kind: 'answer', title: 'Answer from Metrics', trustState: 'governed', payload: { text: 'ok', result: { columns: ['q'], rows: [{ q: 1 }], rowCount: 1 } } }],
  evaluations: [],
  nextActions: [],
})) as unknown as NonNullable<AgentRunExecutors['generated_answer']>;

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-steward-trace-detail-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'steward-traces' }));
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    agentRunExecutors: { conversation: answerExecutor, generated_answer: answerExecutor, semantic_answer: answerExecutor, certified_answer: answerExecutor },
    hostHooks: {
      resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
      authorize: (principal, action) => ({ allow: action !== 'hint.review' || principal.id === sam.id, reason: 'Only a steward may review.' }),
    },
    captureServer: (created) => { servers.push(created); },
  });
  base = `http://127.0.0.1:${port}`;
  const asked = await call('wes', 'POST', '/api/agent-runs', { question: 'How many claims did Wes ask about?' });
  expect(asked.status).toBeLessThan(300);
  wesRunId = String(asked.body?.run?.id ?? asked.body?.id ?? '');
  expect(wesRunId).not.toBe('');
  expect((await call('dan', 'POST', '/api/agent-runs', { question: 'How many claims did Dan ask about?' })).status).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

type Listed = { traces: Array<{ traceId: string; runId: string }> };

/** Wes's trace, found the way a steward finds it: in the steward's own list of everyone's questions. */
const wesTraceFromStewardList = async () => {
  const stewardList = (await call('sam', 'GET', '/api/ask-traces?limit=100')).body as Listed;
  const wesTrace = stewardList.traces.find((trace) => trace.runId === wesRunId);
  expect(wesTrace).toBeTruthy();
  return wesTrace!;
};

describe('opening a trace', () => {
  it('lets a steward open another person\'s trace, by id and by run', async () => {
    const wesTrace = await wesTraceFromStewardList();
    const byId = await call('sam', 'GET', `/api/ask-traces/${wesTrace.traceId}`);
    expect(byId.status).toBe(200);
    const byRun = await call('sam', 'GET', `/api/ask-traces/by-run/${encodeURIComponent(wesTrace.runId)}`);
    expect(byRun.status).toBe(200);
  });

  it('refuses a trace, by id and by run, to someone who does not review answers, even their own', async () => {
    const wesTrace = await wesTraceFromStewardList();
    for (const person of ['dan', 'wes']) {
      const byId = await call(person, 'GET', `/api/ask-traces/${wesTrace.traceId}`);
      expect(byId.status).toBe(403);
      expect(byId.body?.error).toBe('Only a steward may review.');
      expect((await call(person, 'GET', `/api/ask-traces/by-run/${encodeURIComponent(wesTrace.runId)}`)).status).toBe(403);
    }
  });
});
