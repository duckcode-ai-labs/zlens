import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalResultBindingValue, canonicalResultRowFingerprint, memberOptionId } from '@zlens/agent';
import { startLocalServer } from '../local-runtime.js';
import { createSeededSqliteExecutor, type GoldenSeed } from '../testkit/seeded-sqlite-executor.js';
import type { DqlModelProvider, DqlPrincipal } from './request-context.js';
import { RECEIPT_V9_FIELDS, rowCountBucket } from './trace-review.js';
import { readEnv } from '@zlens/core';

/**
 * A STEWARD READING SOMEONE ELSE'S ASK TRACE, ON THE REAL ASK PIPELINE (RFC 0010). The jaffle-golden fixture on its
 * seeded engine, with a scripted model (the host's model hook) that reads each question as a person's model would and
 * writes SQL when asked. Wes asks; Sam (who reviews answers, `hint.review`) opens
 * each of Wes's traces by run and by id. The oracle is the warehouse itself: every customer, location, product and
 * supply name in the seed, and every distinctive value in Wes's own rows. None may appear anywhere in what Sam reads,
 * while Wes's own runs carry them (the positive control).
 *
 * Scenarios: a member grounded in the warehouse ("ryan byrd" stored as "Ryan Byrd"), two members with one name and
 * the person's choice of one (member selection), a misspelt member the warehouse holds no match for, AI-written SQL
 * with a literal and a follow-up bound to one of its rows, and a chat reply that restates figures. A Research run's
 * report and story are covered in steward-trace-values.test.ts (a Research run needs many model calls to script).
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../test/fixtures/jaffle-golden');
const seed = JSON.parse(readFileSync(join(fixtureDir, 'seeds', 'seed.json'), 'utf8')) as GoldenSeed;

const wes: DqlPrincipal = { id: 'u-wes', kind: 'person', email: 'wes@example.test', source: 'host' };
const sam: DqlPrincipal = { id: 'u-sam', kind: 'person', email: 'sam@example.test', source: 'host' };
const people: Record<string, DqlPrincipal> = { wes, sam };

const servers: Server[] = [];
let base = '';

/** Names in the warehouse that only results or groundings carry (the metric and table names are not among them). */
function seedNames(): string[] {
  const tables = (seed as unknown as { tables: Record<string, { rows: Array<Record<string, unknown>> }> }).tables;
  const out = new Set<string>();
  for (const [table, column] of [['dev.customers', 'customer_name'], ['dev.locations', 'location_name'], ['dev.products', 'product_name'], ['dev.supplies', 'supply_name']] as const) {
    for (const row of tables[table]?.rows ?? []) if (typeof row[column] === 'string' && (row[column] as string).length >= 5) out.add(row[column] as string);
  }
  return [...out];
}

/** Distinctive values of a run's rows: strings of 5+ characters, numbers with decimals or of 4+ digits. */
function rowValues(run: any): string[] {
  const out = new Set<string>();
  for (const artifact of run?.artifacts ?? []) {
    for (const row of artifact?.payload?.result?.rows ?? []) {
      for (const value of Object.values(row ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Math.abs(value) >= 1000)) out.add(String(value));
        else if (typeof value === 'string' && value.length >= 5 && !/^\d{4}-\d{2}-\d{2}/.test(value)) out.add(value);
      }
    }
  }
  return [...out];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The values a text holds, each as a whole token (a number inside a hex hash is not that number). */
const leaksIn = (text: string, values: string[]) => values.filter((value) => [value, JSON.stringify(value).slice(1, -1)].some((form) => new RegExp(`(?<![0-9A-Za-z])${escapeRegExp(form)}(?![0-9A-Za-z])`, 'i').test(text)));

const call = async (person: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-person': person },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, text, body: parsed };
};
const ask = async (question: string, extra: Record<string, unknown> = {}) => (await call('wes', 'POST', '/api/agent-runs', { question, requestedMode: 'ask', ...extra })).body?.run;

const NAME = { ref: 'dimension:customers.customer_name', op: 'eq', source: 'question' } as const;
const intent = (fields: Record<string, unknown>) => JSON.stringify({ version: 1, kind: 'analytics', reading: 'as asked', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {}, ...fields });
/** How the scripted model reads each question (the last QUESTION: line of the prompt). */
const READINGS: Record<string, string> = {
  'what is the total revenue for ryan byrd': intent({ measures: [{ ref: 'metric:orders.order_total' }], filters: [{ ...NAME, values: ['ryan byrd'] }] }),
  'what is the total revenue for jordan lee': intent({ measures: [{ ref: 'metric:orders.order_total' }], filters: [{ ...NAME, values: ['jordan lee'] }] }),
  'total revenue for byrd': intent({ measures: [{ ref: 'metric:orders.order_total' }], filters: [{ ...NAME, values: ['byrd'] }] }),
  'total revenue for son': intent({ measures: [{ ref: 'metric:orders.order_total' }], filters: [{ ...NAME, values: ['son'] }] }),
  'what is the total revenue for jordan': intent({ measures: [{ ref: 'metric:orders.order_total' }], filters: [{ ...NAME, values: ['jordan'] }] }),
  'what is the total revenue for that customer': intent({ measures: [{ ref: 'metric:orders.order_total' }], filters: [{ ...NAME, values: ['that customer'] }] }),
  'top customers by order total at the philadelphia shop': intent({
    measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:locations.location_name', op: 'eq', values: ['philadelphia shop'], source: 'question' }] }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
  }),
  'top customers by order total at the philadelphia shop side by side': intent({
    measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:locations.location_name', op: 'eq', values: ['philadelphia shop'], source: 'question' }] }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
  }),
  'top customers by order total at the philadelphia shop through a cte': intent({
    measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:locations.location_name', op: 'eq', values: ['philadelphia shop'], source: 'question' }] }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
  }),
  'top customers by order total at the philadelphia shop through a subquery': intent({
    measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:locations.location_name', op: 'eq', values: ['philadelphia shop'], source: 'question' }] }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
  }),
  'top customers by order total at the philadelphia shop without as': intent({
    measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:locations.location_name', op: 'eq', values: ['philadelphia shop'], source: 'question' }] }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
  }),
  'top customers by order total at the philadelphia shop in brackets': intent({
    measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:locations.location_name', op: 'eq', values: ['philadelphia shop'], source: 'question' }] }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
  }),
  'top customers by order total at the philadelphia shop with an apostrophe': intent({
    measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:locations.location_name', op: 'eq', values: ['philadelphia shop'], source: 'question' }] }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
  }),
  'top customers by order total at the philadelphia shop with a comma': intent({
    measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:locations.location_name', op: 'eq', values: ['philadelphia shop'], source: 'question' }] }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
  }),
  'top customers by order total at the philadelphia shop in another script': intent({
    measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:locations.location_name', op: 'eq', values: ['philadelphia shop'], source: 'question' }] }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5, expectedShape: 'ranking',
  }),
  'hi': JSON.stringify({ version: 1, kind: 'conversation', reading: 'a greeting', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {}, reply: 'Hello! Last time Brittany Johnson led with 1223 in lifetime spend; ask me anything.' }),
};
const SQL = `SELECT c.customer_name, SUM(o.order_total) AS order_total FROM "jaffle_shop"."dev"."orders" o JOIN "jaffle_shop"."dev"."customers" c ON o.customer_id = c.customer_id JOIN "jaffle_shop"."dev"."locations" l ON o.location_id = l.location_id WHERE l.location_name = 'Philadelphia' GROUP BY c.customer_name ORDER BY order_total DESC LIMIT 5`;
/** Columns named after a shop (a value), one of them quoted. */
const PIVOT_SQL = `SELECT c.customer_name, SUM(o.order_total) AS Philadelphia, COUNT(o.order_id) AS "Brooklyn" FROM "jaffle_shop"."dev"."orders" o JOIN "jaffle_shop"."dev"."customers" c ON o.customer_id = c.customer_id WHERE o.location_id IN (SELECT location_id FROM "jaffle_shop"."dev"."locations" WHERE location_name = 'Philadelphia') GROUP BY c.customer_name ORDER BY 2 DESC LIMIT 5`;
const FROM_PHILADELPHIA = `FROM "jaffle_shop"."dev"."orders" o JOIN "jaffle_shop"."dev"."customers" c ON o.customer_id = c.customer_id WHERE o.location_id IN (SELECT location_id FROM "jaffle_shop"."dev"."locations" WHERE location_name = 'Philadelphia') GROUP BY c.customer_name`;
/** AI-written statements that name a column after a shop (a value: Chicago) in the ways a reviewer's renaming must catch. */
const NAMED_SQL: Record<string, string> = {
  'through a cte': `WITH p AS (SELECT c.customer_name, SUM(o.order_total) AS Chicago ${FROM_PHILADELPHIA}) SELECT p.customer_name, p.Chicago FROM p ORDER BY p.Chicago DESC LIMIT 5`,
  'through a subquery': `SELECT s.customer_name, s.Chicago FROM (SELECT c.customer_name, SUM(o.order_total) AS Chicago ${FROM_PHILADELPHIA}) s ORDER BY s.Chicago DESC LIMIT 5`,
  'without as': `SELECT c.customer_name, SUM(o.order_total) Chicago ${FROM_PHILADELPHIA} ORDER BY 2 DESC LIMIT 5`,
  'in brackets': `SELECT c.customer_name, SUM(o.order_total) AS [Chicago] ${FROM_PHILADELPHIA} ORDER BY 2 DESC LIMIT 5`,
  'with an apostrophe': `SELECT c.customer_name, SUM(o.order_total) AS "Chicago's" ${FROM_PHILADELPHIA} ORDER BY 2 DESC LIMIT 5`,
  'with a comma': `SELECT c.customer_name, SUM(o.order_total) AS "Chicago, IL" ${FROM_PHILADELPHIA} ORDER BY 2 DESC LIMIT 5`,
  'in another script': `SELECT c.customer_name, SUM(o.order_total) AS Chicagö ${FROM_PHILADELPHIA} ORDER BY 2 DESC LIMIT 5`,
};
const model = {
  name: 'scripted',
  available: async () => true,
  generate: async (messages: Array<{ role: string; content: string }>) => {
    const prompt = messages.map((message) => message.content).join('\n');
    const question = [...prompt.matchAll(/QUESTION:\s*(.+)$/gm)].at(-1)?.[1]?.trim().toLowerCase().replace(/^"|"$/g, '') ?? '';
    if (prompt.includes('JSON AnalyticalIntent')) return READINGS[question] ?? intent({ unresolved: [{ clause: question, options: [], material: true }] });
    if (prompt.includes('You write exactly ONE read-only SQL statement')) return Object.entries(NAMED_SQL).find(([marker]) => question.includes(marker))?.[1] ?? (prompt.includes('side by side') ? PIVOT_SQL : SQL);
    return 'Brittany Johnson leads with 1223.';
  },
} as unknown as DqlModelProvider;

const roots: string[] = [];
/** A hosted server on the fixture; `driver` is the dialect Ask writes and the reviewer's SQL is read as (the engine stays the seeded one). */
async function startServer(driver: 'sqlite' | 'duckdb'): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-trace-review-'));
  roots.push(projectRoot);
  cpSync(fixtureDir, projectRoot, { recursive: true });
  rmSync(join(projectRoot, '.dql'), { recursive: true, force: true });
  rmSync(join(projectRoot, 'test-cassettes'), { recursive: true, force: true });
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor: createSeededSqliteExecutor(seed), connection: { driver, filepath: ':memory:' }, preferredPort: 0,
    hostHooks: {
      resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
      authorize: (principal, action) => ({ allow: action !== 'hint.review' || principal.id === sam.id, reason: 'Only a steward may review.' }),
      modelProvider: () => ({ id: 'bedrock', provider: model }),
      isInBoundary: () => true,
    },
    captureServer: (created) => { servers.push(created); },
  });
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  if (!readEnv('ZLENS_METRICFLOW_BIN')) process.env.ZLENS_METRICFLOW_BIN = join(tmpdir(), 'dql-trace-review-no-metricflow', 'mf');
  base = await startServer('sqlite');
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const projectRoot of roots.splice(0)) rmSync(projectRoot, { recursive: true, force: true });
});

/** Sam reads Wes's run's trace by run and by id; Wes's own run (with its receipt) is the control. */
async function readAsSteward(run: any): Promise<{ texts: string[]; own: string; bodies: any[] }> {
  expect(run?.id, 'Wes\'s run').toBeTruthy();
  const listed = (await call('sam', 'GET', '/api/ask-traces?limit=100')).body?.traces ?? [];
  const traceId = listed.find((trace: { runId: string }) => trace.runId === run.id)?.traceId as string | undefined;
  expect(traceId, 'Sam lists Wes\'s trace').toBeTruthy();
  const byRun = await call('sam', 'GET', `/api/ask-traces/by-run/${encodeURIComponent(run.id)}`);
  const byId = await call('sam', 'GET', `/api/ask-traces/${traceId}`);
  expect(byRun.status).toBe(200);
  expect(byId.status).toBe(200);
  expect(byRun.body?.valuesWithheld).toBe(true);
  for (const field of ['runtimeReceiptV5', 'runtimeReceiptV6', 'runtimeReceiptV8', 'runtimeDecisionSummary']) expect(byRun.body?.[field], field).toBeUndefined();
  return { texts: [byRun.text, byId.text, JSON.stringify(listed)], own: JSON.stringify(run), bodies: [byRun.body, byId.body] };
}

const names = seedNames();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Every [key, value] whose key names a fingerprint, anywhere in a body. */
function fingerprints(value: unknown, key = ''): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap((item) => fingerprints(item, key));
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([name, item]) => fingerprints(item, name));
  return /fingerprint$/i.test(key) ? [[key, value]] : [];
}

/** The sha256 of each thing a reader could guess: each value, each statement Wes's run ran (alone, with parameters), its rows. */
function guessDigests(run: any, values: string[]): string[] {
  const inputs: string[] = [...values];
  for (const artifact of run?.artifacts ?? []) {
    const payload = artifact?.payload ?? {};
    const result = payload.result ?? {};
    for (const sql of [payload.sql, result.sql, payload.dqlArtifact?.compiledSql].filter((item) => typeof item === 'string')) {
      inputs.push(sql, `${sql}\n${JSON.stringify(payload.sqlParams ?? [])}`, `${sql}\n[]`, sql.trim(), sql.replace(/\s+/g, ' ').trim());
    }
    if (Array.isArray(result.rows)) {
      inputs.push(JSON.stringify(result.rows), JSON.stringify({ columns: result.columns, rows: result.rows }));
      for (const row of result.rows) inputs.push(JSON.stringify(row), ...Object.values(row ?? {}).map(String));
    }
  }
  for (const option of JSON.stringify(run ?? {}).match(/member:[^"\\]+=\[[^\]]*\]/g) ?? []) inputs.push(option.replace(/\\"/g, '"'));
  return inputs.map(sha);
}
const sweep = async (label: string, run: any, control = true) => {
  const { texts, own, bodies } = await readAsSteward(run);
  const values = [...names, ...rowValues(run)];
  // Every field of the real receipt is classified (kept, reduced or dropped): a new field fails here until it is.
  for (const key of Object.keys(run?.diagnosticReceiptV9 ?? {})) expect(Object.keys(RECEIPT_V9_FIELDS), `${label}: receipt field ${key} is classified in trace-review.ts`).toContain(key);
  // Positive control: Wes's own run (receipts and rows) carries warehouse values, so a clean read by Sam means something.
  if (control) expect(leaksIn(own, values).length, `${label}: Wes's own run carries warehouse values`).toBeGreaterThan(0);
  // Times the review keeps by design (a step's `durationMs`, `…Ms` budgets, `at` instants) are clock readings, not
  // warehouse values: a step that took 1,225 ms beside a row value of 1225 is not a leak (CI, node 24, 2026-11-08).
  const withoutTimes = (text: string) => text.replace(/(\\?")(\w*Ms|at)\1\s*:\s*-?\d+(?:\.\d+)?/g, '$1$2$1:0');
  const found = texts.flatMap((text) => leaksIn(withoutTimes(text), values));
  // No hash a guess could be tested against: no bare sha256, every fingerprint keyed to this trace, and no hex in what Sam
  // reads is (a piece of) the sha256 of a value, of the statement as it ran (with or without its parameters), or of rows.
  const joined = texts.join('\n');
  expect(joined.match(/sha256:[0-9a-f]+/g) ?? [], `${label}: unkeyed hashes`).toEqual([]);
  for (const body of bodies) for (const [key, value] of fingerprints(body)) expect(value, `${label}: ${key}`).toMatch(/^hmac:[0-9a-f]{32}$/);
  const digests = guessDigests(run, values);
  const hexes = [...new Set(joined.match(/[0-9a-f]{12,}/g) ?? [])];
  const confirmed = hexes.filter((hex) => digests.some((digest) => digest.includes(hex.slice(0, 12)) || digest.includes(hex.slice(-12))));
  expect(confirmed, `${label}: hashes of values, SQL or rows`).toEqual([]);
  // A range, never the exact row count.
  for (const body of bodies) {
    expect(JSON.stringify(body), `${label}: an exact row count`).not.toMatch(/"rowCount"\s*:/);
    const answer = body?.runtimeAnswerV1;
    const rows = (run?.artifacts ?? []).find((artifact: any) => Array.isArray(artifact?.payload?.result?.rows))?.payload?.result;
    if (answer && rows && typeof rows.rowCount === 'number') expect(answer.rowCountBucket, label).toBe(rowCountBucket(rows.rowCount));
  }
  expect([...new Set(found)], `${label}: values in what Sam reads`).toEqual([]);
};

describe('a steward reading another person\'s trace on the real pipeline: no warehouse value anywhere', () => {
  it('a member grounded in the warehouse ("ryan byrd" read as Ryan Byrd)', async () => {
    await sweep('grounding', await ask('what is the total revenue for ryan byrd'));
  }, 120_000);

  it('two members with one name; a partial name that matches several (a clarification) and the person\'s choice (member selection)', async () => {
    await sweep('two members', await ask('what is the total revenue for jordan lee'));
    const thread = (await call('wes', 'POST', '/api/agent/threads', { surface: 'notebook', title: 'which one' })).body?.thread?.id as string;
    const clarify = await ask('total revenue for son', { threadId: thread });
    await sweep('clarify', clarify);
    // The options the clarification offers are the warehouse's own members; the person picks the first.
    const option = [...JSON.stringify(clarify).matchAll(/"(member:dimension:customers\.customer_name=\[[^\]]*\])"/g)].map((match) => JSON.parse(`"${match[1]}"`) as string)[0];
    expect(option, 'a member option to choose').toBeTruthy();
    // Choosing an option continues the clarification (a link whose choice fingerprint is of the option, a warehouse value).
    await sweep('member selection', await ask('total revenue for son', { selectedEvidenceId: option, threadId: thread }));
  }, 240_000);

  it('a partial name widened to the one member the warehouse holds', async () => {
    await sweep('widened', await ask('total revenue for byrd'));
  }, 120_000);

  it('AI-written SQL with a literal, and a follow-up bound to one of its rows', async () => {
    const first = await ask('top customers by order total at the philadelphia shop');
    await sweep('ai sql', first);
    const artifact = (first.artifacts ?? []).find((item: any) => item?.payload?.result?.rows?.length);
    const row = artifact?.payload?.result?.rows?.[0];
    expect(row, 'a row to bind').toBeTruthy();
    const result = artifact.payload.result;
    const columns = (result.columns ?? []).map((column: any) => (typeof column === 'string' ? column : column.name));
    const resultFingerprint = JSON.stringify(first).match(/"resultFingerprint":"([^"]+)"/)?.[1];
    expect(resultFingerprint, 'the persisted result\'s fingerprint').toBeTruthy();
    const binding = { version: 1, sourceRunId: first.id, sourceArtifactId: artifact.id, canonicalColumn: 'customer_name', value: canonicalResultBindingValue(row.customer_name), rowFingerprint: canonicalResultRowFingerprint({ columns }, row), resultFingerprint };
    // The binding is checked against Wes's persisted result; whatever the reading does with it, Sam sees none of it.
    await sweep('result binding', await ask('what is the total revenue for that customer', { selectedResultBinding: binding, threadId: first.threadId }), false);
  }, 240_000);

  it('AI-written SQL whose columns are named after values (a pivot): renamed column_<n> in the columns and the SQL', async () => {
    const run = await ask('top customers by order total at the philadelphia shop side by side');
    await sweep('pivot', run);
    const { bodies } = await readAsSteward(run);
    const answer = bodies[0]?.runtimeAnswerV1;
    expect(answer?.columns, 'the pivot ran').toBeTruthy();
    expect(answer.columns.some((column: string) => /^column_\d+$/.test(column))).toBe(true);
    expect(answer.sql).not.toMatch(/Philadelphia|Brooklyn/);
  }, 120_000);

  for (const marker of ['through a cte', 'through a subquery', 'without as', 'in brackets']) {
    it(`a column named after a value ${marker}: renamed in the columns and everywhere in the SQL, tables still readable`, async () => {
      const run = await ask(`top customers by order total at the philadelphia shop ${marker}`);
      const ownColumns = (run.artifacts ?? []).map((artifact: any) => artifact?.payload?.result?.columns).find(Array.isArray);
      expect(JSON.stringify(ownColumns), `${marker}: the statement ran and Wes's own result has the column`).toMatch(/Chicago/);
      await sweep(marker, run);
      const { bodies } = await readAsSteward(run);
      const answer = bodies[0]?.runtimeAnswerV1;
      expect(answer.columns.some((column: string) => /^column_\d+$/.test(column)), marker).toBe(true);
      expect(answer.sql, marker).not.toMatch(/Chicago/i);
      // The project's own relations stay readable; nothing is garbled into "?"column_n.
      expect(answer.sql, marker).toContain('"jaffle_shop"."dev"."orders"');
      expect(answer.sql, marker).not.toMatch(/"\?"[A-Za-z_]/);
    }, 120_000);
  }

  it('a chat reply that restates figures', async () => {
    await sweep('chat', await ask('hi'));
  }, 120_000);
});

describe('on a DuckDB connection (`"…"` is a name): quoted and non-ASCII names the project does not use', () => {
  beforeAll(async () => { base = await startServer('duckdb'); }, 120_000);
  const aliases: Record<string, string> = { 'with an apostrophe': "Chicago's", 'with a comma': 'Chicago, IL', 'in another script': 'Chicagö' };
  for (const [marker, alias] of Object.entries(aliases)) {
    it(`a column named ${JSON.stringify(alias)} is renamed in the columns and the SQL`, async () => {
      const run = await ask(`top customers by order total at the philadelphia shop ${marker}`);
      const ownColumns = (run.artifacts ?? []).map((artifact: any) => artifact?.payload?.result?.columns).find(Array.isArray);
      expect(JSON.stringify(ownColumns), `${marker}: the statement ran and Wes's own result has the column`).toContain(JSON.stringify(alias).slice(1, -1));
      await sweep(marker, run);
      const { texts, bodies } = await readAsSteward(run);
      for (const text of texts) expect(text, marker).not.toContain(JSON.stringify(alias).slice(1, -1));
      const answer = bodies[0]?.runtimeAnswerV1;
      expect(answer.columns.some((column: string) => /^column_\d+$/.test(column)), marker).toBe(true);
      expect(answer.sql, marker).toContain('"jaffle_shop"."dev"."orders"');
      // Renamed whole: no piece of the name left beside the new one (`column_1ö`).
      expect(answer.sql, marker).not.toMatch(/(?:column|t)_\d+[\p{L}\p{M}]|[\p{L}\p{M}]column_\d+/u);
      expect(answer.sql, marker).not.toMatch(/[^\x00-\x7f]/);
    }, 120_000);
  }
});
