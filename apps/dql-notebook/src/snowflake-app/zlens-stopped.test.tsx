import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotebookProvider } from '../store/NotebookStore';
import { followServerEvents, STREAM_FAILURES_BEFORE_STOPPED, STREAM_QUIET_MS, STREAM_RETRY_MS } from '../api/follow-server-events';
import type { ServerEventFrame } from '../api/server-auth';
import { operationsPollMs } from '../operations/OperationsProvider';
import { setSnowflakeApp } from './snowflake-app-mode';
import { isZLensStopped, markZLensStopped, resetZLensStoppedForTests, snowflakeSaysNotRunning, startZLensAgain, stoppingNotice, watchForStoppedService, zlensStopped } from './zlens-stopped';
import { GAVE_UP_WORDS, startingWords, ZLensStoppedNotice, zlensStoppedWords } from './ZLensStoppedNotice';

/**
 * V4 idle stop: after ZLens stopped in Snowflake, an open tab's stream reconnects woke the service 11 seconds
 * later, and the tab said nothing. In Snowflake ANY request to the app's address wakes it. Now the page is told
 * (`stopping`), or works it out when its streams cannot reconnect, and from then on sends nothing by itself.
 */
const encoder = new TextEncoder();

function eventStream(text: string, end: 'close' | 'error' = 'close'): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      if (end === 'close') controller.close();
      else controller.error(new TypeError('network error'));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Let the stream reader's promises settle (no timer moves). */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  resetZLensStoppedForTests();
  setSnowflakeApp(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the stopping event', () => {
  it('stops the page following its streams: no reconnect, and every later request to ZLens is held, unsent', async () => {
    setSnowflakeApp(true);
    const send = vi.fn(async () => eventStream(': connected\n\nevent: change\ndata: {"type":"file-added"}\n\nevent: stopping\ndata: {"reason":"idle","idleMinutes":60}\n\n'));
    vi.stubGlobal('fetch', send);
    const frames: ServerEventFrame[] = [];
    const stop = followServerEvents('/api/watch', (frame) => frames.push(frame));
    await settle();

    expect(zlensStopped()).toEqual({ reason: 'idle', idleMinutes: 60 });
    // Its own frames still reach the page; the stopping event does not.
    expect(frames.map((frame) => frame.event)).toEqual(['change']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);

    // Any request the page makes now, from any timer, waits unsent: none reaches Snowflake.
    let answered = false;
    void fetch('/api/operations?limit=50').then(() => { answered = true; }, () => { answered = true; });
    void fetch(new URL('/api/snowflake-app/setup', 'http://zlens.invalid/')).then(() => { answered = true; }, () => { answered = true; });
    await settle();
    expect(answered).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    // A caller that gives up is told so, still without a request.
    const giveUp = new AbortController();
    const held = fetch('/api/semantic-layer', { signal: giveUp.signal });
    giveUp.abort();
    await expect(held).rejects.toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);

    // A stream the page would open now is not opened.
    const late = followServerEvents('/api/operations/events', () => undefined);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    late();
    stop();
  });

  it('reads the reason the server gives, and anything else as "stopped"', () => {
    expect(stoppingNotice('{"reason":"idle","idleMinutes":60}')).toEqual({ reason: 'idle', idleMinutes: 60 });
    expect(stoppingNotice('{"reason":"idle"}')).toEqual({ reason: 'idle' });
    expect(stoppingNotice('{"reason":"stopped"}')).toEqual({ reason: 'stopped' });
    expect(stoppingNotice('not json')).toEqual({ reason: 'stopped' });
  });

  it('ends the stream for a page that is told while another stream is still open', async () => {
    setSnowflakeApp(true);
    let aborted = 0;
    vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted += 1; });
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode(': connected\n\n')); },
      }), { status: 200 }));
    }));
    const stop = followServerEvents('/api/operations/events', () => undefined);
    await settle();
    markZLensStopped({ reason: 'stopped' });
    await settle();
    expect(aborted).toBe(1);
    stop();
  });
});

describe('streams that cannot reconnect', () => {
  it('in the app for Snowflake: after a few failed attempts in a row the page takes ZLens as stopped and stops asking', async () => {
    setSnowflakeApp(true);
    const send = vi.fn(async () => { throw new TypeError('net::ERR_HTTP2_PROTOCOL_ERROR'); });
    vi.stubGlobal('fetch', send);
    const stop = followServerEvents('/api/watch', () => undefined);
    await settle();
    for (let attempt = 1; attempt < STREAM_FAILURES_BEFORE_STOPPED; attempt += 1) {
      expect(isZLensStopped()).toBe(false);
      await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    }
    await settle();
    expect(send).toHaveBeenCalledTimes(STREAM_FAILURES_BEFORE_STOPPED);
    expect(zlensStopped()).toEqual({ reason: 'lost' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(send).toHaveBeenCalledTimes(STREAM_FAILURES_BEFORE_STOPPED);
    stop();
  });

  it('a stream that opens and later drops is opened again, as before', async () => {
    setSnowflakeApp(true);
    const send = vi.fn(async () => eventStream(': connected\n\n', 'error'));
    vi.stubGlobal('fetch', send);
    const stop = followServerEvents('/api/watch', () => undefined);
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await settle();
      await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    }
    expect(send.mock.calls.length).toBeGreaterThan(STREAM_FAILURES_BEFORE_STOPPED);
    expect(isZLensStopped()).toBe(false);
    stop();
  });

  it('everywhere else: reconnects for as long as the page is open, as it always did', async () => {
    const send = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', send);
    const stop = followServerEvents('/api/watch', () => undefined);
    await settle();
    for (let attempt = 0; attempt < 8; attempt += 1) await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    expect(send).toHaveBeenCalledTimes(9);
    expect(isZLensStopped()).toBe(false);
    stop();
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS * 4);
    expect(send).toHaveBeenCalledTimes(9);
  });
});

describe('the operations list', () => {
  it('stops polling once ZLens stopped', () => {
    expect(operationsPollMs(false, false)).toBe(1_500);
    expect(operationsPollMs(false, true)).toBe(false);
    expect(operationsPollMs(true, false)).toBe(false);
  });
});

describe('the notice', () => {
  const render = () => renderToStaticMarkup(<NotebookProvider><ZLensStoppedNotice /></NotebookProvider>);

  it('shows nothing while ZLens runs', () => {
    expect(render()).toBe('');
  });

  it('says plainly that ZLens stopped and why, and offers to start it again', () => {
    markZLensStopped({ reason: 'idle', idleMinutes: 60 });
    const html = render();
    expect(html).toContain('ZLens stopped because no one used it for 60 minutes.');
    expect(html).toContain('This page will not start it again by itself.');
    expect(html).toContain('Start ZLens again');
    expect(html).toContain('about 2 to 3 minutes, longer right after an install or update');
    expect(html).toContain('role="alertdialog"');
  });

  it('words each reason', () => {
    expect(zlensStoppedWords({ reason: 'stopped' }).detail).toMatch(/^ZLens was stopped\. /);
    expect(zlensStoppedWords({ reason: 'lost' }).detail).toMatch(/^ZLens was stopped, or this page lost its connection to it\. /);
    expect(zlensStoppedWords({ reason: 'idle', idleMinutes: 1 }).detail).toMatch(/^ZLens stopped because no one used it for 1 minute\. /);
    expect(zlensStoppedWords({ reason: 'idle' }).detail).toMatch(/^ZLens stopped because no one used it for a while\. /);
  });
});

describe('starting ZLens again', () => {
  // V4 release check: the button reloaded the page at once, the reload landed while Snowflake was still starting
  // the service, and the person saw Snowflake's raw "service is not yet running" error page. Now the page wakes
  // ZLens, checks its health until ZLens itself answers, and only then opens it.
  const unavailable = () => new Response('{"responseType":"ERROR_SERVICE_UNAVAILABLE"}', { status: 503 });
  const clock = () => {
    let at = 0;
    return { now: () => at, sleep: async (ms: number) => { at += ms; } };
  };

  it('waits through Snowflake\'s "not yet running" answers and opens ZLens only once it answers', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(unavailable())
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const { now, sleep } = clock();
    await expect(startZLensAgain({ send: send as unknown as typeof fetch, now, sleep, intervalMs: 10_000 })).resolves.toBe('ready');
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[0][0]).toBe('/api/health');
    expect(send.mock.calls[0][1]).toMatchObject({ cache: 'no-store', redirect: 'manual' });
  });

  it('reloads for sign-in when Snowflake redirects', async () => {
    const redirect = { type: 'opaqueredirect', status: 0, ok: false } as unknown as Response;
    const send = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(redirect);
    const { now, sleep } = clock();
    await expect(startZLensAgain({ send: send as unknown as typeof fetch, now, sleep })).resolves.toBe('sign-in');
  });

  it('stops checking after 20 minutes and offers to check again', async () => {
    const send = vi.fn().mockImplementation(async () => unavailable());
    const { now, sleep } = clock();
    await expect(startZLensAgain({ send: send as unknown as typeof fetch, now, sleep, intervalMs: 10_000 })).resolves.toBe('gave-up');
    expect(send).toHaveBeenCalledTimes(121);
    expect(GAVE_UP_WORDS).toBe('ZLens has not started after 20 minutes. Check again in a few minutes.');
  });

  it('sends its check although the page holds every other request to ZLens', async () => {
    const original = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const before = globalThis.fetch;
    globalThis.fetch = original as unknown as typeof fetch;
    try {
      markZLensStopped({ reason: 'stopped' });
      expect(globalThis.fetch).not.toBe(original);
      await expect(startZLensAgain()).resolves.toBe('ready');
      expect(original).toHaveBeenCalledWith('/api/health', expect.objectContaining({ redirect: 'manual' }));
    } finally {
      resetZLensStoppedForTests();
      globalThis.fetch = before;
    }
  });

  it('shows the time so far while ZLens starts', () => {
    expect(startingWords(0)).toBe('Starting ZLens… 0:00. This page opens it when it is ready.');
    expect(startingWords(83_400)).toBe('Starting ZLens… 1:23. This page opens it when it is ready.');
  });
});

describe('streams the Snowflake ingress ends or drops (V4 release check)', () => {
  // A tab left untouched for an hour never heard `stopping`: the ingress ends a stream that is quiet for 90 s, and
  // the page stopped following a stream that ended without an error. Its next background request woke ZLens.

  it('a stream that ends without an error is opened again', async () => {
    setSnowflakeApp(true);
    const send = vi.fn(async () => eventStream(': connected\n\n', 'close'));
    vi.stubGlobal('fetch', send);
    const stop = followServerEvents('/api/watch', () => undefined);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(isZLensStopped()).toBe(false);
    stop();
  });

  it('a stream that carries nothing, not even a keep-alive line, for 45 s is taken as dropped and opened again', async () => {
    setSnowflakeApp(true);
    let cancelled = 0;
    const send = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(': connected\n\n')); },
      cancel() { cancelled += 1; },
    }), { status: 200 }));
    vi.stubGlobal('fetch', send);
    const stop = followServerEvents('/api/operations/events', () => undefined);
    await settle();
    await vi.advanceTimersByTimeAsync(STREAM_QUIET_MS - 1_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(cancelled).toBe(1);
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(isZLensStopped()).toBe(false);
    stop();
  });

  it('a stream that hears keep-alive lines stays open', async () => {
    setSnowflakeApp(true);
    let push: ((text: string) => void) | undefined;
    const send = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': connected\n\n'));
        push = (text) => controller.enqueue(encoder.encode(text));
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', send);
    const stop = followServerEvents('/api/watch', () => undefined);
    await settle();
    for (let beat = 0; beat < 8; beat += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      push?.(': keep-alive\n\n');
      await settle();
    }
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });

  it("Snowflake's \"service is not running\" answer to any request means ZLens stopped: the page then sends nothing more", async () => {
    setSnowflakeApp(true);
    const snowflake503 = '{"requestId":"r","responseType":"ERROR_SERVICE_UNAVAILABLE","detail":"Service ZLENS not reachable: service is not yet running (serviceStatus=PENDING)."}';
    const send = vi.fn(async (input: RequestInfo | URL) => String(input).includes('host/ui')
      ? new Response(snowflake503, { status: 503 })
      : new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', send);
    watchForStoppedService();
    await fetch('/api/operations?limit=50');
    expect(isZLensStopped()).toBe(false);
    const answer = await fetch('/api/host/ui');
    expect(answer.status).toBe(503);
    expect(zlensStopped()).toEqual({ reason: 'stopped' });
    let answered = false;
    void fetch('/api/operations?limit=50').then(() => { answered = true; }, () => { answered = true; });
    await settle();
    expect(answered).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reads only Snowflake\'s own not-running answer that way', () => {
    expect(snowflakeSaysNotRunning(503, '{"responseType":"ERROR_SERVICE_UNAVAILABLE"}')).toBe(true);
    expect(snowflakeSaysNotRunning(503, 'Service ZLENS not reachable: service is not yet running')).toBe(true);
    expect(snowflakeSaysNotRunning(503, '{"error":"Cortex is busy"}')).toBe(false);
    expect(snowflakeSaysNotRunning(500, '{"responseType":"ERROR_SERVICE_UNAVAILABLE"}')).toBe(false);
  });
});
