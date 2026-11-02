import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';

vi.mock('@zlens/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zlens/agent')>();
  return {
    ...actual,
    createAskTracePortableBundleV1: vi.fn((trace: { envelope: { traceId: string } }) => ({ manifest: { profile: 'strict' }, trace: { ...trace, redacted: true } })),
    toOtlpOpenInferenceJsonV1: vi.fn((trace: { envelope: { traceId: string } }) => ({ resourceSpans: [{ traceId: trace.envelope.traceId }] })),
  };
});

const { startLocalServer } = await import('../local-runtime.js');
const { answerAuditEvent, auditModelUsage, keyQuestionFingerprints, observabilityFailures, otlpHeadersFromEnv, traceQuestionKey, withAnswerAudit, withTraceExport } = await import('./observability.js');
const { withRequestContext } = await import('./request-context.js');
type DqlAuditEvent = import('./observability.js').DqlAuditEvent;
type DqlPrincipal = import('./request-context.js').DqlPrincipal;

/**
 * RFC 0010 HH-6: who did what, and how each answer was made — with no result
 * values — plus traces exported, redacted, to the host or a collector.
 */
const maria: DqlPrincipal = { id: 'u-maria', kind: 'person', email: 'maria@insurer.example', source: 'host' };
const dev: DqlPrincipal = { id: 'u-dev', kind: 'person', displayName: 'Dev', source: 'host' };

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('audit (RFC 0010 HH-6)', () => {
  it('reports each change and each refusal with who, what and the outcome — not reads', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-audit-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'audit' }));
    const events: DqlAuditEvent[] = [];
    const people: Record<string, DqlPrincipal> = { maria, dev };
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      hostHooks: {
        resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
        authorize: (principal, action) => ({ allow: !(principal.id === 'u-dev' && action === 'connection.manage'), reason: 'Admins only.' }),
        audit: (event) => { events.push(event); },
      },
      captureServer: (created) => { servers.push(created); },
    });
    const base = `http://127.0.0.1:${port}`;
    const send = (person: string | undefined, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    await send('maria', 'GET', '/api/identity');
    await send(undefined, 'GET', '/api/identity');
    await send('dev', 'PUT', '/api/connections', { connections: {} });
    await send('maria', 'POST', '/api/agent/learnings/correction', { question: 'What is net revenue?', wrongSql: 'SELECT SUM(amount) FROM orders', correctedSql: 'SELECT SUM(net_amount) FROM orders', scope: { metric: 'revenue' } });
    await new Promise((done) => setTimeout(done, 20));

    expect(events.map((event) => event.kind === 'request' ? [event.method, event.path, event.status, event.outcome, event.action, event.actor] : event.kind)).toEqual([
      ['GET', '/api/identity', 401, 'refused', 'project.read', null],
      ['PUT', '/api/connections', 403, 'refused', 'connection.manage', 'Dev'],
      ['POST', '/api/agent/learnings/correction', 200, 'ok', 'project.write', 'maria@insurer.example'],
    ]);
    const change = events[2] as Extract<DqlAuditEvent, { kind: 'request' }>;
    expect(change).toMatchObject({ principalId: 'u-maria', resource: { type: 'project' }, requestId: expect.any(String) });
  });

  it('describes a finished answer by fingerprints and sources, never its SQL or values', () => {
    const run = {
      id: 'run-1', status: 'completed', trustState: 'certified',
      artifacts: [
        { payload: { sql: "SELECT SUM(net_amount) FROM orders WHERE region = 'CA'", blockId: 'claims_paid', rows: [{ total: 12 }] } },
        { payload: { proposedSql: 'SELECT 1' }, sourceId: 'dataset:orders' },
      ],
    };
    const event = answerAuditEvent(run, { principal: maria, actor: 'maria@insurer.example' });
    expect(event).toMatchObject({ kind: 'answer', runId: 'run-1', trustState: 'certified', principalId: 'u-maria', sources: ['claims_paid', 'dataset:orders'] });
    expect((event as { sqlSha256: string[] }).sqlSha256).toHaveLength(2);
    expect(JSON.stringify(event)).not.toMatch(/SELECT|net_amount|'CA'|total/);
    expect(answerAuditEvent({ ...run, status: 'running' }, { principal: null, actor: null })).toBeNull();
  });

  it('carries the codes a host keeps beside the answer: how it stopped, which route, which tier, why it was refused', () => {
    // Enterprise walkthrough D4 (Wes): the semantic statement ran, matched no row, and the answer was blocked.
    const refused = {
      id: 'run-wes', status: 'blocked', trustState: 'blocked', route: 'generated_answer', stopReason: 'blocked', answerRefusalCode: 'no_data',
      diagnosticReceiptV9: { executed: { tier: 'semantic', sqlFingerprint: 'd485a8ae', rowCount: 0, ms: 17, proofs: [] } },
      artifacts: [{ kind: 'answer', payload: { kind: 'no_answer', text: 'The governed query ran, but no rows matched the restriction on product.', executedSql: "SELECT product, SUM(claimed_amount) FROM claims WHERE product = 'product' GROUP BY product" } }],
    };
    const event = answerAuditEvent(refused, { principal: maria, actor: 'maria@insurer.example' });
    expect(event).toMatchObject({ kind: 'answer', runId: 'run-wes', status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', tier: 'semantic', answerRefusalCode: 'no_data' });
    // The statement that ran before the refusal is fingerprinted as on an answered run; nothing of it is in the event.
    expect((event as { sqlSha256: string[] }).sqlSha256).toHaveLength(1);
    expect(JSON.stringify(event)).not.toMatch(/SELECT|claimed_amount|'product'|governed query ran/);
    // A completed run says how it stopped and where, and carries no refusal code; a sentence where a code should be is dropped.
    const answered = answerAuditEvent({ id: 'run-ok', status: 'completed', trustState: 'governed', route: 'semantic_answer', stopReason: 'governed_semantic_answer', answerRefusalCode: 'no_data', diagnosticReceiptV9: { executed: { tier: 'semantic' } }, artifacts: [] }, { principal: null, actor: null });
    expect(answered).toMatchObject({ stopReason: 'governed_semantic_answer', resolvedRoute: 'semantic_answer', tier: 'semantic' });
    expect(answered).not.toHaveProperty('answerRefusalCode');
    const prose = answerAuditEvent({ id: 'run-x', status: 'blocked', trustState: 'blocked', stopReason: 'no rows matched "product" on the warehouse', artifacts: [] }, { principal: null, actor: null });
    expect(prose).not.toHaveProperty('stopReason');
  });

  it('reports each run once, when it first finishes', () => {
    const events: DqlAuditEvent[] = [];
    const saved: unknown[] = [];
    const store = withAnswerAudit({ save: (run: never) => { saved.push(run); } }, (event) => { events.push(event); }, () => ({ principal: null, actor: null }));
    store.save({ id: 'r', status: 'completed', trustState: 'governed', artifacts: [] } as never);
    store.save({ id: 'r', status: 'completed', trustState: 'governed', artifacts: [] } as never);
    expect(saved).toHaveLength(2);
    expect(events).toHaveLength(1);
  });
});

describe('model usage (RFC 0010 HH-6)', () => {
  it('records each model call\'s tokens for the person whose request made it, and stops when removed', async () => {
    const events: DqlAuditEvent[] = [];
    let listener: ((line: never) => void) | null = null;
    const setListener = (next: typeof listener) => { listener = next; };
    auditModelUsage((event) => { events.push(event); }, setListener as never, () => ({ principal: maria, actor: 'maria@insurer.example', requestId: 'r-1' }));
    withRequestContext({ principal: maria, requestId: 'r-1' }, () => listener!({ at: 't', provider: 'claude', model: 'claude-sonnet-5', operation: 'generate', inputTokens: 900, outputTokens: 120, cacheReadTokens: 700 } as never));
    await Promise.resolve();
    expect(events).toEqual([{ kind: 'model_usage', at: 't', requestId: 'r-1', actor: 'maria@insurer.example', principalId: 'u-maria', provider: 'claude', model: 'claude-sonnet-5', operation: 'generate', inputTokens: 900, outputTokens: 120, cacheReadTokens: 700 }]);
    auditModelUsage(null, setListener as never, () => ({ principal: null, actor: null }));
    expect(listener).toBeNull();
  });
});

describe('trace export (RFC 0010 HH-6)', () => {
  const trace = { envelope: { traceId: 'a'.repeat(32), runId: 'run-1' } };
  const makeStore = () => ({ finalize: vi.fn((_envelope: unknown) => ({ ok: true })), get: vi.fn(() => trace as never) });

  it('sends each finished trace, redacted, to the host and to an OTLP collector', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const sink = vi.fn();
    const store = withTraceExport(makeStore(), { sink, otlpEndpoint: 'http://collector:4318/', otlpHeaders: otlpHeadersFromEnv('x-tenant=insurer,authorization=Bearer%20abc') });
    expect(store.finalize(trace.envelope)).toEqual({ ok: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ traceId: trace.envelope.traceId, runId: 'run-1', bundle: expect.objectContaining({ manifest: { profile: 'strict' } }) }));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://collector:4318/v1/traces');
    expect(init.headers).toMatchObject({ 'x-tenant': 'insurer', authorization: 'Bearer abc' });
    expect(JSON.parse(String(init.body))).toEqual({ resourceSpans: [{ traceId: trace.envelope.traceId }] });
  });

  it('never fails the answer when export fails, and counts it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const before = observabilityFailures().traces;
    const store = withTraceExport(makeStore(), { otlpEndpoint: 'http://collector:4318' });
    expect(store.finalize(trace.envelope)).toEqual({ ok: true });
    await vi.waitFor(() => expect(observabilityFailures().traces).toBe(before + 1));
  });

  it('leaves the store as it is with nowhere to send traces', () => {
    const store = makeStore();
    expect(withTraceExport(store, {})).toBe(store);
  });

  it('sends question fingerprints keyed, never as the bare hash of the question: stable on one install, different on another', async () => {
    const asked = `sha256:${createHash('sha256').update('How many claims were filed in the West?').digest('hex')}`;
    const withQuestion = { envelope: { traceId: 'b'.repeat(32), runId: 'run-2', questionFingerprint: asked }, spans: [{ payload: { kind: 'stage', requestedMode: 'auto', fingerprint: asked } }, { payload: { kind: 'sql', execution: { sqlFingerprint: 'sha256:abc' } } }] };
    const sent: Array<{ bundle: unknown; otlp: unknown }> = [];
    const store = (key: string) => withTraceExport({ finalize: vi.fn((_envelope: unknown) => ({ ok: true })), get: vi.fn(() => withQuestion as never) }, { sink: (trace) => { sent.push(trace); }, questionKey: () => key });
    store('install-one').finalize(withQuestion.envelope);
    store('install-one').finalize(withQuestion.envelope);
    store('install-two').finalize(withQuestion.envelope);
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    const texts = sent.map((trace) => JSON.stringify(trace));
    for (const text of texts) expect(text).not.toContain(asked.slice('sha256:'.length));
    const fingerprint = (index: number) => (sent[index]!.bundle as { trace: { envelope: { questionFingerprint: string }; spans: Array<{ payload: { fingerprint?: string } }> } }).trace;
    expect(fingerprint(0).envelope.questionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprint(0).spans[0]!.payload.fingerprint).toBe(fingerprint(0).envelope.questionFingerprint);
    expect(fingerprint(1).envelope.questionFingerprint).toBe(fingerprint(0).envelope.questionFingerprint);
    expect(fingerprint(2).envelope.questionFingerprint).not.toBe(fingerprint(0).envelope.questionFingerprint);
    // Other fingerprints are left as they are.
    expect(texts[0]).toContain('sha256:abc');
    expect(keyQuestionFingerprints({ questionFingerprint: asked }, 'k').questionFingerprint).not.toBe(asked);
  });

  it('keys them with the host\'s secret, or one kept in the project\'s private folder', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-trace-salt-'));
    roots.push(projectRoot);
    expect(traceQuestionKey(projectRoot, 'host-secret-for-claims')).toBe('host-secret-for-claims');
    const made = traceQuestionKey(projectRoot);
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    expect(traceQuestionKey(projectRoot)).toBe(made);
    const file = join(projectRoot, '.dql', 'local', 'private', 'trace-salt');
    expect(readFileSync(file, 'utf8').trim()).toBe(made);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
    const other = mkdtempSync(join(tmpdir(), 'dql-trace-salt-'));
    roots.push(other);
    expect(traceQuestionKey(other)).not.toBe(made);
  });
});
