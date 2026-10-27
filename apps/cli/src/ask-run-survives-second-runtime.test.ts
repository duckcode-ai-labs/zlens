import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createScriptedAnalystProvider, type AgentProvider } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

/**
 * ZLens 0.1.0 e2e, F10: a person asked on the Ask page, went to another page
 * and came back to "The local ZLens runtime restarted before this agent run
 * completed" (RUN_INTERRUPTED at executor.started), although the notebook
 * server never stopped. Leaving the page only switches the page from the
 * stream to reading the run by id; what closed the run was another ZLens
 * runtime opening the same project (a second `zlens notebook`, the runtime
 * `zlens agent ask` starts), whose run store closed every unfinished run as
 * if the runtime that owned it had died. The notebook then finished the
 * answer, but the page had already shown the interruption.
 *
 * Here the answer is held mid-run, a second runtime opens the project, and
 * the run is read back by id the way the returning page reads it.
 */
const here = dirname(fileURLToPath(import.meta.url));

const executor = {
  executeQuery: async (sql: string) => {
    const columns = [...sql.matchAll(/\sAS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)].map((match) => match[1]);
    const names = columns.length ? columns : ['value'];
    const rows = [1, 2, 3].map((index) => Object.fromEntries(names.map((name) => [name, /(revenue|spend|amount|count|total)/i.test(name) ? 1000 - index : `Row ${index}`])));
    return { columns: names, rows, rowCount: rows.length, sql };
  },
} as unknown as QueryExecutor;

let release: () => void = () => {};
let reachedModel: () => void = () => {};
const gate = new Promise<void>((done) => { release = done; });
const modelReached = new Promise<void>((done) => { reachedModel = done; });

/** The cooperative scripted analyst, held at its first model call until the test lets it go. */
function heldProvider(): AgentProvider {
  const inner = createScriptedAnalystProvider('cooperative');
  return {
    name: inner.name,
    available: () => inner.available(),
    generate: async (messages, options) => {
      reachedModel();
      await gate;
      return inner.generate(messages, options);
    },
  };
}

const servers: Server[] = [];
let root = '';
let base = '';
const previousMetricFlow = process.env.ZLENS_METRICFLOW_BIN;

beforeAll(async () => {
  process.env.ZLENS_METRICFLOW_BIN = join(tmpdir(), 'dql-second-runtime-no-metricflow', 'mf');
  root = mkdtempSync(join(tmpdir(), 'dql-ask-second-runtime-'));
  cpSync(resolve(here, '../test/fixtures/jaffle-semantic'), root, { recursive: true });
  rmSync(join(root, '.dql'), { recursive: true, force: true });
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor,
    connection: { driver: 'file' },
    askAnalyticalPlannerProviderFactory: () => heldProvider(),
    preferredPort: 0,
    captureServer: (created) => { servers.push(created); },
  });
  base = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  release();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  rmSync(root, { recursive: true, force: true });
  if (previousMetricFlow === undefined) delete process.env.ZLENS_METRICFLOW_BIN;
  else process.env.ZLENS_METRICFLOW_BIN = previousMetricFlow;
});

/** Start a streamed run the way the Ask page does and return its server-owned id once accepted. */
async function startStreamedRun(question: string): Promise<{ runId: string; leave: () => Promise<void> }> {
  const response = await fetch(`${base}/api/agent-runs?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `second-runtime-${Date.now()}` },
    body: JSON.stringify({ question, requestedMode: 'auto', executionTarget: { target: 'connection', connectionName: 'default' }, workspaceContext: {} }),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!/event: agent-run-accepted[\s\S]*?\n\n/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const accepted = /event: agent-run-accepted\ndata: (.+)\n/.exec(text);
  expect(accepted, text.slice(0, 400)).toBeTruthy();
  const runId = (JSON.parse(accepted![1]!) as { runId: string }).runId;
  // Leaving the page drops the stream; the server-owned run must not notice.
  return { runId, leave: () => reader.cancel().catch(() => undefined) };
}

type RunState = { lifecycleState: string; run?: { status: string; diagnosticReceipt?: { failure?: { code?: string } } } };
async function readRun(at: string, runId: string): Promise<RunState> {
  return await (await fetch(`${at}/api/agent-runs/${encodeURIComponent(runId)}`)).json() as RunState;
}

describe('an Ask run outlives another ZLens runtime opening the same project', () => {
  it('keeps running, and the page that comes back finds it running, then its answer', async () => {
    // A question the model reads: the fixture block records "Who are the top customers by lifetime spend?" as
    // its own and answers it before any model call, which this test holds.
    const { runId, leave } = await startStreamedRun('Show the top customers by lifetime spend');
    await modelReached;
    // The person goes to another page: the page stops reading the stream.
    await leave();

    // Another runtime opens the project while the answer is mid-run.
    const port = await startLocalServer({
      rootDir: root,
      projectRoot: root,
      executor,
      connection: { driver: 'file' },
      preferredPort: 0,
      captureServer: (created) => { servers.push(created); },
    });
    const other = `http://127.0.0.1:${port}`;

    // The returning page reads the run by id: still running, not "the runtime restarted".
    const midway = await readRun(base, runId);
    expect(midway.run?.diagnosticReceipt?.failure?.code).not.toBe('RUN_INTERRUPTED');
    expect(midway.lifecycleState).not.toBe('terminal');

    release();
    let finished = await readRun(base, runId);
    for (let attempt = 0; attempt < 200 && finished.lifecycleState !== 'terminal'; attempt += 1) {
      await new Promise((done) => setTimeout(done, 50));
      finished = await readRun(base, runId);
    }
    expect(finished.lifecycleState).toBe('terminal');
    expect(finished.run?.diagnosticReceipt?.failure?.code).not.toBe('RUN_INTERRUPTED');
    expect(finished.run?.status).toBe('completed');
    // Both runtimes read the same finished answer.
    expect((await readRun(other, runId)).run?.status).toBe('completed');
  }, 120_000);
});
