import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AgentMessage, AgentProvider } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

/**
 * Live gate round 3, check W1 (ZLens Enterprise): a person asked a question no
 * block answered and got an AI-generated answer. A block answering it was then
 * built, certified and deployed. Asked again, `POST /api/agent-runs` with the
 * question alone came back Certified; the same words typed in the Ask page
 * (a thread whose previous turn was the AI-generated answer) came back
 * "review / generated_answer", twice.
 *
 * The thread is the difference. With a threadId the host hands the pipeline
 * the previous turn's executed reading as `prior`; the interpreter is then
 * told THIS IS A FOLLOW-UP: treat the message as an EDIT, keep every clause it
 * does not change — and the lexical reading is skipped. A re-ask of the same
 * words changes nothing, so a prompt-compliant interpreter returns the
 * previous (AI-drafted, column-level) reading with every ref "inherited", and
 * the certified tier never sees the block. The API path has no thread, so the
 * question is read fresh and the block answers.
 *
 * The provider below is that prompt-compliant interpreter: fresh, it picks the
 * certified block when one is shown and raw columns otherwise (the AI-SQL
 * lane); as a follow-up it inherits the previous analysis verbatim.
 */
const here = dirname(fileURLToPath(import.meta.url));
const QUESTION = 'Who are the top customers by lifetime spend?';
const BLOCK_FILE = 'blocks/top_customers.dql';

const executor = {
  executeQuery: async (sql: string) => {
    const columns = [...sql.matchAll(/\sAS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)].map((match) => match[1]);
    const names = columns.length ? columns : ['value'];
    const rows = [1, 2, 3].map((index) => Object.fromEntries(names.map((name) => [name, /(revenue|spend|amount|count|total)/i.test(name) ? 1000 - index : `Row ${index}`])));
    return { columns: names, rows, rowCount: rows.length, sql };
  },
} as unknown as QueryExecutor;

const INTENT_PROMPT_MARKER = 'as a JSON AnalyticalIntent';
const PRIOR_MARKER = 'PREVIOUS ANALYSIS (executed):';
const FOLLOW_UP_RULE = 'THIS IS A FOLLOW-UP';

function refsOf(prompt: string, prefix: string): string[] {
  return [...new Set([...prompt.matchAll(new RegExp(`(?:^|\\s)(${prefix}:[A-Za-z0-9_.-]+)`, 'g'))].map((match) => match[1]!))];
}

function intentJson(fields: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, kind: 'analytics', groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...fields });
}

/** An interpreter that follows the prompt: a fresh question is read on its own; a follow-up is an edit of the previous analysis. */
function promptCompliantProvider(): AgentProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'ollama',
    prompts,
    available: async () => true,
    async generate(messages: AgentMessage[]): Promise<string> {
      const prompt = messages.map((message) => message.content).join('\n');
      prompts.push(prompt);
      if (prompt.includes(INTENT_PROMPT_MARKER)) {
        const priorAt = prompt.indexOf(PRIOR_MARKER);
        if (priorAt >= 0) {
          // Rule 10 ("keep every clause the message does not change"): the same words change nothing.
          const line = prompt.slice(priorAt + PRIOR_MARKER.length).trim().split('\n')[0]!;
          const prior = JSON.parse(line) as Record<string, unknown> & { measures: Array<{ ref: string }> };
          return intentJson({
            reading: prior.reading, measures: prior.measures, groupBy: prior.groupBy, display: prior.display, filters: prior.filters,
            ...(prior.ordering ? { ordering: prior.ordering } : {}), ...(prior.limit ? { limit: prior.limit } : {}), expectedShape: prior.expectedShape,
            provenance: Object.fromEntries(prior.measures.map((measure) => [measure.ref, 'inherited'])),
          });
        }
        const block = refsOf(prompt, 'block').find((ref) => /top_customers$/.test(ref));
        if (block) return intentJson({ reading: 'Top customers by lifetime spend, from the certified block.', measures: [{ ref: block }], provenance: { [block]: 'q:top customers by lifetime spend' } });
        const spend = refsOf(prompt, 'column').find((ref) => /dim_customers\.lifetime_spend$/.test(ref));
        const key = refsOf(prompt, 'entity').find((ref) => /customer$/.test(ref));
        const label = refsOf(prompt, 'dimension').find((ref) => /customer_name$/.test(ref)) ?? refsOf(prompt, 'column').find((ref) => /dim_customers\.customer_name$/.test(ref));
        return intentJson({
          reading: 'Rank customers by summed lifetime spend.',
          measures: [{ ref: spend, aggregation: 'sum' }],
          groupBy: key ? [{ ref: key, role: 'key' }] : [],
          display: label ? [label] : [],
          ...(spend ? { ordering: { ref: spend, direction: 'desc' } } : {}), limit: 10,
          provenance: { ...(spend ? { [spend]: 'q:lifetime spend' } : {}), ...(key ? { [key]: 'q:customers' } : {}) },
        });
      }
      if (prompt.includes('You write exactly ONE read-only SQL statement')) {
        return 'SELECT customer_id, customer_name, SUM(lifetime_spend) AS lifetime_spend FROM jaffle_shop.dev.dim_customers GROUP BY customer_id, customer_name ORDER BY lifetime_spend DESC LIMIT 10';
      }
      if (prompt.includes('You check one query result')) return '{"answers": true}';
      return '```json\n{"tool":"finish_answer","input":{"answer":"Here is the result.","evidenceIds":[]}}\n```';
    },
  };
}

interface RunView { id?: string; route?: string; trustState?: string; status?: string }
const view = (run: any): RunView => ({ id: run?.id, route: run?.route, trustState: run?.trustState, status: run?.status });

let base = '';
let server: Server | undefined;
let root = '';
let certifiedBlockSource = '';
const provider = promptCompliantProvider();
/** How the interpreter was prompted for the latest run: fresh, or as an edit of a previous analysis. */
const lastReading = () => {
  const prompt = [...provider.prompts].reverse().find((entry) => entry.includes(INTENT_PROMPT_MARKER)) ?? '';
  return { asFollowUp: prompt.includes(FOLLOW_UP_RULE) && prompt.includes(PRIOR_MARKER), blocksShown: refsOf(prompt, 'block') };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dql-ask-thread-recertified-'));
  cpSync(resolve(here, '../test/fixtures/jaffle-semantic'), root, { recursive: true });
  rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
  // The block that answers the question does not exist yet.
  certifiedBlockSource = readFileSync(join(root, BLOCK_FILE), 'utf-8');
  rmSync(join(root, BLOCK_FILE));
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor,
    connection: { driver: 'file' },
    askAnalyticalPlannerProviderFactory: () => provider,
    preferredPort: 0,
    captureServer: (created) => { server = created; },
  });
  base = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((done) => server ? server.close(() => done()) : done());
  rmSync(root, { recursive: true, force: true });
});

/** The check's API call: the question alone. */
async function askThroughApi(question: string): Promise<RunView> {
  const response = await fetch(`${base}/api/agent-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
  expect(response.status).toBe(201);
  return view(((await response.json()) as { run: unknown }).run);
}

async function openThread(title: string): Promise<string> {
  const created = await fetch(`${base}/api/agent/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ surface: 'ask', title }) });
  return ((await created.json()) as { thread: { id: string } }).thread.id;
}

/** What the Ask page sends: a streamed run in a thread, with a fresh submission identity, the composer's options and the client-built history. */
async function askThroughPage(question: string, threadId: string, history: Array<{ role: 'user' | 'assistant'; text: string }> = []): Promise<RunView & { replayed?: boolean }> {
  const submission = `submission-${Math.random().toString(16).slice(2)}`;
  const response = await fetch(`${base}/api/agent-runs?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission },
    body: JSON.stringify({
      question, requestedMode: 'auto', audience: 'stakeholder',
      executionTarget: { target: 'connection', connectionName: 'default' },
      workspaceContext: {}, history, thinkingMode: 'auto', researchResultRowsOptIn: false, threadId,
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const frames = text.split('\n\n');
  const accepted = frames.find((frame) => frame.startsWith('event: agent-run-accepted'));
  const complete = frames.find((frame) => frame.startsWith('event: agent-run-complete'));
  expect(complete, text.slice(0, 600)).toBeDefined();
  const data = (frame: string) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length));
  return { ...view(data(complete!)), replayed: accepted ? Boolean(data(accepted).replayed) : undefined };
}

const CERTIFIED = { route: 'certified_answer', trustState: 'certified', status: 'completed' };

describe('a block certified after an AI-generated answer in the thread answers the same question asked again', () => {
  let threadId = '';
  const history = [{ role: 'user' as const, text: QUESTION }, { role: 'assistant' as const, text: 'Here is the result.' }];

  it('the Ask page (thread + stream) and the API both return the certified answer', async () => {
    threadId = await openThread(QUESTION);
    const generated = await askThroughPage(QUESTION, threadId);
    expect(generated, JSON.stringify(generated)).toMatchObject({ route: 'generated_answer', trustState: 'review_required' });
    expect(lastReading()).toMatchObject({ asFollowUp: false });

    // The block answering the question is built, certified and deployed.
    writeFileSync(join(root, BLOCK_FILE), certifiedBlockSource);
    const api = await askThroughApi(QUESTION);
    expect(api, JSON.stringify(api)).toMatchObject(CERTIFIED);

    // Asked again in the same thread, with the page's own history of the earlier answer: a new run, not a replay,
    // read on its own words (not as an edit of the AI-drafted reading) with the block in view.
    const page = await askThroughPage(QUESTION, threadId, history);
    expect(page.replayed).toBe(false);
    expect(page.id).not.toBe(generated.id);
    expect(lastReading()).toEqual({ asFollowUp: false, blocksShown: expect.arrayContaining(['block:orders.top_customers']) });
    expect(page, JSON.stringify(page)).toMatchObject(CERTIFIED);
    const again = await askThroughPage(QUESTION, threadId, history);
    expect(again, JSON.stringify(again)).toMatchObject(CERTIFIED);
    expect(lastReading()).toMatchObject({ asFollowUp: false });
  }, 120_000);

  it('a genuine follow-up in the thread is still read as an edit of the previous analysis, also when it is sent twice', async () => {
    const followUp = await askThroughPage('only the drink buyers', threadId, history);
    expect(lastReading()).toMatchObject({ asFollowUp: true });
    expect(followUp, JSON.stringify(followUp)).toMatchObject({ status: 'completed' });
    // The same follow-up sent again is read the way it was read the first time: as an edit, never on its own.
    const repeated = await askThroughPage('only the drink buyers', threadId, history);
    expect(lastReading()).toMatchObject({ asFollowUp: true });
    expect(repeated, JSON.stringify(repeated)).toMatchObject({ status: 'completed' });
  }, 120_000);
});
