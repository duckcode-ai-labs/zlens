import { describe, it, expect, vi } from 'vitest';
import type { AgentRun } from '@zlens/agent';
import {
  driveViaRuntime,
  evalKindForRun,
  evalRouteForRun,
  projectRuntimeRun,
  runtimeRunOutputs,
  runtimeRunRefused,
} from './agent-eval-runtime.js';

const run = (over: Partial<AgentRun>): AgentRun => ({
  id: 'run-1',
  question: 'q',
  requestedMode: 'ask',
  route: 'generated_answer',
  status: 'needs_review',
  trustState: 'review_required',
  stopReason: 'completed',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z',
  steps: [],
  summary: '',
  artifacts: [],
  evaluations: [],
  events: [],
  nextActions: [],
  repairAttempts: 0,
  ...over,
} as AgentRun);

describe('runtime driver run projection', () => {
  it('counts a blocked or clarifying run as a refusal', () => {
    expect(runtimeRunRefused(run({ route: 'blocked', status: 'blocked' }))).toBe(true);
    expect(runtimeRunRefused(run({ route: 'clarify', status: 'needs_clarification' }))).toBe(true);
  });

  it('does NOT count a review-required generated answer as a refusal', () => {
    // The load-bearing distinction. When no governed plan freezes, a
    // review-required generated answer is the intended outcome of the cascade.
    // Scoring it as a refusal would make false_refusal_rate punish exactly the
    // behaviour the cascade is supposed to produce.
    const reviewRequired = run({ route: 'generated_answer', status: 'needs_review', trustState: 'review_required' });
    expect(runtimeRunRefused(reviewRequired)).toBe(false);
    expect(evalKindForRun(reviewRequired)).toBe('uncertified');
  });

  it('derives certification from TRUST, not from the route name', () => {
    // A certified ROUTE that degraded to review-required must not score certified,
    // or the harness would bless the exact mislabelling it should catch.
    expect(evalKindForRun(run({ route: 'certified_answer', status: 'completed', trustState: 'certified' }))).toBe('certified');
    expect(evalKindForRun(run({ route: 'certified_answer', status: 'needs_review', trustState: 'review_required' }))).toBe('uncertified');
  });

  it('maps engine routes onto the vocabulary the case files already use', () => {
    expect(evalRouteForRun('certified_answer')).toBe('certified');
    expect(evalRouteForRun('semantic_answer')).toBe('certified');
    expect(evalRouteForRun('generated_answer')).toBe('generated_sql');
    expect(evalRouteForRun('blocked')).toBe('blocked');
    expect(evalRouteForRun('conversation')).toBeUndefined();
  });

  it('extracts SQL and rows from run artifacts', () => {
    const withArtifact = run({
      artifacts: [{
        id: 'a1', kind: 'sql_cell', title: 'SQL', trustState: 'review_required',
        payload: { sql: 'SELECT 1', result: { rows: [{ a: 1 }] } },
      }],
    } as Partial<AgentRun>);
    expect(runtimeRunOutputs(withArtifact)).toEqual({ proposedSql: 'SELECT 1', rows: [{ a: 1 }] });
    expect(runtimeRunOutputs(run({}))).toEqual({});
  });

  it('projects a blocked run with its failing evaluation id', () => {
    const projected = projectRuntimeRun(run({
      route: 'blocked', status: 'blocked', trustState: 'blocked',
      evaluations: [{ id: 'grounding', label: 'Answer grounding', passed: false, severity: 'warning', message: 'no' }],
    } as Partial<AgentRun>));
    expect(projected).toMatchObject({ kind: 'no_answer', route: 'blocked', refusalCode: 'grounding' });
  });

  it('projects persisted route, retrieval coverage, and telemetry without fabricating a context pack', () => {
    const persisted = run({
      route: 'generated_answer',
      trustState: 'review_required',
      telemetry: {
        version: 1,
        stageDurationsMs: { total: 25 },
        providerRoundTrips: 1,
        toolCalls: 3,
        sqlExecutions: 1,
        repairs: 0,
        egressReceipts: 1,
        fallbackReason: 'none',
      },
      traceReference: {
        version: 1,
        traceId: 'a'.repeat(32),
        recordingStatus: 'complete',
        storeSchemaVersion: 1,
        traceFingerprint: 'sha256:trace',
      },
      routeDecision: {
        action: 'answer', confidence: 0.8, followsUp: false, reason: 'Qualified generated path.',
        retrievalEvidence: { snapshotId: 'snapshot-1', candidateCount: 4, candidateIds: ['dbt:model:orders'] },
        terminalOutcome: { kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP', message: 'No safe customer relationship.', candidateIds: [] },
        analyticalCascadeDecision: {
          version: 1,
          requirements: { version: 1, measures: ['revenue'], dimensions: [], entityTerms: [], entityDisplayTerms: [], memberTerms: [] },
          sourceCoverage: [{ version: 1, source: 'exploratory', status: 'available', candidateIds: ['dbt:model:orders'] }],
          attempts: [],
          planFrozen: false,
          stopReason: 'coverage_gap',
        },
      },
    } as Partial<AgentRun>);

    expect(projectRuntimeRun(persisted)).toMatchObject({
      route: 'generated_sql',
      retrievalCandidateCount: 4,
      toolCallCount: 3,
      terminalOutcome: { kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP' },
      sourceCoverage: [{ source: 'exploratory', status: 'available' }],
      observability: { recordingStatus: 'complete', storeSchemaVersion: 1, traceFingerprint: 'sha256:trace' },
    });
  });
});

describe('driveViaRuntime', () => {
  it('posts the question the Ask panel would post and returns the run', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:3474/api/agent-runs');
      expect(JSON.parse(String(init.body))).toMatchObject({ question: 'who are the top customers', requestedMode: 'ask' });
      return { ok: true, status: 201, json: async () => ({ run: run({ id: 'run-42' }) }), text: async () => '' };
    }) as unknown as typeof fetch;
    const result = await driveViaRuntime({ runtimeBase: 'http://127.0.0.1:3474/', question: 'who are the top customers', fetchImpl });
    expect(result.id).toBe('run-42');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends the scope selection the notebook would send, and nothing when there is none', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return { ok: true, status: 201, json: async () => ({ run: run({ id: 'scoped' }) }), text: async () => '' };
    }) as unknown as typeof fetch;
    await driveViaRuntime({ runtimeBase: 'http://x', question: 'q', fetchImpl, workspaceContext: { domain: 'growth', purpose: 'growth_attribution' } });
    await driveViaRuntime({ runtimeBase: 'http://x', question: 'q', fetchImpl, workspaceContext: {} });
    expect(bodies[0]).toMatchObject({ workspaceContext: { domain: 'growth', purpose: 'growth_attribution' } });
    expect(bodies[1]).not.toHaveProperty('workspaceContext');
  });

  it('accepts a bare run body as well as the wrapped one', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => run({ id: 'bare' }), text: async () => '' })) as unknown as typeof fetch;
    await expect(driveViaRuntime({ runtimeBase: 'http://x', question: 'q', fetchImpl })).resolves.toMatchObject({ id: 'bare' });
  });

  it('throws on a transport failure instead of scoring it as a refusal', async () => {
    // A harness that swallows this would report a false-refusal spike no code
    // change caused, and send someone hunting a regression that does not exist.
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) })) as unknown as typeof fetch;
    await expect(driveViaRuntime({ runtimeBase: 'http://127.0.0.1:3474', question: 'q', fetchImpl }))
      .rejects.toThrow(/Runtime returned 500/);
  });
});

describe('the runtime driver waits as long as the case timeout, not the global fetch cap', () => {
  it('posts the question, reads the run, and still stops at the case timeout', async () => {
    const { createServer } = await import('node:http');
    const received: string[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        received.push(body);
        if (body.includes('never answers')) return;
        setTimeout(() => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ run: { id: 'run-1', status: 'completed' } })); }, 30);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    try {
      const run = await driveViaRuntime({ runtimeBase: `http://127.0.0.1:${port}`, question: 'how many orders', timeoutMs: 5_000 });
      expect(run.id).toBe('run-1');
      expect(JSON.parse(received[0]!)).toMatchObject({ question: 'how many orders', requestedMode: 'ask', reviewDraftCapture: 'off' });
      await expect(driveViaRuntime({ runtimeBase: `http://127.0.0.1:${port}`, question: 'never answers', timeoutMs: 100 })).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('each case opens its own connection to the runtime', () => {
  it('never reuses a kept-alive connection the runtime may be closing', async () => {
    // The runtime closes an idle connection after five seconds; the eval reads
    // the schema for a few seconds between cases. Reusing the connection raced
    // that close and failed the case with ECONNRESET.
    const { createServer } = await import('node:http');
    let connections = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ run: { id: `run-${connections}`, status: 'completed' } }));
      });
    });
    server.on('connection', () => { connections += 1; });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    try {
      await driveViaRuntime({ runtimeBase: `http://127.0.0.1:${port}`, question: 'first', timeoutMs: 5_000 });
      await driveViaRuntime({ runtimeBase: `http://127.0.0.1:${port}`, question: 'second', timeoutMs: 5_000 });
      expect(connections).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
