#!/usr/bin/env node
// THE ONBOARDING LARGE TEST (onboarding design "pick your data, fast first, details later", P8).
//
// Drives a running ZLens through the two-stage setup and measures what the design's "Done means" asks:
//   - time to Ready (names read) for the scope given, and the discovery (sizes) before it;
//   - the longest gap between two updates of the counts while a stage runs (target: 3 s);
//   - how long Stop takes to stop the background checks (target: 5 s);
//   - that a resume repeats no finished statement (the kept answers in .dql/local/setup-checks.jsonl);
//   - how long the checks take in all, how many tables were checked on samples, what was not checked.
//
//   node scripts/onboarding-large-test.mjs --url http://127.0.0.1:3474 --project <project dir> \
//     --scopes 'DB:SCHEMA_A,SCHEMA_B;OTHER_DB:SCHEMA_C' [--connection default] [--stop-after 20] \
//     [--header 'Sf-Context-Current-User: NAME'] [--out result.json] [--fresh]
//
// --fresh forgets the answers kept from an earlier run on this catalog (it needs --project), so the checks
// ask the warehouse everything and the resume measured below starts from nothing kept.
//
// It reads nothing of the data itself and needs no credentials: ZLens's own connection does the reading. Any
// warehouse works (Snowflake, DuckDB, PostgreSQL). It starts the setup afresh on the scope given.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const base = (arg('url', 'http://127.0.0.1:3474')).replace(/\/$/, '');
const project = arg('project');
const connectionId = arg('connection', 'default');
const stopAfterSeconds = Number(arg('stop-after', '20'));
const out = arg('out');
const header = arg('header');
const scopes = (arg('scopes') ?? '').split(';').filter(Boolean).map((part) => {
  const [catalogOrDatabase, schemas] = part.split(':');
  return { catalogOrDatabase: catalogOrDatabase.trim(), schemas: schemas.split(',').map((schema) => schema.trim()).filter(Boolean) };
});
if (scopes.length === 0) {
  console.error("Give --scopes 'DB:SCHEMA_A,SCHEMA_B;OTHER_DB:SCHEMA_C'.");
  process.exit(2);
}
const headers = { 'Content-Type': 'application/json', ...(header ? { [header.split(':')[0].trim()]: header.split(':').slice(1).join(':').trim() } : {}) };
const call = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok && response.status !== 202) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return body;
};
const status = () => call(`/api/connections/${encodeURIComponent(connectionId)}/setup`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => Math.round(ms / 100) / 10;

/** Polls every 250 ms until `done`, and records the longest gap between two updates of the running operation. */
async function follow(done, limitMs) {
  const started = Date.now();
  let lastUpdate;
  let lastChange = Date.now();
  let maxGapMs = 0;
  let last;
  let failedPolls = 0;
  for (;;) {
    // A poll that fails (ZLens busy for a moment) is counted and tried again, never fatal.
    try {
      last = await status();
    } catch {
      failedPolls += 1;
      if (failedPolls > 40) throw new Error('ZLens stopped answering');
      await sleep(500);
      continue;
    }
    const operation = last.operation;
    if (operation && (operation.status === 'running' || operation.status === 'queued')) {
      if (operation.updatedAt !== lastUpdate) {
        if (lastUpdate !== undefined) maxGapMs = Math.max(maxGapMs, Date.now() - lastChange);
        lastUpdate = operation.updatedAt;
        lastChange = Date.now();
      }
    }
    if (done(last)) return { status: last, ms: Date.now() - started, maxGapMs, failedPolls };
    if (Date.now() - started > limitMs) throw new Error(`still ${last.stage} after ${seconds(limitMs)} s`);
    await sleep(250);
  }
}

function keptAnswers() {
  if (!project) return undefined;
  const file = join(project, '.dql', 'local', 'setup-checks.jsonl');
  if (!existsSync(file)) return { lines: 0, repeated: 0 };
  const keys = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } }).filter((line) => line.key).map((line) => line.key);
  return { lines: keys.length, repeated: keys.length - new Set(keys).size };
}

if (process.argv.includes('--fresh')) {
  if (!project) {
    console.error('--fresh needs --project.');
    process.exit(2);
  }
  rmSync(join(project, '.dql', 'local', 'setup-checks.jsonl'), { force: true });
}
const result = { url: base, scopes, startedAt: new Date().toISOString() };
const discoveryStarted = Date.now();
const discovery = await call(`/api/connections/${encodeURIComponent(connectionId)}/metadata-scope/discovery`, { method: 'POST', body: '{}' });
result.discoveryMs = Date.now() - discoveryStarted;
const chosen = discovery.scopes.flatMap((scope) => scope.schemas
  .filter((schema) => scopes.some((wanted) => wanted.catalogOrDatabase.toLowerCase() === scope.catalogOrDatabase.toLowerCase() && wanted.schemas.some((name) => name.toLowerCase() === schema.name.toLowerCase())))
  .map((schema) => schema.size));
result.sized = { schemas: chosen.length, tables: chosen.reduce((sum, size) => sum + (size?.tables ?? 0), 0), rows: chosen.reduce((sum, size) => sum + (size?.rows ?? 0), 0), largeTables: chosen.reduce((sum, size) => sum + (size?.largeTables ?? 0), 0) };
console.log(`Discovery with sizes: ${seconds(result.discoveryMs)} s; chosen ${result.sized.schemas} schemas, ${result.sized.tables} tables, ${result.sized.rows} rows, ${result.sized.largeTables} over the row budget.`);

// Stage 1: read names; time to Ready.
const readStarted = Date.now();
await call(`/api/connections/${encodeURIComponent(connectionId)}/setup/read`, { method: 'POST', body: JSON.stringify({ mode: 'selected_scopes', scopes, check: true, tablesExpected: result.sized.tables }) });
const ready = await follow((value) => value.stage !== 'reading', 30 * 60_000);
result.readyMs = Date.now() - readStarted;
result.readMaxGapMs = ready.maxGapMs;
result.relationsRead = ready.status.setup?.read?.relations;
if (ready.status.stage === 'failed') throw new Error(`the read failed: ${ready.status.setup?.read?.error}`);
console.log(`Ready to ask: ${seconds(result.readyMs)} s for ${result.relationsRead} tables (longest gap between updates ${seconds(ready.maxGapMs)} s).`);

// Stage 2: the checks start by themselves; stop them part way.
await follow((value) => value.stage === 'checking' && value.operation?.type === 'warehouse-check', 60_000);
await sleep(stopAfterSeconds * 1000);
let beforeStop = await status();
for (let tries = 0; tries < 20 && !beforeStop.operation && beforeStop.setup?.checks?.state === 'running'; tries += 1) {
  await sleep(250);
  beforeStop = await status();
}
if (!beforeStop.operation) {
  result.finishedBeforeStop = true;
  console.log(`The checks finished within ${stopAfterSeconds} s: nothing to stop. Run again with a smaller --stop-after.`);
} else {
  result.checkedBeforeStop = beforeStop.operation.detail?.checks;
  const stopStarted = Date.now();
  await call(`/api/operations/${encodeURIComponent(beforeStop.operation.id)}`, { method: 'DELETE' });
  await follow((value) => value.setup?.checks?.state === 'stopped' || value.setup?.checks?.state === 'done', 60_000);
  result.stopMs = Date.now() - stopStarted;
  result.keptAfterStop = keptAnswers();
  console.log(`Stop: stopped in ${seconds(result.stopMs)} s after ${stopAfterSeconds} s of checks (${JSON.stringify(result.checkedBeforeStop)}); kept ${result.keptAfterStop?.lines ?? '?'} answers.`);
}

// Resume: nothing answered before is asked again.
const resumeStarted = Date.now();
await call(`/api/connections/${encodeURIComponent(connectionId)}/setup/check`, { method: 'POST', body: '{}' });
const checked = await follow((value) => value.stage === 'checked' || value.stage === 'ready' && value.setup?.checks?.state !== 'running', 6 * 60 * 60_000);
result.resumeToDoneMs = Date.now() - resumeStarted;
result.checkMaxGapMs = checked.maxGapMs;
result.checkFailedPolls = checked.failedPolls;
const checks = checked.status.setup?.checks ?? {};
result.checks = { state: checks.state, resumed: checks.resumed, sampled: checks.sampled, drafted: checks.drafted, problems: (checks.problems ?? []).length, problemKinds: Object.fromEntries(Object.entries((checks.problems ?? []).reduce((counts, problem) => ({ ...counts, [problem.kind]: (counts[problem.kind] ?? 0) + 1 }), {}))) };
result.keptAfterResume = keptAnswers();
console.log(`Resume to done: ${seconds(result.resumeToDoneMs)} s; ${checks.resumed ?? 0} statements answered before were not asked again; repeated statements: ${result.keptAfterResume?.repeated ?? '?'}; ${checks.sampled ?? 0} tables on samples; ${result.checks.problems} not checked; ${checks.drafted ?? 0} models drafted (longest gap ${seconds(checked.maxGapMs)} s).`);
result.finishedAt = new Date().toISOString();
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
