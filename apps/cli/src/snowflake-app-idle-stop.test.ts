import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import { SNAPSHOT_PREFIX } from './snowflake-app-backups.js';
import {
  IDLE_WORK_HOLD_MS,
  IdleSuspender,
  countsAsUse,
  stoppingEventFrame,
  tellPagesOnStopSignal,
  type StopSignalSource,
} from './snowflake-app-settings.js';

/**
 * V4 idle stop: the app for Snowflake stops itself after a quiet spell, but an open ZLens tab held it up for
 * ever (its event streams were "in flight" as long as the tab was open, and its polls restarted the clock),
 * and after a stop the tab's reconnects woke the service again. Now only someone's requests count, open pages
 * are told before ZLens stops, and a page told so asks for nothing more.
 */
const MINUTE = 60_000;

describe('what counts as someone using ZLens', () => {
  it('a person\'s request does; the probe, the page\'s event streams and its background asks do not', () => {
    expect(countsAsUse('GET', '/', {})).toBe(true);
    expect(countsAsUse('GET', '/api/operations', {})).toBe(true);
    expect(countsAsUse('POST', '/api/agent-runs', {})).toBe(true);
    expect(countsAsUse('GET', '/api/health', {})).toBe(false);
    expect(countsAsUse('GET', '/api/operations/events', {})).toBe(false);
    expect(countsAsUse('GET', '/api/watch', {})).toBe(false);
    // What an open page asks for by itself, long after anyone touched it.
    expect(countsAsUse('GET', '/api/operations', { 'x-dql-background': '1' })).toBe(false);
    expect(countsAsUse('GET', '/api/snowflake-app/setup', { 'x-dql-background': '1' })).toBe(false);
    // The polls of a long request follow work a person started.
    expect(countsAsUse('GET', '/api/long-requests/abc', { 'x-dql-background': '1' })).toBe(true);
  });
});

describe('stopping when idle, with timers', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('an open event stream does not hold ZLens up; a person\'s request does, until it ends and the quiet spell passes', async () => {
    vi.useFakeTimers();
    let stops = 0;
    const idle = new IdleSuspender(60 * MINUTE, async () => { stops += 1; });
    idle.start(MINUTE);
    // A page's event streams never touch the clock (countsAsUse is false for them), so nothing holds it.
    await vi.advanceTimersByTimeAsync(59 * MINUTE);
    expect(stops).toBe(0);
    // Someone runs a long Ask: in flight for 30 minutes.
    const askDone = idle.touch();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(stops).toBe(0);
    askDone();
    await vi.advanceTimersByTimeAsync(59 * MINUTE);
    expect(stops).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(stops).toBe(1);
    idle.stop();
  });

  it('server work someone started holds ZLens up while it runs, then the quiet spell starts again; never for ever', async () => {
    vi.useFakeTimers();
    let stops = 0;
    let working = true;
    const idle = new IdleSuspender(60 * MINUTE, async () => { stops += 1; });
    idle.holdWhile(() => working);
    idle.start(MINUTE);
    await vi.advanceTimersByTimeAsync(90 * MINUTE);
    expect(stops).toBe(0);
    working = false;
    await vi.advanceTimersByTimeAsync(58 * MINUTE);
    expect(stops).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(stops).toBe(1);
    idle.stop();

    // Work that never ends holds it up at most IDLE_WORK_HOLD_MS after the last use.
    let stuckStops = 0;
    const stuck = new IdleSuspender(60 * MINUTE, async () => { stuckStops += 1; });
    stuck.holdWhile(() => true);
    stuck.start(MINUTE);
    await vi.advanceTimersByTimeAsync(IDLE_WORK_HOLD_MS - MINUTE);
    expect(stuckStops).toBe(0);
    await vi.advanceTimersByTimeAsync(62 * MINUTE);
    expect(stuckStops).toBe(1);
    stuck.stop();
  });
});

describe('the stop signal', () => {
  function fakeProcess(): StopSignalSource & EventEmitter & { kills: string[] } {
    const emitter = new EventEmitter() as EventEmitter & StopSignalSource & { kills: string[] };
    emitter.kills = [];
    Object.assign(emitter, { pid: 4242, kill: (_pid: number, signal: string) => { emitter.kills.push(signal); return true; } });
    return emitter;
  }

  it('tells the pages before zlens notebook exits, and leaves the exit to it', () => {
    const proc = fakeProcess();
    const order: string[] = [];
    proc.once('SIGTERM', () => order.push('exit'));
    const forget = tellPagesOnStopSignal(() => order.push('told'), proc);
    proc.emit('SIGTERM');
    expect(order).toEqual(['told', 'exit']);
    expect(proc.kills).toEqual([]);
    forget();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  it('still ends the process on SIGTERM when nothing else listens', () => {
    const proc = fakeProcess();
    let told = 0;
    tellPagesOnStopSignal(() => { told += 1; }, proc);
    proc.emit('SIGTERM');
    expect(told).toBe(1);
    expect(proc.kills).toEqual(['SIGTERM']);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const USER = { 'Sf-Context-Current-User': 'JSMITH' };

async function startApp() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-sf-idle-stop-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'sf', connections: { default: { driver: 'sqlite', filepath: 'main.sqlite' } } }));
  const clock = { now: 1_000_000 };
  const sql: string[] = [];
  let idle: IdleSuspender | undefined;
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, host: '127.0.0.1',
    snowflakeIngress: {},
    snowflakeAppQuery: async (statement) => {
      sql.push(statement);
      // Today's backup is done, so stopping does not take one (snowflake-app-backups.test.ts covers that).
      return statement.startsWith('SHOW SNAPSHOTS') ? [{ name: `${SNAPSHOT_PREFIX}TODAY`, state: 'CREATED', created_on: new Date().toISOString() }] : [];
    },
    snowflakeIdleSuspend: { minutes: 60, service: 'ZLENS_APP.CORE.ZLENS', now: () => clock.now, capture: (created) => { idle = created; } },
    captureServer: (created) => { servers.push(created); },
  });
  if (!idle) throw new Error('The idle stop is not on.');
  const call = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { ...USER, ...headers } });
  return { port, clock, sql, idle: idle as IdleSuspender, call };
}

/** An open event stream, read as it arrives. */
async function openStream(call: (path: string) => Promise<Response>, path: string) {
  const response = await call(path);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let ended = false;
  return {
    /** Read until `wanted` arrived or the stream ended; the text so far. */
    async until(wanted: string, ms = 5_000): Promise<{ text: string; ended: boolean }> {
      const deadline = Date.now() + ms;
      while (!ended && !text.includes(wanted) && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), Math.max(1, deadline - Date.now()))),
        ]);
        if (!next) break;
        if (next.done) ended = true;
        else text += decoder.decode(next.value, { stream: true });
      }
      return { text, ended };
    },
    async endedWithin(ms = 5_000): Promise<boolean> {
      await this.until('\u0000never', ms);
      return ended;
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

describe('the app for Snowflake, with a ZLens tab open', () => {
  it('stops after the quiet spell although the tab\'s event streams are open, and tells the tab first', async () => {
    const app = await startApp();
    const operations = await openStream(app.call, '/api/operations/events');
    const watch = await openStream(app.call, '/api/watch');
    await operations.until(': connected');
    await watch.until(': connected');
    // The tab, untouched, keeps polling in the background: none of it counts.
    expect((await app.call('/api/operations?limit=50', { 'x-dql-background': '1' })).status).toBe(200);

    app.clock.now += 61 * MINUTE;
    expect(app.idle.due()).toBe(true);
    expect(await app.idle.check()).toBe(true);
    expect(app.sql).toContain('ALTER SERVICE ZLENS_APP.CORE.ZLENS SUSPEND');

    const frame = stoppingEventFrame({ reason: 'idle', idleMinutes: 60 });
    expect(frame).toBe('event: stopping\ndata: {"reason":"idle","idleMinutes":60}\n\n');
    for (const stream of [operations, watch]) {
      const { text } = await stream.until(frame);
      expect(text).toContain(frame);
      // The stream ends with it: there is nothing more to follow.
      expect(await stream.endedWithin()).toBe(true);
    }
    // A page that opens a stream now (another tab, a reconnect) is told at once.
    const late = await openStream(app.call, '/api/watch');
    expect((await late.until(frame)).text).toContain(frame);
    expect(await late.endedWithin()).toBe(true);
  });

  it('keeps running while a person uses it, counting from their last request', async () => {
    const app = await startApp();
    const watch = await openStream(app.call, '/api/watch');
    await watch.until(': connected');

    app.clock.now += 30 * MINUTE;
    expect((await app.call('/api/operations?limit=50')).status).toBe(200);
    app.clock.now += 31 * MINUTE;
    expect(app.idle.due()).toBe(false);
    expect(await app.idle.check()).toBe(false);
    // A background poll, even a failing one, does not restart the clock; a long request's poll does.
    expect((await app.call('/api/operations?limit=50', { 'x-dql-background': '1' })).status).toBe(200);
    app.clock.now += 30 * MINUTE;
    expect(app.idle.due()).toBe(true);
    expect((await app.call('/api/long-requests/gone', { 'x-dql-background': '1' })).status).toBe(404);
    expect(app.idle.due()).toBe(false);
    app.clock.now += 61 * MINUTE;
    expect(app.idle.due()).toBe(true);
    // Nothing stopped yet, so nothing was said on the stream.
    expect((await watch.until('event: stopping', 200)).text).not.toContain('event: stopping');
    expect(app.sql.filter((statement) => statement.includes('SUSPEND'))).toEqual([]);
    await watch.cancel();
  });

  it('a person\'s request still running holds it up, however long the tab has been idle', async () => {
    const app = await startApp();
    const done = app.idle.touch();
    app.clock.now += 3 * 60 * MINUTE;
    expect(app.idle.due()).toBe(false);
    done();
    app.clock.now += 61 * MINUTE;
    expect(app.idle.due()).toBe(true);
  });

  it('tells the open tabs when the process is stopped (stop_app(), or Snowflake suspending the service)', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    const app = await startApp();
    const added = process.listeners('SIGTERM').filter((listener) => !before.has(listener));
    expect(added).toHaveLength(1);
    const operations = await openStream(app.call, '/api/operations/events');
    await operations.until(': connected');
    // zlens notebook has its own SIGTERM listener, which exits: this one only tells the pages.
    const exit = () => undefined;
    process.on('SIGTERM', exit);
    try {
      (added[0] as () => void)();
    } finally {
      process.removeListener('SIGTERM', exit);
    }
    const frame = stoppingEventFrame({ reason: 'stopped' });
    expect((await operations.until(frame)).text).toContain(frame);
    expect(await operations.endedWithin()).toBe(true);
  });

  it('removes its stop-signal listener when the server closes', async () => {
    const before = process.listenerCount('SIGTERM');
    await startApp();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    const server = servers.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
