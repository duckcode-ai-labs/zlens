import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { answerLongRequest, clearLongRequestsForTests, handleLongRequestPoll, LONG_REQUEST_ABANDON_MS, LONG_REQUEST_PATH, longRequestSignal } from './long-request.js';

/**
 * Abandoned long requests stop their work: an answer no one can read any more is not worth a running statement on
 * the customer's warehouse (Snowflake Cortex reads `longRequestSignal()` and cancels its AI_COMPLETE call).
 */
afterEach(() => clearLongRequestsForTests());

function asking(prefer: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.headers = { prefer };
  return req;
}

/** A response that records what was sent and can close like a dropped connection. */
function response() {
  const entry = { status: 0, body: undefined as any };
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    writableEnded: false,
    headersSent: false,
    writeHead(status: number) { entry.status = status; return res; },
    end(chunk?: string) { entry.body = chunk ? JSON.parse(chunk) : undefined; res.writableEnded = true; return res; },
  });
  return { res: res as unknown as ServerResponse & EventEmitter, entry };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('a long request no one waits for', () => {
  it('stops its work when no one has asked for the answer for a while, and gives its work the signal', async () => {
    expect(LONG_REQUEST_ABANDON_MS).toBe(3 * 60_000);
    const post = asking('respond-async, wait=0');
    post.resume();
    await new Promise((done) => post.once('end', done));
    let workSignal: AbortSignal | undefined;
    let ambient: AbortSignal | undefined;
    const started = response();
    await answerLongRequest(post, started.res, async (signal) => {
      workSignal = signal;
      ambient = longRequestSignal();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      return { status: 200, body: { ok: true } };
    }, { abandonMs: 120 });
    expect(started.entry.status).toBe(202);
    expect(ambient).toBe(workSignal);
    // Asked for in time: still running.
    await sleep(80);
    const poll = response();
    await handleLongRequestPoll(asking('wait=0'), poll.res, `${LONG_REQUEST_PATH}${started.entry.body.longRequest.id}`);
    expect(poll.entry.status).toBe(202);
    await sleep(80);
    expect(workSignal!.aborted).toBe(false);
    // Then no one asks: abandoned.
    await sleep(120);
    expect(workSignal!.aborted).toBe(true);
    expect(String(workSignal!.reason)).toContain('no one has asked for its answer');
  });

  it('stops its work when the caller leaves before an id was handed out, and not once it was answered', async () => {
    const left = response();
    let signal: AbortSignal | undefined;
    const work = answerLongRequest(asking(''), left.res, async (workSignal) => {
      signal = workSignal;
      await new Promise((_resolve, reject) => workSignal.addEventListener('abort', () => reject(workSignal.reason)));
      return { status: 200, body: {} };
    });
    await sleep(5);
    left.res.emit('close');
    await work;
    expect(signal!.aborted).toBe(true);

    const answered = response();
    let kept: AbortSignal | undefined;
    await answerLongRequest(asking(''), answered.res, async (workSignal) => { kept = workSignal; return { status: 201, body: { ok: true } }; });
    answered.res.emit('close');
    expect(answered.entry).toEqual({ status: 201, body: { ok: true } });
    expect(kept!.aborted).toBe(false);
    // Outside a long request there is no signal.
    expect(longRequestSignal()).toBeUndefined();
  });
});
