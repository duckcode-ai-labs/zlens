import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from './client';

let api: typeof ClientModule.api;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  ({ api } = await import('./client'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent-run stream transport', () => {
  it('emits the server-issued accepted identity and never sends a browser runId', async () => {
    const completed = {
      id: 'server-run-123',
      question: 'show revenue',
      route: 'generated_answer',
      status: 'completed',
      trustState: 'review_required',
      events: [],
      steps: [],
      artifacts: [],
    };
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response([
      'event: agent-run-accepted',
      'data: {"runId":"server-run-123","operationId":"operation-123"}',
      '',
      'event: agent-run-complete',
      `data: ${JSON.stringify(completed)}`,
      '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const messages: Array<{ kind: string; runId?: string; operationId?: string }> = [];
    const run = await api.createAgentRunStream(
      // Untyped callers can still supply a legacy field.  The public client
      // must omit it before it reaches server-owned capability scope.
      { question: 'show revenue', runId: 'browser-controlled-id' } as any,
      (message) => { messages.push(message as { kind: string; runId?: string; operationId?: string }); },
    );

    expect(run.id).toBe('server-run-123');
    expect(messages[0]).toEqual({ kind: 'accepted', runId: 'server-run-123', operationId: 'operation-123' });
    expect(messages[1]?.kind).toBe('complete');
    expect(JSON.parse(String(requestInit?.body))).toEqual({ question: 'show revenue', reviewDraftCapture: 'off' });
  });

  it('asks the server to keep no draft of its own: an answer is saved only when the person presses Save', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const url = String(_input);
      if (url.includes('stream=1')) {
        return new Response([
          'event: agent-run-accepted', 'data: {"runId":"server-run-9"}', '',
          'event: agent-run-complete', `data: ${JSON.stringify({ id: 'server-run-9', question: 'q', route: 'generated_answer', status: 'completed', trustState: 'review_required', events: [], steps: [], artifacts: [] })}`, '',
        ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ run: { id: 'server-run-9', question: 'q', status: 'completed', events: [], steps: [], artifacts: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await api.createAgentRunStream({ question: 'How many playoff games did the Warriors win in 2015?' }, () => {});
    await api.createAgentRun({ question: 'How many playoff games did the Warriors win in 2015?' });
    expect(bodies).toEqual([
      { question: 'How many playoff games did the Warriors win in 2015?', reviewDraftCapture: 'off' },
      { question: 'How many playoff games did the Warriors win in 2015?', reviewDraftCapture: 'off' },
    ]);
  });
});

describe('agent-run submission identity', () => {
  const completed = { id: 'server-run-1', question: 'q', route: 'generated_answer', status: 'completed', trustState: 'review_required', events: [], steps: [], artifacts: [] };
  const sse = (accepted: Record<string, unknown>) => new Response([
    'event: agent-run-accepted',
    `data: ${JSON.stringify(accepted)}`,
    '',
    'event: agent-run-complete',
    `data: ${JSON.stringify(completed)}`,
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  it('sends the caller-minted submission id as the Idempotency-Key and keeps it out of the body', async () => {
    const headers: string[] = [];
    let body: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(String(new Headers(init?.headers).get('Idempotency-Key')));
      body = JSON.parse(String(init?.body));
      return sse({ runId: 'server-run-1' });
    }));
    await api.createAgentRunStream({ question: 'show revenue', requestId: 'submission-abc' }, () => {});
    expect(headers).toEqual(['submission-abc']);
    expect(body).toEqual({ question: 'show revenue', reviewDraftCapture: 'off' });
  });

  it('two submissions of the same question carry two identities: the text is never the key', async () => {
    const headers: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(String(new Headers(init?.headers).get('Idempotency-Key')));
      return sse({ runId: 'server-run-1' });
    }));
    await api.createAgentRunStream({ question: 'show revenue', threadId: 'thr-1' } as never, () => {});
    await api.createAgentRunStream({ question: 'show revenue', threadId: 'thr-1' } as never, () => {});
    expect(headers).toHaveLength(2);
    expect(headers[0]).toBeTruthy();
    expect(headers[0]).not.toBe(headers[1]);
  });

  it('forwards a replayed acceptance so the browser knows it attached to an earlier run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse({ runId: 'server-run-1', replayed: true })));
    const messages: unknown[] = [];
    await api.createAgentRunStream({ question: 'show revenue', requestId: 'submission-abc' }, (message) => { messages.push(message); });
    expect(messages[0]).toEqual({ kind: 'accepted', runId: 'server-run-1', replayed: true });
  });
});
