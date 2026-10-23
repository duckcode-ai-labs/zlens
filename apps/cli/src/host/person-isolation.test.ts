import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRunExecutors } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * RFC 0010, one test for every kind of a person's own content. With a host, Priya does everything that keeps
 * something of hers (an answer, a conversation, a note, a research run, an App memo and conversation, a notebook's
 * last run, ...), each carrying a canary. Then:
 *
 * 1. Dan, signed in on the same server, reads every route that lists or opens such content (the PER_PERSON table)
 *    and never receives the canary; by id, Priya's records are not found for him.
 * 2. Every file under the project that holds the canary is a registered per-person store (STORES), whose reads are
 *    filtered by owner. A new store that keeps a person's content without being registered here fails this test:
 *    register it with how its reads are filtered (and add its routes to PER_PERSON), or keep the content out of it.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };
const CANARY = 'CANARYPERSON7f3a';

/**
 * Every store that may hold a person's own content with a host, by path under the project, and how reads of it are
 * kept to its owner. A file matching none of these that holds Priya's canary fails the test.
 */
const STORES: Array<{ path: RegExp; owner: string }> = [
  { path: /^\.dql\/local\/agent-runs\.sqlite(-wal|-shm)?$/, owner: 'Ask runs: owner_id = the signed-in person, filtered in SQL (HH-10)' },
  { path: /^\.dql\/local\/agent-conversations\.sqlite(-wal|-shm)?$/, owner: 'conversations: each thread keeps its owner; others answer 404' },
  { path: /^\.dql\/cache\/agent-memory\.sqlite(-wal|-shm)?$/, owner: 'memory: a person\'s note is scope user, scopeId = their id; only theirs are listed' },
  { path: /^\.dql\/cache\/operations\.sqlite(-wal|-shm)?$/, owner: 'operations: each keeps who started it; list, by id, cancel and stream are theirs' },
  { path: /^\.dql\/local\/apps\.sqlite(-wal|-shm)?$/, owner: 'App memos and conversations: owner_id = the signed-in person (LocalAppStorage owner)' },
  { path: /^\.dql\/local\/private\/research\/p-[^/]+\.sqlite(-wal|-shm)?$/, owner: 'notebook research: one store per person' },
  { path: /^\.dql\/local\/private\/home\/p-[^/]+\.json$/, owner: 'Home: one file per person' },
  { path: /^\.dql\/local\/private\/run-snapshots\/p-[^/]+\//, owner: 'a notebook\'s last run: kept per person' },
  { path: /^\.dql\/imports\/imp_[^/]+\/(manifest|candidates\/[^/]+)\.json$/, owner: 'Block Studio import sessions: ownerId in the manifest; others read not found' },
];

const servers: Server[] = [];
let projectRoot = '';
let base = '';
/** The same project served by a host that names no one (no resolvePrincipal). */
let nobodyBase = '';
const ids: Record<string, string> = {};

const call = async (person: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${person === 'nobody' ? nobodyBase : base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-person': person },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, text, body: parsed };
};

/** A governed answer that repeats the question, so the canary is in the answer, its artifact and its rows. */
const answerExecutor = ((input: { request: { question: string } }) => ({
  summary: `Answer to ${input.request.question}`,
  answer: `Answer to ${input.request.question}`,
  status: 'completed',
  trustState: 'governed',
  stopReason: 'answered',
  artifacts: [{ id: 'answer-1', kind: 'answer', title: 'Answer from Metrics', trustState: 'governed', payload: { text: input.request.question, result: { columns: ['q'], rows: [{ q: input.request.question }], rowCount: 1 } } }],
  evaluations: [],
  nextActions: [],
})) as unknown as NonNullable<AgentRunExecutors['generated_answer']>;

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-person-isolation-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'isolation' }));
  mkdirSync(join(projectRoot, 'notebooks'), { recursive: true });
  writeFileSync(join(projectRoot, 'notebooks', 'claims.dqlnb'), JSON.stringify({ version: 1, title: 'Claims', cells: [] }));
  mkdirSync(join(projectRoot, 'apps', 'claims', 'dashboards'), { recursive: true });
  writeFileSync(join(projectRoot, 'apps', 'claims', 'dql.app.json'), JSON.stringify({
    version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft',
    owners: ['t@example.com'], homepage: { type: 'dashboard', id: 'overview' },
  }));
  writeFileSync(join(projectRoot, 'apps', 'claims', 'dashboards', 'overview.dqld'), JSON.stringify({
    version: 1, id: 'overview', metadata: { title: 'Overview' }, layout: { kind: 'grid', cols: 12, rowHeight: 40, items: [] },
  }));
  const people: Record<string, DqlPrincipal> = { priya, dan };
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    agentRunExecutors: { conversation: answerExecutor, generated_answer: answerExecutor, semantic_answer: answerExecutor, certified_answer: answerExecutor },
    hostHooks: { resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null },
    captureServer: (created) => { servers.push(created); },
  });
  base = `http://127.0.0.1:${port}`;

  // Everything Priya keeps of hers, each with the canary.
  const thread = await call('priya', 'POST', '/api/agent/threads', { title: `Thread ${CANARY}`, surface: 'ask' });
  ids.thread = thread.body?.thread?.id;
  const asked = await call('priya', 'POST', '/api/agent-runs', { question: `How many claims ${CANARY}?`, threadId: ids.thread });
  expect(asked.status, asked.text.slice(0, 300)).toBeLessThan(300);
  ids.run = asked.body?.run?.id;
  expect((await call('priya', 'POST', '/api/agent/memory', { scope: 'user', title: `Note ${CANARY}`, content: `Remember ${CANARY}` })).status).toBeLessThan(300);
  const research = await call('priya', 'POST', '/api/notebook/research', { notebookPath: 'notebooks/claims.dqlnb', question: `Why ${CANARY}?` });
  ids.research = research.body?.run?.id;
  const memo = await call('priya', 'POST', '/api/apps/claims/investigations', { question: `Why did claims change ${CANARY}?`, run: false });
  ids.memo = memo.body?.investigation?.id;
  const talk = await call('priya', 'POST', '/api/apps/claims/conversations', { title: `Talk ${CANARY}`, messages: [{ role: 'user', content: CANARY }] });
  ids.appConversation = talk.body?.conversation?.id;
  // A notebook cell run (its SQL and cell name are hers).
  await call('priya', 'POST', '/api/query', { sql: `SELECT '${CANARY}' AS c`, executionContext: { notebookPath: 'notebooks/claims.dqlnb', cellId: 'c1', cellName: `cell ${CANARY}` } });
  const imported = await call('priya', 'POST', '/api/block-studio/imports', { inputMode: 'paste', sources: [{ path: 'claims.sql', content: `SELECT '${CANARY}' AS c` }] });
  expect(imported.status, imported.text.slice(0, 300)).toBe(200);
  ids.importSession = imported.body?.id;
  const pin = await call('priya', 'POST', '/api/apps/claims/ai-pins', { dashboardId: 'overview', title: 'Open claims', answer: `Pinned ${CANARY}`, result: { columns: ['q'], rows: [{ q: CANARY }] } });
  ids.pin = pin.body?.pin?.id;
  expect((await call('priya', 'PUT', '/api/run-snapshot', { path: 'notebooks/claims.dqlnb', snapshot: { cells: [{ result: CANARY }] } })).status).toBe(200);
  for (const [name, id] of Object.entries(ids)) expect(id, name).toBeTruthy();
  const nobodyPort = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    agentRunExecutors: { conversation: answerExecutor, generated_answer: answerExecutor },
    hostHooks: {},
    captureServer: (created) => { servers.push(created); },
  });
  nobodyBase = `http://127.0.0.1:${nobodyPort}`;
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

/** Every route that lists or opens a person's own content. `:id` routes take the id of Priya's record. */
const PER_PERSON: Array<{ route: string; byId?: keyof typeof ids; method?: 'GET' | 'POST' }> = [
  { route: '/api/agent-runs' },
  { route: '/api/agent-runs/:id', byId: 'run' },
  { route: '/api/agent-runs/:id/thread', byId: 'run' },
  { route: '/api/host/answers/:id', byId: 'run' },
  { route: '/api/ask-traces' },
  { route: '/api/ask-traces/by-run/:id', byId: 'run' },
  { route: '/api/operations' },
  { route: '/api/agent/threads' },
  { route: `/api/agent/threads/search?q=${CANARY}` },
  { route: '/api/agent/threads/:id', byId: 'thread' },
  { route: '/api/agent/memory' },
  { route: '/api/home' },
  { route: '/api/notebook/research' },
  { route: `/api/notebook/research?q=${CANARY}` },
  { route: '/api/notebook/research/diagnostics' },
  { route: '/api/notebook/research/:id', byId: 'research' },
  { route: '/api/apps/claims' },
  { route: '/api/apps/claims/investigations' },
  { route: '/api/apps/claims/investigations/:id', byId: 'memo' },
  { route: '/api/apps/claims/conversations' },
  { route: '/api/apps/claims/conversations/:id', byId: 'appConversation' },
  { route: '/api/apps/claims/ai-pins' },
  { route: '/api/block-studio/imports' },
  { route: '/api/block-studio/imports/:id', byId: 'importSession' },
  { route: '/api/apps/claims/dashboards/overview/run', method: 'POST' },
  { route: '/api/run-snapshot?path=notebooks%2Fclaims.dqlnb' },
];

describe('with a host, a person\'s own content reaches no one else', () => {
  it('the first person reads their own content back (the canary is there to find)', async () => {
    for (const entry of PER_PERSON.filter((item) => item.byId)) {
      const path = entry.route.replace(':id', encodeURIComponent(ids[entry.byId!]));
      const mine = await call('priya', 'GET', path);
      expect(mine.status, path).toBe(200);
    }
    expect((await call('priya', 'GET', '/api/notebook/research')).text).toContain(CANARY);
  });

  it.each(PER_PERSON.map((entry) => [entry.route, entry] as const))('another person gets nothing of the owner\'s from %s', async (_route, entry) => {
    const path = entry.byId ? entry.route.replace(':id', encodeURIComponent(ids[entry.byId])) : entry.route;
    const answer = await call('dan', entry.method ?? 'GET', path, entry.method === 'POST' ? {} : undefined);
    expect(answer.text, path).not.toContain(CANARY);
    if (entry.byId) expect(answer.status, path).toBe(404);
  });

  it.each(PER_PERSON.map((entry) => [entry.route, entry] as const))('a host that names no one gets nothing of the owner\'s from %s', async (_route, entry) => {
    const path = entry.byId ? entry.route.replace(':id', encodeURIComponent(ids[entry.byId])) : entry.route;
    const answer = await call('nobody', entry.method ?? 'GET', path, entry.method === 'POST' ? {} : undefined);
    expect(answer.text, path).not.toContain(CANARY);
    if (entry.byId) expect([403, 404], path).toContain(answer.status);
  });

  it('the same request identity from the second person is their own submission, never a reply about the first person\'s run', async () => {
    const key = `key-${CANARY}`;
    const ask = async (person: string, question: string) => {
      const response = await fetch(`${base}/api/agent-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-person': person, 'Idempotency-Key': key }, body: JSON.stringify({ question }) });
      return { status: response.status, text: await response.text() };
    };
    const hers = await ask('priya', `Claims paid ${CANARY}?`);
    expect(hers.status).toBeLessThan(300);
    const herRun = JSON.parse(hers.text).run.id as string;
    // Her replay is hers; Dan with the same key and another question starts his own run (no conflict naming hers).
    expect(JSON.parse((await ask('priya', `Claims paid ${CANARY}?`)).text)).toMatchObject({ replayed: true });
    const his = await ask('dan', 'Claims paid last week?');
    expect(his.status, his.text.slice(0, 200)).toBeLessThan(300);
    expect(his.text).not.toContain(herRun);
    expect(his.text).not.toContain(CANARY);
    const same = await ask('dan', `Claims paid ${CANARY}?`);
    expect(same.text).not.toContain(herRun);
  });

  it('a page of the second person\'s traces never names one of the first person\'s, in its traces or its cursor', async () => {
    expect((await call('dan', 'POST', '/api/agent-runs', { question: 'How many open claims?' })).status).toBeLessThan(300);
    expect((await call('priya', 'POST', '/api/agent-runs', { question: `And by region ${CANARY}?` })).status).toBeLessThan(300);
    const priyas = new Set(((await call('priya', 'GET', '/api/ask-traces?limit=100')).body?.traces ?? []).map((trace: { traceId: string }) => trace.traceId));
    expect(priyas.size).toBeGreaterThan(0);
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const listed = await call('dan', 'GET', `/api/ask-traces?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(listed.status).toBe(200);
      for (const trace of listed.body.traces as Array<{ traceId: string }>) expect(priyas.has(trace.traceId)).toBe(false);
      cursor = listed.body.nextCursor;
      if (!cursor) break;
      const named = Buffer.from(cursor, 'base64url').toString('utf8').split('\u0000')[1];
      expect(priyas.has(named), 'a cursor names one of Priya\'s traces').toBe(false);
    }
  });

  it('every file that holds her content is a registered per-person store', () => {
    const holders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stats = statSync(full);
        if (stats.isDirectory()) walk(full);
        else if (stats.size < 64 * 1024 * 1024 && readFileSync(full).includes(CANARY)) holders.push(relative(projectRoot, full).split(sep).join('/'));
      }
    };
    walk(projectRoot);
    const unregistered = holders.filter((file) => !STORES.some((store) => store.path.test(file)));
    expect(unregistered, `stores holding a person's content that are not registered with an owner filter: ${unregistered.join(', ')}`).toEqual([]);
  });
});
