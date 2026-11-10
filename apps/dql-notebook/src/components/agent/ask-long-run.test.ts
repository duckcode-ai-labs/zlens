import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from '../../api/client';
import type * as PanelModule from './UnifiedAgentRunPanel';

/**
 * Outside test V7/V8 on the Snowflake Native App: an Ask run of 1 min 36 s
 * showed a red "network error" and put the question back in the input box,
 * where the next question got typed into it. Snowflake documents a 90 s
 * timeout on its ingress; the run went on and finished.
 *
 * A dropped stream is now its own error, and the composer reconnects to the
 * run by id: no error, and nothing put back in the box.
 */
let client: typeof ClientModule;
let askStreamFailureAction: typeof PanelModule.askStreamFailureAction;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  client = await import('../../api/client');
  ({ askStreamFailureAction } = await import('./UnifiedAgentRunPanel'));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const encoder = new TextEncoder();
const accepted = 'event: agent-run-accepted\ndata: {"runId":"server-run-1"}\n\n';
const completed = {
  id: 'server-run-1',
  question: 'Biggest winning margin in a single game?',
  route: 'generated_answer',
  status: 'completed',
  trustState: 'review_required',
  events: [],
  steps: [],
  artifacts: [],
};
const complete = `event: agent-run-complete\ndata: ${JSON.stringify(completed)}\n\n`;

/** A stream response that sends `chunks`, then ends the way `end` says. */
function streamResponse(chunks: string[], end: 'close' | 'error' | 'hang'): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (end === 'close') controller.close();
      // undici and Chrome raise a TypeError when the connection ends under a body.
      // A tick later, so the chunks already sent are read first.
      if (end === 'error') setTimeout(() => controller.error(new TypeError('network error')), 10);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function read(response: Response, stallMs?: number) {
  const messages: Array<{ kind: string }> = [];
  try {
    const run = await client.streamAgentRunResponse(response, (message) => { messages.push(message); }, stallMs === undefined ? {} : { stallMs });
    return { run, messages, error: undefined as unknown };
  } catch (error) {
    return { run: undefined, messages, error };
  }
}

describe('the Ask stream reader', () => {
  it('skips the keep-alive lines a quiet run sends and reaches the answer', async () => {
    const outcome = await read(streamResponse([accepted, ': keep-alive\n\n', ': keep-alive\n\n', complete], 'close'));
    expect(outcome.error).toBeUndefined();
    expect(outcome.run?.id).toBe('server-run-1');
    expect(outcome.messages.map((message) => message.kind)).toEqual(['accepted', 'complete']);
  });

  it('calls a connection cut under the stream a drop, not a failure of the run', async () => {
    const outcome = await read(streamResponse([accepted, ': keep-alive\n\n'], 'error'));
    expect(outcome.messages.map((message) => message.kind)).toEqual(['accepted']);
    expect(client.isAgentRunStreamDropped(outcome.error)).toBe(true);
    expect((outcome.error as InstanceType<typeof client.AgentRunStreamDroppedError>).reason).toBe('disconnected');
  });

  it('calls a stream that ends before the answer a drop, even mid-line', async () => {
    const outcome = await read(streamResponse([accepted, 'event: agent-run-event\ndata: {"type":"st'], 'close'));
    expect(client.isAgentRunStreamDropped(outcome.error)).toBe(true);
    expect((outcome.error as InstanceType<typeof client.AgentRunStreamDroppedError>).reason).toBe('ended');
  });

  it('stops waiting on a stream that carries no bytes at all, so the page can read the run by id', async () => {
    const started = Date.now();
    const outcome = await read(streamResponse([accepted], 'hang'), 60);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(client.isAgentRunStreamDropped(outcome.error)).toBe(true);
    expect((outcome.error as InstanceType<typeof client.AgentRunStreamDroppedError>).reason).toBe('stalled');
  });

  it('keep-alive lines hold off the stall watch', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(accepted));
        timer = setInterval(() => {
          sent += 1;
          if (sent < 6) controller.enqueue(encoder.encode(': keep-alive\n\n'));
          else {
            clearInterval(timer);
            controller.enqueue(encoder.encode(complete));
            controller.close();
          }
        }, 30);
      },
    });
    const outcome = await read(new Response(body, { status: 200 }), 80);
    if (timer) clearInterval(timer);
    expect(outcome.error).toBeUndefined();
    expect(outcome.run?.id).toBe('server-run-1');
  });

  it('keeps a failure the server reports a failure', async () => {
    const outcome = await read(streamResponse([accepted, 'event: agent-run-error\ndata: {"error":"The AI provider refused the request."}\n\n'], 'close'));
    expect(client.isAgentRunStreamDropped(outcome.error)).toBe(false);
    expect((outcome.error as Error).message).toBe('The AI provider refused the request.');
  });
});

describe('what the composer does when the stream fails', () => {
  it('reconnects to the run after a drop, with no error and nothing put back in the box', () => {
    const dropped = new client.AgentRunStreamDroppedError('disconnected', 'network error');
    expect(askStreamFailureAction(dropped, true)).toEqual({ reconnect: true, showError: false, restoreQuestion: false });
    // Before `accepted` too: the same submission is re-sent under its key and attaches to the run.
    expect(askStreamFailureAction(dropped, false)).toEqual({ reconnect: true, showError: false, restoreQuestion: false });
    expect(askStreamFailureAction(new client.AgentRunStreamDroppedError('stalled'), true).showError).toBe(false);
  });

  it('reports a failure the server sent after accepting the run, and still reads the run, never refilling the box', () => {
    expect(askStreamFailureAction(new Error('The AI provider refused the request.'), true))
      .toEqual({ reconnect: true, showError: true, restoreQuestion: false });
  });

  it('offers the question again only when the server refused it before any run started', () => {
    const refused = new client.DqlApiError({ message: 'question is required.', status: 400 });
    expect(askStreamFailureAction(refused, false)).toEqual({ reconnect: false, showError: true, restoreQuestion: true });
    expect(askStreamFailureAction(new Error('Unable to reach the local ZLens notebook server.'), false))
      .toEqual({ reconnect: false, showError: true, restoreQuestion: false });
  });
});
