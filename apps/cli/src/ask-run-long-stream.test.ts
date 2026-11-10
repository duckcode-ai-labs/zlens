import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createScriptedAnalystProvider, type AgentProvider } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

/**
 * Outside test V7/V8 (Snowflake Native App): an Ask run that took 1 min 36 s
 * showed a red "network error", and the question was put back in the box.
 * Snowflake documents that its ingress ends a connection with no activity for
 * 90 seconds. The Ask stream sends nothing while one long AI step runs
 * (reading the question took up to 70 s on Cortex).
 *
 * Here a proxy cuts any connection that is quiet for IDLE_CUT_MS, the way the
 * ingress does, and the AI step takes longer than that. The stream must reach
 * its answer through the proxy, because the server keeps it alive.
 *
 * The times are the ingress's 90 s and a 120 s AI step, scaled down so the
 * test runs in seconds.
 */
const IDLE_CUT_MS = 1_500;
const AI_STEP_MS = 4_000;
const KEEP_ALIVE_MS = 400;

const here = dirname(fileURLToPath(import.meta.url));

const executor = {
  executeQuery: async (sql: string) => {
    const columns = [...sql.matchAll(/\sAS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)].map((match) => match[1]);
    const names = columns.length ? columns : ['value'];
    const rows = [1, 2, 3].map((index) => Object.fromEntries(names.map((name) => [name, /(revenue|spend|amount|count|total)/i.test(name) ? 1000 - index : `Row ${index}`])));
    return { columns: names, rows, rowCount: rows.length, sql };
  },
} as unknown as QueryExecutor;

/** The cooperative scripted analyst, whose first AI call is slow. */
function slowProvider(): AgentProvider {
  const inner = createScriptedAnalystProvider('cooperative');
  let first = true;
  return {
    name: inner.name,
    available: () => inner.available(),
    generate: async (messages, options) => {
      if (first) {
        first = false;
        await new Promise((done) => setTimeout(done, AI_STEP_MS));
      }
      return inner.generate(messages, options);
    },
  };
}

/**
 * A TCP proxy that ends a connection once no bytes have gone either way for
 * `idleMs`. It also ends idle pooled connections between requests, as the
 * ingress does, so a test reads each stream's own outcome, not the cut count.
 */
function startIdleCuttingProxy(upstreamPort: number, idleMs: number): Promise<{ port: number; cuts: () => number; close: () => Promise<void> }> {
  let cuts = 0;
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer((client) => {
    const upstream = connect(upstreamPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    let timer: NodeJS.Timeout | undefined;
    const cut = () => {
      cuts += 1;
      client.destroy();
      upstream.destroy();
    };
    const touch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(cut, idleMs);
    };
    touch();
    client.on('data', (chunk) => { touch(); upstream.write(chunk); });
    upstream.on('data', (chunk) => { touch(); client.write(chunk); });
    const end = () => {
      if (timer) clearTimeout(timer);
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('close', end);
    upstream.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      ready({
        port,
        cuts: () => cuts,
        close: () => new Promise<void>((closed) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => closed());
        }),
      });
    });
  });
}

const servers: Server[] = [];
let root = '';
const previousMetricFlow = process.env.ZLENS_METRICFLOW_BIN;

type Runtime = { direct: string; proxied: string; proxy: Awaited<ReturnType<typeof startIdleCuttingProxy>> };
/** With keep-alive lines, and without them (as before the fix). Each behind its own cutting proxy. */
let kept: Runtime;
let bare: Runtime;

async function startRuntime(keepAliveMs: number): Promise<Runtime> {
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor,
    connection: { driver: 'file' },
    askAnalyticalPlannerProviderFactory: () => slowProvider(),
    agentRunStreamKeepAliveMs: keepAliveMs,
    preferredPort: 0,
    captureServer: (created) => { servers.push(created); },
  });
  const proxy = await startIdleCuttingProxy(port, IDLE_CUT_MS);
  return { direct: `http://127.0.0.1:${port}`, proxied: `http://127.0.0.1:${proxy.port}`, proxy };
}

beforeAll(async () => {
  process.env.ZLENS_METRICFLOW_BIN = join(tmpdir(), 'dql-long-stream-no-metricflow', 'mf');
  root = mkdtempSync(join(tmpdir(), 'dql-ask-long-stream-'));
  cpSync(resolve(here, '../test/fixtures/jaffle-semantic'), root, { recursive: true });
  rmSync(join(root, '.dql'), { recursive: true, force: true });
  kept = await startRuntime(KEEP_ALIVE_MS);
  bare = await startRuntime(0);
}, 120_000);

afterAll(async () => {
  await kept?.proxy.close();
  await bare?.proxy.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  rmSync(root, { recursive: true, force: true });
  if (previousMetricFlow === undefined) delete process.env.ZLENS_METRICFLOW_BIN;
  else process.env.ZLENS_METRICFLOW_BIN = previousMetricFlow;
});

type StreamOutcome = { runId?: string; completed: boolean; replayed: boolean; dropped?: string; keepAlives: number; text: string };

const askBody = (question: string) => JSON.stringify({ question, requestedMode: 'auto', executionTarget: { target: 'connection', connectionName: 'default' }, workspaceContext: {} });

/** Ask the way the Ask page does, through the runtime's proxy, and read the stream to its end (or `untilAccepted`). */
async function askThroughProxy(runtime: Runtime, question: string, key: string, untilAccepted = false): Promise<StreamOutcome> {
  const response = await fetch(`${runtime.proxied}/api/agent-runs?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: askBody(question),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let dropped: string | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (done) break;
      if (untilAccepted && /event: agent-run-accepted\ndata: .+\n\n/.test(text)) {
        await reader.cancel();
        break;
      }
    }
  } catch (error) {
    dropped = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const accepted = /event: agent-run-accepted\ndata: (.+)\n/.exec(text);
  const acceptedPayload = accepted ? JSON.parse(accepted[1]!) as { runId: string; replayed?: boolean } : undefined;
  return {
    runId: acceptedPayload?.runId,
    completed: /event: agent-run-complete\n/.test(text),
    replayed: acceptedPayload?.replayed === true,
    ...(dropped ? { dropped } : {}),
    keepAlives: text.split('\n').filter((line) => line.startsWith(':')).length,
    text,
  };
}

async function readRunState(runtime: Runtime, runId: string): Promise<{ lifecycleState: string }> {
  return await (await fetch(`${runtime.direct}/api/agent-runs/${encodeURIComponent(runId)}`)).json() as { lifecycleState: string };
}

describe('a long Ask run behind an ingress that cuts quiet connections', () => {
  it('without keep-alive lines (as before) the stream is cut mid-run, yet the run finishes and can be read by id', async () => {
    const outcome = await askThroughProxy(bare, 'Show the top customers by lifetime spend', `long-stream-bare-${Date.now()}`);
    expect(outcome.runId, outcome.text.slice(0, 400)).toBeTruthy();
    // What the page saw as "network error": the connection ended under the stream.
    expect(outcome.completed).toBe(false);
    expect(outcome.dropped ?? 'ended without an answer').toBeTruthy();
    expect(bare.proxy.cuts()).toBeGreaterThan(0);
    // The run is the server's and goes on; the page now reads it by id instead of failing.
    let state = await readRunState(bare, outcome.runId!);
    for (let attempt = 0; attempt < 100 && state.lifecycleState !== 'terminal'; attempt += 1) {
      await new Promise((done) => setTimeout(done, 100));
      state = await readRunState(bare, outcome.runId!);
    }
    expect(state.lifecycleState).toBe('terminal');
  }, 60_000);

  it('keeps the stream alive through an AI step longer than the idle cut, and the answer arrives on it', async () => {
    const started = Date.now();
    const outcome = await askThroughProxy(kept, 'Show the top customers by lifetime spend', `long-stream-kept-${Date.now()}`);
    const elapsed = Date.now() - started;

    expect(outcome.runId, outcome.text.slice(0, 400)).toBeTruthy();
    // The run outlasted the idle cut; it reached its answer on the same stream.
    expect(elapsed).toBeGreaterThan(IDLE_CUT_MS);
    expect(outcome.dropped).toBeUndefined();
    expect(outcome.completed, outcome.text.slice(-400)).toBe(true);
    // Keep-alive lines are SSE comments, which every reader skips.
    expect(outcome.keepAlives).toBeGreaterThan(0);
    expect((await readRunState(kept, outcome.runId!)).lifecycleState).toBe('terminal');
  }, 60_000);

  it('a page that re-sends the same submission attaches to the running run, and that stream stays alive too', async () => {
    const key = `long-stream-replay-${Date.now()}`;
    const question = 'Show the top customers by lifetime spend';
    const first = await askThroughProxy(kept, question, key, true);
    expect(first.runId).toBeTruthy();
    const again = await askThroughProxy(kept, question, key);
    expect(again.replayed).toBe(true);
    expect(again.runId).toBe(first.runId);
    expect(again.dropped).toBeUndefined();
    expect(again.completed, again.text.slice(-400)).toBe(true);
    expect(again.keepAlives).toBeGreaterThan(0);
  }, 60_000);
});
