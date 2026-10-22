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
 * Ask observability with a host: a person who reviews answers (`hint.review`, the steward) lists everyone's
 * questions, each with the reason it was answered or refused; everyone else lists their own.
 */
const wes: DqlPrincipal = { id: 'u-wes', kind: 'person', email: 'wes@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };
const sam: DqlPrincipal = { id: 'u-sam', kind: 'person', email: 'sam@harbor.example', source: 'host' };
const people: Record<string, DqlPrincipal> = { wes, dan, sam };

const servers: Server[] = [];
let projectRoot = '';
let base = '';

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
  artifacts: [{ id: 'answer-1', kind: 'answer', title: 'Governed answer', trustState: 'governed', payload: { text: 'ok', result: { columns: ['q'], rows: [{ q: 1 }], rowCount: 1 } } }],
  evaluations: [],
  nextActions: [],
})) as unknown as NonNullable<AgentRunExecutors['generated_answer']>;

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-steward-traces-'));
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
  expect((await call('wes', 'POST', '/api/agent-runs', { question: 'How many claims did Wes ask about?' })).status).toBeLessThan(300);
  expect((await call('dan', 'POST', '/api/agent-runs', { question: 'How many claims did Dan ask about?' })).status).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

type Listed = { traces: Array<{ questionPreview?: string; reason?: string }> };

describe('Ask observability for a steward', () => {
  it('lists every person\'s question, each with a reason', async () => {
    const listed = await call('sam', 'GET', '/api/ask-traces?limit=100');
    expect(listed.status).toBe(200);
    const traces = (listed.body as Listed).traces;
    expect(traces.length).toBeGreaterThanOrEqual(2);
    for (const trace of traces) expect(trace.reason, JSON.stringify(trace).slice(0, 200)).toBeTruthy();
  });

  it('refuses the list, with the host\'s reason, to anyone who does not review answers', async () => {
    const listed = await call('dan', 'GET', '/api/ask-traces?limit=100');
    expect(listed.status).toBe(403);
    expect(listed.body?.code).toBe('PERMISSION_DENIED');
    expect(listed.body?.action).toBe('hint.review');
    expect(listed.body?.error).toBe('Only a steward may review.');
  });
});

describe('askTraceReason', () => {
  const run = (stopReason: Parameters<typeof askTraceReason>[0]['stopReason'], gapMessage?: string) => ({
    stopReason,
    status: 'completed' as const,
    evaluations: [],
    artifacts: gapMessage ? [{ id: 'a', kind: 'answer', title: 'x', trustState: 'blocked', payload: { gap: { kind: 'no_source', message: gapMessage } } }] : [],
  } as unknown as Parameters<typeof askTraceReason>[0]);

  it('says why an answer was given, from the stop reason', () => {
    expect(askTraceReason(run('certified_answer_found'))).toBe('Answered from a certified saved query.');
    expect(askTraceReason(run('governed_semantic_answer'))).toBe('Answered from the governed semantic layer.');
    expect(askTraceReason(run('needs_clarification'))).toBe('Asked the person to clarify before answering.');
  });

  it('gives a refusal its own gap sentence, and a plain one when there is none', () => {
    expect(askTraceReason(run('blocked', 'No governed source covers claims by adjuster.'))).toBe('No governed source covers claims by adjuster.');
    expect(askTraceReason(run('blocked'))).toBe('Refused: no governed answer was available.');
  });
});
