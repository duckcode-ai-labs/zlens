import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRunExecutors } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * Ask observability in Production, which follows main: the host refuses `hint.review` (a write) for everyone.
 * The steward's refusal carries a `next` link (the host's way of letting them open the screen read-only), the
 * creator's does not. The steward still lists every person's questions; the creator lists only their own.
 */
const wes: DqlPrincipal = { id: 'u-wes', kind: 'person', email: 'wes@harbor.example', source: 'host' };
const cole: DqlPrincipal = { id: 'u-cole', kind: 'person', email: 'cole@harbor.example', source: 'host' };
const sam: DqlPrincipal = { id: 'u-sam', kind: 'person', email: 'sam@harbor.example', source: 'host' };
const people: Record<string, DqlPrincipal> = { wes, cole, sam };

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
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-steward-traces-prod-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'steward-traces-production' }));
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    agentRunExecutors: { conversation: answerExecutor, generated_answer: answerExecutor, semantic_answer: answerExecutor, certified_answer: answerExecutor },
    hostHooks: {
      resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
      authorize: (principal, action) => {
        if (action !== 'hint.review') return { allow: true };
        // As an embedding host answers in Production: everyone who may draft (creators and stewards) gets the next
        // link; only the steward, who holds the action by role, is marked read-only.
        const refusal = { allow: false, reason: 'Production follows main.', next: { label: 'Open my draft space', href: '/e/draft' } };
        if (principal.id === wes.id) return { allow: false, reason: 'Production follows main.' };
        return principal.id === sam.id ? { ...refusal, readOnly: true } : refusal;
      },
    },
    captureServer: (created) => { servers.push(created); },
  });
  base = `http://127.0.0.1:${port}`;
  const asked = await call('wes', 'POST', '/api/agent-runs', { question: 'How many claims did Wes ask about?' });
  expect(asked.status).toBeLessThan(300);
  wesRunId = String(asked.body?.run?.id ?? asked.body?.id ?? '');
  expect(wesRunId).not.toBe('');
  expect((await call('cole', 'POST', '/api/agent-runs', { question: 'How many claims did Cole ask about?' })).status).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

type Listed = { traces: Array<{ runId?: string; id?: string; reason?: string }> };
const ids = (listed: Listed) => listed.traces.map((trace) => trace.runId ?? trace.id);

describe('Ask observability in Production (hint.review refused for everyone)', () => {
  it('lists Wes\'s run in the steward\'s list, with a reason on each', async () => {
    const listed = await call('sam', 'GET', '/api/ask-traces?limit=100');
    expect(listed.status).toBe(200);
    expect(ids(listed.body as Listed)).toContain(wesRunId);
    for (const trace of (listed.body as Listed).traces) expect(trace.reason).toBeTruthy();
  });

  it('refuses the list to a creator, whose refusal carries a next link but is not read-only; their own chats stay in Ask history', async () => {
    const listed = await call('cole', 'GET', '/api/ask-traces?limit=100');
    expect(listed.status).toBe(403);
    expect(listed.body?.code).toBe('PERMISSION_DENIED');
    expect(listed.body?.action).toBe('hint.review');
    expect(listed.body?.error).toBe('Production follows main.');
  });

  it('does not open a trace for the creator, by run or by id, and does for the steward', async () => {
    expect((await call('cole', 'GET', `/api/ask-traces/by-run/${encodeURIComponent(wesRunId)}`)).status).toBe(403);
    const stewardList = (await call('sam', 'GET', '/api/ask-traces?limit=100')).body as Listed;
    const wesTrace = stewardList.traces.find((trace) => trace.runId === wesRunId) as { traceId?: string; id?: string } | undefined;
    const traceId = wesTrace?.traceId ?? wesTrace?.id ?? '';
    expect(traceId).not.toBe('');
    expect((await call('cole', 'GET', `/api/ask-traces/${encodeURIComponent(traceId)}`)).status).toBe(403);
    expect((await call('sam', 'GET', `/api/ask-traces/by-run/${encodeURIComponent(wesRunId)}`)).status).toBe(200);
  });
});
