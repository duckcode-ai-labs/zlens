#!/usr/bin/env node
/**
 * Every MCP tool, end to end, with no model: start the BUILT `zlens mcp` over
 * stdio with the official MCP SDK client, the way Claude Code, Codex, Cursor
 * and Claude Desktop do, and call every tool of both profiles with valid and
 * invalid input. Each call must return the right result, carry the trust label
 * where one applies, fail with a clear message (and MCP `isError`) on bad
 * input, and finish inside a deadline.
 *
 * Default (CI): three lanes on copies of the repo fixtures, each with its own
 * `zlens notebook` runtime on a free port and a seeded DuckDB file:
 *   dbt       jaffle-golden            (the jaffle-shop-duckdb metadata, dbt)
 *   warehouse jaffle-warehouse-golden  (database-only, no dbt)
 *   datasets  app-datasets-pilot       (approved App Datasets)
 * answer_question and build_block_from_prompt need an AI model to answer from
 * a description; here they are checked for the clear no-model result (and the
 * governed-metric draft that needs none). Their model path is checked live.
 *
 * Against a real sample with its workbench already running:
 *   node stdio-e2e.mjs --lane dbt --project /path/jaffle-shop-duckdb --runtime-url http://127.0.0.1:3640
 *   node stdio-e2e.mjs --lane warehouse --project /path/jaffle-shop-warehouse --runtime-url http://127.0.0.1:3641
 *
 * Needs a DuckDB driver for the CI lanes: --connector-root <dir with node_modules/duckdb>
 * (or ZLENS_DUCKDB_CONNECTOR_ROOT); without one it installs duckdb@1.1.3 into a temp dir.
 * Exit code 1 when any check fails. --json <file> writes the per-call results.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dqlToolNamesForSurface } from '@zlens/agent';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const cli = join(repoRoot, 'apps/cli/dist/index.js');
const fixtures = join(repoRoot, 'apps/cli/test/fixtures');
const CALL_TIMEOUT_MS = 90_000;

function parseArgs(argv) {
  const args = { lanes: null, project: null, runtimeUrl: null, connectorRoot: process.env.ZLENS_DUCKDB_CONNECTOR_ROOT ?? null, json: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lane') args.lanes = [...(args.lanes ?? []), argv[++i]];
    else if (a === '--project') args.project = resolve(argv[++i]);
    else if (a === '--runtime-url') args.runtimeUrl = argv[++i];
    else if (a === '--connector-root') args.connectorRoot = resolve(argv[++i]);
    else if (a === '--json') args.json = resolve(argv[++i]);
    else if (a === '--keep') args.keep = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

// ── plumbing ────────────────────────────────────────────────────────────────

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function ensureConnectorRoot(explicit) {
  if (explicit) return explicit;
  const root = mkdtempSync(join(tmpdir(), 'zlens-mcp-e2e-duckdb-'));
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  run('npm', ['--prefix', root, 'install', '--no-save', '--no-package-lock', '--workspaces=false', '--no-audit', '--no-fund', 'duckdb@1.1.3']);
  return root;
}

function prepareProject({ fixture, connectorRoot, seed, seedSchema, seedTwice, warehouseFile, sync, setup }) {
  const work = mkdtempSync(join(tmpdir(), `zlens-mcp-e2e-${fixture}-`));
  const project = join(work, 'project');
  cpSync(join(fixtures, fixture), project, { recursive: true });
  const projectConnectors = join(project, '.dql', 'connectors');
  mkdirSync(projectConnectors, { recursive: true });
  writeFileSync(join(projectConnectors, 'package.json'), '{"private":true}\n');
  symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectors, 'node_modules'), 'dir');
  const database = join(project, warehouseFile);
  const seedArgs = [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--seed', seed, '--out', database];
  run(process.execPath, seedSchema ? [...seedArgs, '--schema', seedSchema] : seedArgs);
  if (seedTwice) run(process.execPath, seedArgs);
  const configPath = join(project, 'dql.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const name = config.defaultConnectionName ?? 'default';
  config.connections = { ...(config.connections ?? {}), [name]: { driver: 'duckdb', filepath: database } };
  if (config.defaultConnection) config.defaultConnection = { driver: 'duckdb', filepath: database };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  setup?.(project);
  if (sync) run(process.execPath, [cli, ...sync, project], { cwd: project });
  return { work, project };
}

async function startWorkbench(project, work, env = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const log = join(work, 'workbench.log');
  const child = spawn(process.execPath, [cli, 'notebook', project, '--port', String(port), '--no-open'], {
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe'],
    // No AI model, whatever this machine has: no API keys and no local Ollama.
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
      OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      ZLENS_DISABLE_VERSION_CHECK: '1',
      ZLENS_METRICFLOW_BIN: join(work, 'no-metricflow', 'mf'),
      ...env,
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        await fetch(`${baseUrl}/api/onboarding/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
        return {
          baseUrl,
          stop: async () => {
            writeFileSync(log, output);
            if (child.exitCode !== null) return;
            child.kill('SIGTERM');
            await new Promise((done) => { const t = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000); child.once('exit', () => { clearTimeout(t); done(); }); });
          },
        };
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGKILL');
  throw new Error(`zlens notebook did not start for ${project}:\n${output.slice(-4000)}`);
}

async function connectMcp(project, runtimeUrl, { profile = 'agentic', env = {} } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', project],
    env: { ...process.env, ZLENS_RUNTIME_URL: runtimeUrl, ZLENS_MCP_TOOL_PROFILE: profile === 'full' ? 'full' : '', ZLENS_DISABLE_VERSION_CHECK: '1', ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'zlens-mcp-e2e', version: '1.0.0' });
  const started = Date.now();
  await client.connect(transport);
  return { client, startMs: Date.now() - started, close: () => client.close() };
}

/** A port that accepts connections and never answers: a stuck runtime. */
async function silentServer() {
  const sockets = new Set();
  const server = createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { for (const socket of sockets) socket.destroy(); server.close(() => r()); }),
  };
}

// ── checks ──────────────────────────────────────────────────────────────────

const results = [];

async function call(lane, mcp, name, args, expectation, { timeoutMs = CALL_TIMEOUT_MS, label } = {}) {
  const started = Date.now();
  let response;
  let thrown;
  try {
    response = await mcp.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  } catch (error) {
    thrown = error;
  }
  const ms = Date.now() - started;
  const text = response?.content?.map((item) => item.text ?? '').join('') ?? '';
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  const outcome = { isError: Boolean(response?.isError), text, body, thrown, ms };
  let failure;
  try {
    failure = expectation(outcome) || undefined;
  } catch (error) {
    failure = `check threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  const entry = { lane, tool: name, case: label ?? (thrown || outcome.isError ? 'invalid' : 'valid'), ms, ok: !failure, failure, isError: outcome.isError, thrown: thrown ? String(thrown.message ?? thrown) : undefined, preview: (text || String(thrown?.message ?? '')).slice(0, 240) };
  results.push(entry);
  process.stdout.write(`${entry.ok ? '✓' : '✗'} [${lane}] ${name} (${entry.case}, ${ms} ms)${failure ? ` — ${failure}\n    ${entry.preview}` : ''}\n`);
  return outcome;
}

function record(lane, tool, label, failure) {
  results.push({ lane, tool, case: label, ms: 0, ok: !failure, failure });
  process.stdout.write(`${failure ? '✗' : '✓'} [${lane}] ${tool} (${label})${failure ? ` — ${failure}` : ''}\n`);
}

const ok = (fn) => (o) => {
  if (o.thrown) return `threw: ${o.thrown.message ?? o.thrown}`;
  if (o.isError) return `isError: ${o.text.slice(0, 200)}`;
  if (!o.body) return 'no JSON body';
  return fn(o.body);
};
/** A clear failure: isError (or a protocol error) and a message containing every fragment. */
const fails = (...fragments) => (o) => {
  const message = o.thrown ? String(o.thrown.message ?? o.thrown) : o.text;
  if (!o.thrown && !o.isError) return `expected an error, got ${o.text.slice(0, 160)}`;
  const missing = fragments.filter((fragment) => !(fragment instanceof RegExp ? fragment.test(message) : message.toLowerCase().includes(String(fragment).toLowerCase())));
  return missing.length ? `error text lacks ${missing.join(', ')}: ${message.slice(0, 200)}` : undefined;
};
const within = (ms, check) => (o) => (o.ms > ms ? `took ${o.ms} ms (limit ${ms})` : check(o));
const expectThat = (condition, message) => (condition ? undefined : message);

// ── lanes ───────────────────────────────────────────────────────────────────

async function profileChecks(lane, project, runtimeUrl) {
  for (const profile of ['agentic', 'full']) {
    const mcp = await connectMcp(project, runtimeUrl, { profile });
    try {
      record(lane, 'initialize', `${profile} start`, expectThat(mcp.startMs < 20_000, `server took ${mcp.startMs} ms to start`));
      const info = mcp.client.getServerVersion();
      record(lane, 'initialize', `${profile} server info`, expectThat(info?.title === 'ZLens' && info?.version && info.version !== '0.1.0', `serverInfo ${JSON.stringify(info)}`));
      const instructions = mcp.client.getInstructions() ?? '';
      const listed = (await mcp.client.listTools()).tools;
      const names = listed.map((tool) => tool.name);
      const expected = dqlToolNamesForSurface(profile === 'full' ? 'mcp' : 'mcp_agentic');
      record(lane, 'tools/list', profile, expectThat(JSON.stringify(names) === JSON.stringify(expected), `listed ${names.join(',')} expected ${expected.join(',')}`));
      const bad = listed.filter((tool) => !tool.description || !tool.inputSchema || tool.inputSchema.type !== 'object' || !tool.annotations || typeof tool.annotations.readOnlyHint !== 'boolean' || !tool.title);
      record(lane, 'tools/list', `${profile} descriptions+annotations`, expectThat(bad.length === 0, `missing description/schema/annotations/title: ${bad.map((tool) => tool.name).join(', ')}`));
      const mentioned = [...instructions.matchAll(/`([a-z][a-z0-9_]+)`/g)].map((match) => match[1]).filter((word) => /_/.test(word) && (expected.includes(word) || dqlToolNamesForSurface('mcp').includes(word)));
      const unserved = mentioned.filter((name) => !names.includes(name));
      record(lane, 'instructions', profile, expectThat(unserved.length === 0, `instructions name tools this profile does not serve: ${[...new Set(unserved)].join(', ')}`));
      // Claude Desktop reads only these instructions: ask_dql comes before the semantic layer.
      const askFirst = instructions.indexOf('1. Call `ask_dql` first');
      record(lane, 'instructions', `${profile} ask_dql first`, expectThat(askFirst > -1 && askFirst < instructions.indexOf('`query_semantic_model`'), 'instructions must route through ask_dql before query_semantic_model'));
    } finally {
      await mcp.close();
    }
  }
}

async function runtimeFailureChecks(lane, project) {
  // Nothing listening: a clear "start the workbench" message, quickly.
  const closedPort = await freePort();
  const down = await connectMcp(project, `http://127.0.0.1:${closedPort}`);
  try {
    await call(lane, down, 'query_via_block', { name: 'monthly_revenue' }, within(10_000, fails('Could not reach the ZLens runtime', 'zlens notebook')), { label: 'runtime down' });
    await call(lane, down, 'list_datasets', {}, within(10_000, fails('Could not reach the ZLens runtime')), { label: 'runtime down' });
    await call(lane, down, 'certify', { name: 'monthly_revenue' }, within(10_000, ok((b) => expectThat(b.checkedBy === 'metadata-only' && b.testsRun === false && /not checked|did not answer/i.test(JSON.stringify(b.notChecked)), 'certify without runtime must say tests were not run'))), { label: 'runtime down' });
  } finally {
    await down.close();
  }
  // Listening but silent: the call ends with a timeout message, never hangs.
  const silent = await silentServer();
  const stuck = await connectMcp(project, silent.url, { env: { ZLENS_MCP_RUNTIME_TIMEOUT_MS: '2000' } });
  try {
    await call(lane, stuck, 'query_via_block', { name: 'monthly_revenue' }, within(15_000, fails('did not answer', 'ZLENS_MCP_RUNTIME_TIMEOUT_MS')), { label: 'runtime stuck', timeoutMs: 30_000 });
    await call(lane, stuck, 'answer_question', { question: 'How has revenue changed by month?' }, within(15_000, fails('did not answer')), { label: 'runtime stuck', timeoutMs: 30_000 });
  } finally {
    await stuck.close();
    await silent.close();
  }
}

/**
 * True in the CI lanes, which start their own workbench with no AI model.
 * Against a real sample the workbench may have one (a local Ollama counts),
 * so a model-built draft is accepted there too.
 */
let controlledRuntime = true;
const noModelOrDraft = (...fragments) => (o) => {
  if (!controlledRuntime && !o.isError && o.body?.ok && /_drafts\//.test(o.body.draftBlockPath ?? '') && o.body.trustLabel === 'AI-Generated') return undefined;
  return fails(...fragments)(o);
};

async function dbtLane(project, runtimeUrl) {
  const lane = 'dbt';
  await profileChecks(lane, project, runtimeUrl);
  const mcp = await connectMcp(project, runtimeUrl);
  try {
    await call(lane, mcp, 'inspect_dql_project', {}, ok((b) => expectThat(b.blocks?.certified >= 4 && b.certifiedBlocks?.some((x) => x.name === 'monthly_revenue' && x.grain === 'one row per calendar month') && b.nextTool === 'ask_dql', `certified blocks ${b.blocks?.certified}, listed ${JSON.stringify(b.certifiedBlocks?.map((x) => x.name))}, next ${b.nextTool}`)));
    await call(lane, mcp, 'search_blocks', { query: 'revenue' }, ok((b) => expectThat(b.blocks?.some((x) => x.name === 'monthly_revenue' && x.status === 'certified'), 'monthly_revenue (certified) not found')));
    await call(lane, mcp, 'search_blocks', { status: 'bogus' }, fails('status'));
    await call(lane, mcp, 'get_block', { name: 'monthly_revenue' }, ok((b) => expectThat(/order_total/.test(b.sql ?? '') && b.status === 'certified', 'monthly_revenue SQL/status')));
    await call(lane, mcp, 'get_block', { name: 'no_such_block' }, fails('No block named'));
    await call(lane, mcp, 'get_block', {}, fails('name'));

    const certified = await call(lane, mcp, 'query_via_block', { name: 'monthly_revenue', question: 'How has revenue changed by month?' }, ok((b) => expectThat(b.trustLabel?.startsWith('Certified') && b.rowCount > 0 && b.columns?.length >= 2, `trustLabel ${b.trustLabel}, rows ${b.rowCount}`)));
    const reference = await runtimeSql(runtimeUrl, "select date_trunc('month', ordered_at) as month, sum(order_total) as gross_revenue from dev.orders group by 1 order by 1");
    record(lane, 'query_via_block', 'rows match reference SQL', compareRows(certified.body?.rows, reference, 'gross_revenue'));
    await call(lane, mcp, 'query_via_block', { name: 'no_such_block' }, fails('No block named'));

    await call(lane, mcp, 'ask_dql', { question: 'How has revenue changed by month?' }, ok((b) => expectThat(b.route === 'certified' && b.trustLabel?.base === 'Certified' && b.nextTool === 'query_via_block', `route ${b.route} label ${b.trustLabel?.base} next ${b.nextTool}`)));
    const generated = await call(lane, mcp, 'ask_dql', { question: 'Which store location had the most orders in 2025?' }, ok((b) => expectThat(b.route === 'generated_sql' && b.trustLabel?.base === 'AI-Generated' && b.contextPackId, `route ${b.route} label ${b.trustLabel?.base}`)));
    await call(lane, mcp, 'ask_dql', { question: 'What was our Net Promoter Score last quarter?' }, ok((b) => expectThat(b.route !== 'certified' && b.trustLabel?.base !== 'Certified', `route ${b.route} label ${b.trustLabel?.base}`)), { label: 'missing context' });
    await call(lane, mcp, 'ask_dql', {}, fails('question'));

    await call(lane, mcp, 'kg_search', { query: 'beverage' }, ok((b) => expectThat(b.hits?.length > 0, 'no hits')));
    await call(lane, mcp, 'kg_search', { query: 'x', kinds: ['bogus'] }, fails('kinds'));

    const inspected = await call(lane, mcp, 'inspect_metadata_context', { question: 'Which store location had the most orders in 2025?' }, ok((b) => expectThat(b.contextPack?.id && b.contextPack?.allowedSqlContext?.relations?.length > 0, 'no context pack / allowed relations')));
    // Claude Code refuses a tool result over 25k tokens (about 90k characters of JSON).
    record(lane, 'inspect_metadata_context', 'fits a client (under 25k tokens)', expectThat(inspected.text.length < 90_000, `result is ${inspected.text.length} chars`));
    const contextPackId = inspected.body?.contextPack?.id ?? generated.body?.contextPackId;
    await call(lane, mcp, 'expand_context', { contextPackId, relations: ['dev.supplies'] }, ok((b) => expectThat(b.ok !== false && (b.contextPackId || b.contextPack?.id), `expand failed ${JSON.stringify(b).slice(0, 160)}`)));
    await call(lane, mcp, 'expand_context', { contextPackId: 'nope', relations: ['dev.supplies'] }, fails('No context pack'));

    const tier2 = await call(lane, mcp, 'query_via_metadata', {
      question: 'Which store location had the most orders in 2025?',
      contextPackId,
      proposedSql: "select location_id, count(*) as orders from dev.orders where ordered_at >= '2025-01-01' and ordered_at < '2026-01-01' group by 1 order by 2 desc",
    }, ok((b) => expectThat(b.uncertified === true && /AI-generated/i.test(JSON.stringify(b.trustStatus ?? b.trustLabel ?? '')) && (b.rowCount ?? b.rows?.length) > 0, `uncertified ${b.uncertified}, rows ${b.rowCount}`)));
    // This fixture's order→location relationship is a draft: governance refuses the join, and says why.
    await call(lane, mcp, 'query_via_metadata', {
      question: 'Which store location had the most orders in 2025?',
      contextPackId,
      proposedSql: "select l.location_name, count(*) as orders from dev.orders o join dev.locations l on o.location_id = l.location_id group by 1",
    }, fails('relationship'), { label: 'uncertified join refused' });
    const draftPath = tier2.body?.draftBlock?.path;
    record(lane, 'query_via_metadata', 'saves a review draft', expectThat(draftPath && existsSync(join(project, draftPath)), `draft ${draftPath} not on disk`));
    await call(lane, mcp, 'query_via_metadata', { question: 'drop it', contextPackId, proposedSql: 'DELETE FROM dev.orders' }, fails(/read-only|SELECT/i));
    await call(lane, mcp, 'query_via_metadata', { question: 'q', contextPackId, proposedSql: 'select * from dev.no_such_table' }, fails(/no_such_table|not in the inspected|unknown/i));

    await call(lane, mcp, 'query_semantic_model', { metrics: ['order_total'], timeDimension: { name: 'metric_time', granularity: 'month' }, saveDraft: false }, ok((b) => expectThat(b.matched && b.uncertified === true && b.trustLabelInfo?.base === 'AI-Generated' && b.executionStatus === 'executed' && b.rowCount > 0 && b.certifiedBlock?.name === 'monthly_revenue' && b.nextTool === 'query_via_block', `matched ${b.matched} status ${b.executionStatus} label ${b.trustLabelInfo?.base} certifiedBlock ${b.certifiedBlock?.name}`)));
    // The Claude Desktop recording: the question asked straight of the semantic layer must name the certified block.
    await call(lane, mcp, 'query_semantic_model', { question: 'How has revenue changed by month?', dryRun: true, saveDraft: false }, ok((b) => expectThat(b.certifiedBlock?.name === 'monthly_revenue' && b.nextTool === 'query_via_block' && !JSON.stringify(b).includes('No certified block'), `certifiedBlock ${b.certifiedBlock?.name} next ${b.nextTool}`)), { label: 'certified question' });
    await call(lane, mcp, 'query_semantic_model', { question: 'Which store location had the most orders in 2025?', dryRun: true, saveDraft: false }, ok((b) => expectThat(!b.certifiedBlock && b.certifiedCheck?.checked === true, `certifiedBlock ${b.certifiedBlock?.name} check ${JSON.stringify(b.certifiedCheck)}`)), { label: 'no certified block' });
    await call(lane, mcp, 'query_semantic_model', { metrics: ['no_such_metric'] }, ok((b) => expectThat(b.matched === false && b.reason, 'unknown metric not reported')), { label: 'invalid' });

    await call(lane, mcp, 'lineage_impact', { focus: 'monthly_revenue' }, ok((b) => expectThat(JSON.stringify(b.nodes ?? []).includes('dbt_model:orders'), 'orders not upstream of monthly_revenue')));
    await call(lane, mcp, 'lineage_impact', { focus: 'no_such_node' }, fails('No node matches'));

    await call(lane, mcp, 'certify', { name: 'monthly_revenue' }, ok((b) => expectThat(b.checkedBy === 'workbench' && b.certified === true && b.tests?.failed === 0, `checkedBy ${b.checkedBy} certified ${b.certified} errors ${JSON.stringify(b.errors)} blockers ${JSON.stringify(b.blockers)}`)));
    await call(lane, mcp, 'certify', { name: 'no_such_block' }, fails('No block named'));

    await call(lane, mcp, 'suggest_block', { name: 'mcp_e2e_orders_by_store', domain: 'commerce', owner: 'analytics@jaffle.shop', description: 'Orders by store', sql: 'select location_id, count(*) as orders from dev.orders group by 1' }, ok((b) => expectThat(/_drafts\//.test(b.path ?? '') && b.certified === false, `path ${b.path} certified ${b.certified}`)));
    // A draft is never served as a certified answer.
    await call(lane, mcp, 'query_via_block', { name: 'mcp_e2e_orders_by_store' }, fails(/only certified blocks|No block named/));
    await call(lane, mcp, 'suggest_block', { name: 'x', domain: 'commerce', description: 'x', sql: 'select 1' }, fails('owner'));

    await call(lane, mcp, 'search_metadata', { query: 'customer lifetime spend' }, ok((b) => expectThat(b.tables?.some((t) => t.name === 'customers'), 'customers not ranked')));
    await call(lane, mcp, 'get_table_schema', { table: 'customers' }, ok((b) => expectThat(b.found && b.columns?.some((c) => c.name === 'lifetime_spend'), 'customers schema')));
    await call(lane, mcp, 'get_table_schema', { table: 'no_such_table' }, ok((b) => expectThat(b.found === false && /not found/i.test(b.hint ?? ''), 'unknown table not reported')), { label: 'invalid' });
    await call(lane, mcp, 'validate_sql', { sql: 'select customer_name, lifetime_spend from dev.customers' }, ok((b) => expectThat(b.ok === true, JSON.stringify(b).slice(0, 160))));
    await call(lane, mcp, 'validate_sql', { sql: 'select nope from dev.customers' }, ok((b) => expectThat(b.ok === false && b.offending?.column === 'nope', 'bad column not named')), { label: 'invalid' });

    await call(lane, mcp, 'resolve_analytical_path', { entities: ['order', 'location'] }, ok((b) => expectThat(b.entities?.length === 2 && b.code !== 'unbound_relation', `bare names not resolved: ${b.code} ${b.message ?? ''}`)));
    await call(lane, mcp, 'resolve_analytical_path', { entities: ['no_such_entity', 'order'] }, ok((b) => expectThat(b.code === 'unbound_relation' && b.availableEntities?.length > 0, 'unknown entity must list availableEntities')), { label: 'invalid' });
    await call(lane, mcp, 'explain_relationship_proof', { relationshipId: 'order_to_location' }, ok((b) => expectThat(b.found === true && b.relationship, 'relationship not found by local id')));
    await call(lane, mcp, 'explain_relationship_proof', { relationshipId: 'nope' }, fails('was not found', 'Known relationships'));

    await call(lane, mcp, 'list_datasets', {}, ok((b) => expectThat(b.ok === true && Array.isArray(b.datasets), 'datasets list')));
    await call(lane, mcp, 'describe_dataset', { sourceId: 'nope' }, fails('not a current approved'));
    await call(lane, mcp, 'preview_tile_query', { sourceId: 'nope', query: { dimensions: [], measures: [{ measure: 'revenue' }] } }, fails(/nope|not a current|refused/i));
    await call(lane, mcp, 'query_dataset', { sourceId: 'nope', query: { sql: 'select 1' } }, fails('query'));

    // No AI model in this workbench: both governed-generation tools say so and point at the path that needs none.
    await call(lane, mcp, 'answer_question', { question: 'How has revenue changed by month?' }, fails('no AI model', 'ask_dql', 'query_via_metadata'), { label: 'no model' });
    // A governed metric answers this one without a model: a real draft built on it.
    await call(lane, mcp, 'build_block_from_prompt', { prompt: 'weekly order count' }, ok((b) => expectThat(b.ok && /_drafts\//.test(b.draftBlockPath ?? '') && b.trustLabel === 'AI-Generated', `draft ${b.draftBlockPath}`)), { label: 'governed metric, no model' });
    await call(lane, mcp, 'build_block_from_prompt', { prompt: 'x', mode: 'edit' }, fails('blockPath'));

    // Design D9: an App AI builds is an App Studio draft that opens at the Data step; no App files.
    await call(lane, mcp, 'build_dql_app', { prompt: 'beverage performance', saveDraft: false }, ok((b) => expectThat(b.ok === true && b.saved === false && Array.isArray(b.sources) && b.draftId === undefined, 'picks-only App draft')));
    await call(lane, mcp, 'build_dql_app', {}, fails('prompt'));
    await call(lane, mcp, 'build_dql_app', { prompt: 'beverage performance', name: 'Beverage Performance', blocks: ['beverage_revenue_by_product', 'top_beverage_customers'] }, ok((b) => expectThat(
      b.ok && b.saved === true && /^build_/.test(b.draftId ?? '') && b.appId === 'beverage-performance'
        && b.openPath === `/?appDraft=${b.draftId}` && b.sources?.length === 2 && b.sources.every((s) => s.trust === 'Certified' && s.reason)
        && !existsSync(join(project, 'apps', 'beverage-performance')),
      `draft ${b.draftId} app ${b.appId} open ${b.openPath} sources ${JSON.stringify(b.sources)?.slice(0, 200)}`,
    )), { label: 'named, exact blocks, App Studio draft' });
    await call(lane, mcp, 'build_dql_app', { prompt: 'x', blocks: ['no_such_block'] }, fails('Only certified blocks'));
    await call(lane, mcp, 'list_apps', {}, ok((b) => {
      const app = b.apps?.find((a) => a.name === 'Jaffle Growth Review');
      const tiles = app?.dashboards?.[0]?.tiles ?? [];
      return expectThat(app && tiles.length === 4 && tiles.every((t) => t.block && t.trustLabel === 'Certified'), `Jaffle Growth Review tiles ${JSON.stringify(tiles).slice(0, 200)}`);
    }));
    await call(lane, mcp, 'list_apps', { query: 'no-such-app' }, ok((b) => expectThat(b.total === 0 && /No App matches/.test(b.note ?? ''), 'unmatched query not reported')), { label: 'no match' });
    await call(lane, mcp, 'list_notebooks', {}, ok((b) => expectThat(b.notebooks?.some((n) => n.path === 'notebooks/welcome.dqlnb' && n.cells?.length >= 2), 'welcome notebook')));
    await call(lane, mcp, 'list_notebooks', { path: 'notebooks/welcome.dqlnb' }, ok((b) => expectThat(b.returned === 1 && b.notebooks[0].cells.some((c) => c.type === 'markdown'), 'one notebook with its markdown cell')));
    await call(lane, mcp, 'list_notebooks', { path: 'notebooks/no_such.dqlnb' }, fails('No notebook at'));
  } finally {
    await mcp.close();
  }

  // Full profile: the expert/admin tools.
  const full = await connectMcp(project, runtimeUrl, { profile: 'full' });
  try {
    await call(lane, full, 'list_metrics', {}, ok((b) => expectThat(b.total > 0, 'no metrics')));
    await call(lane, full, 'list_dimensions', {}, ok((b) => expectThat(b.total > 0, 'no dimensions')));
    await call(lane, full, 'build_dql_block', { name: 'mcp_e2e_alias', domain: 'commerce', owner: 'analytics@jaffle.shop', description: 'Alias check', sql: 'select 1 as one' }, ok((b) => expectThat(/_drafts\//.test(b.path ?? ''), 'alias did not save a draft')));
    await call(lane, full, 'list_proposals', {}, ok((b) => expectThat(Array.isArray(b.proposals) && b.proposals.length > 0, 'no proposals after saving drafts')));
    await call(lane, full, 'feedback_record', { user: 'e2e', question: 'q', answerKind: 'uncertified', rating: 'up' }, ok((b) => expectThat(b.ok === true, 'feedback')));
    await call(lane, full, 'feedback_record', { user: 'e2e', question: 'q', answerKind: 'uncertified', rating: 'meh' }, fails('rating'));
    const correction = await call(lane, full, 'record_correction', { question: 'q', wrongAnswer: 'a', correction: 'b', scope: { domain: 'commerce' } }, ok((b) => expectThat(b.ok && b.status === 'candidate' && b.hintId, 'candidate hint')));
    await call(lane, full, 'list_hints', { status: 'candidate' }, ok((b) => expectThat(b.hints?.some((h) => h.id === correction.body?.hintId), 'hint not listed')));
    await call(lane, full, 'approve_hint', { hintId: correction.body?.hintId, decision: 'rejected', reviewer: 'e2e' }, ok((b) => expectThat(b.ok !== false, JSON.stringify(b).slice(0, 160))));
    await call(lane, full, 'approve_hint', { hintId: 'nope', decision: 'approved', reviewer: 'e2e' }, fails('not found'));
  } finally {
    await full.close();
  }
  await runtimeFailureChecks(lane, project);
}

async function warehouseLane(project, runtimeUrl) {
  const lane = 'warehouse';
  const mcp = await connectMcp(project, runtimeUrl);
  try {
    await call(lane, mcp, 'inspect_dql_project', {}, ok((b) => expectThat(b.blocks?.certified === 0, `certified ${b.blocks?.certified}`)));
    await call(lane, mcp, 'search_blocks', { query: 'revenue', status: 'certified' }, ok((b) => expectThat(b.total === 0, 'expected no certified blocks')));
    const asked = await call(lane, mcp, 'ask_dql', { question: 'Which store locations had the most revenue in 2025?' }, ok((b) => expectThat(b.route === 'generated_sql' && b.trustLabel?.base === 'AI-Generated', `route ${b.route} label ${b.trustLabel?.base}`)));
    await call(lane, mcp, 'search_metadata', { query: 'orders by store location' }, ok((b) => expectThat(b.tables?.some((t) => t.name === 'orders'), `no warehouse tables: ${JSON.stringify(b).slice(0, 160)}`)));
    await call(lane, mcp, 'get_table_schema', { table: 'orders' }, ok((b) => expectThat(b.found && b.columns?.some((c) => c.name === 'location_id'), 'warehouse schema')));
    await call(lane, mcp, 'validate_sql', { sql: 'select o.location_id, sum(o.order_total) from dev.orders o group by 1' }, ok((b) => expectThat(b.ok === true, JSON.stringify(b).slice(0, 200))));
    await call(lane, mcp, 'validate_sql', { sql: 'select nope from dev.orders' }, ok((b) => expectThat(b.ok === false && b.offending?.column === 'nope', 'bad column not named')), { label: 'invalid' });
    await call(lane, mcp, 'resolve_analytical_path', { entities: ['order', 'location'] }, ok((b) => expectThat(b.safe === true && b.edges?.length === 1, `order→location not certified: ${b.code} ${b.message ?? ''}`)));
    await call(lane, mcp, 'explain_relationship_proof', { relationshipId: 'order_to_location' }, ok((b) => expectThat(b.found && b.decision === 'automatic_join_allowed', `decision ${b.decision}`)));
    const tier2 = await call(lane, mcp, 'query_via_metadata', {
      question: 'Which store locations had the most revenue in 2025?',
      contextPackId: asked.body?.contextPackId,
      proposedSql: "select l.location_name, sum(o.order_total) as revenue from dev.orders o join dev.locations l on o.location_id = l.location_id where o.ordered_at >= '2025-01-01' and o.ordered_at < '2026-01-01' group by 1 order by 2 desc",
      saveDraft: false,
    }, ok((b) => expectThat(b.uncertified === true && (b.rowCount ?? 0) > 0, `uncertified ${b.uncertified} rows ${b.rowCount}`)));
    const reference = await runtimeSql(runtimeUrl, "select l.location_name, sum(o.order_total) as revenue from dev.orders o join dev.locations l on o.location_id = l.location_id where o.ordered_at >= '2025-01-01' and o.ordered_at < '2026-01-01' group by 1 order by 2 desc");
    record(lane, 'query_via_metadata', 'rows match reference SQL', compareRows(tier2.body?.rows, reference, 'revenue'));
    await call(lane, mcp, 'lineage_impact', { focus: 'order' }, ok((b) => expectThat(b.focalNode?.id === 'dql_entity:dev::entity::order', `focal ${b.focalNode?.id}`)));
    await call(lane, mcp, 'list_apps', {}, ok((b) => expectThat(b.total === 0 && /no Apps/i.test(b.note ?? ''), 'expected no Apps')));
    // No semantic metrics and no AI model: nothing can build from a description, and the tool says so.
    await call(lane, mcp, 'build_block_from_prompt', { prompt: 'total revenue by product' }, noModelOrDraft('could not build this block', 'suggest_block'), { label: 'no model' });
    await call(lane, mcp, 'answer_question', { question: 'Which store locations had the most revenue in 2025?' }, fails('no AI model', 'ask_dql'), { label: 'no model' });
  } finally {
    await mcp.close();
  }
}

async function datasetsLane(project, runtimeUrl) {
  const lane = 'datasets';
  const mcp = await connectMcp(project, runtimeUrl);
  try {
    const listed = await call(lane, mcp, 'list_datasets', {}, ok((b) => expectThat(b.datasets?.some((d) => d.title === 'Order lines Dataset'), 'Order lines Dataset missing')));
    const dataset = listed.body?.datasets?.find((d) => d.title === 'Order lines Dataset');
    const sourceId = dataset?.sourceId;
    await call(lane, mcp, 'describe_dataset', { sourceId }, ok((b) => expectThat(b.ok && b.dataset, 'describe')));
    const query = { dimensions: [], measures: [{ measure: 'revenue' }], filters: [{ field: 'region', op: 'eq', values: ['CA'] }] };
    await call(lane, mcp, 'preview_tile_query', { sourceId, query }, ok((b) => expectThat(b.ok && b.validation?.outcome === 'covered', `validation ${JSON.stringify(b.validation)}`)));
    await call(lane, mcp, 'query_dataset', { sourceId, query }, ok((b) => expectThat(b.ok && b.result?.rows?.[0]?.revenue === 60 && b.source?.trust === 'certified' && b.publicationEvidence === false, `rows ${JSON.stringify(b.result?.rows)} trust ${b.source?.trust}`)));
    await call(lane, mcp, 'query_dataset', { sourceId, query: { dimensions: [{ field: 'not_approved' }], measures: [{ measure: 'revenue' }] } }, fails('refused'));
    await call(lane, mcp, 'query_dataset', { sourceId, query: { dimensions: [], measures: [], sql: 'select 1' } }, fails('sql'));
  } finally {
    await mcp.close();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function runtimeSql(runtimeUrl, sql) {
  const response = await fetch(`${runtimeUrl}/api/notebook/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell: { id: 'mcp-e2e-reference', type: 'sql', source: sql } }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json();
  return payload.result?.rows ?? [];
}

function compareRows(actual, expected, valueColumn) {
  if (!Array.isArray(actual) || actual.length === 0) return 'no rows returned';
  if (actual.length !== expected.length) return `row count ${actual.length}, reference ${expected.length}`;
  for (let i = 0; i < expected.length; i += 1) {
    const a = Number(actual[i]?.[valueColumn]);
    const e = Number(expected[i]?.[valueColumn]);
    if (!(Math.abs(a - e) < 0.01)) return `row ${i}: ${a} vs reference ${e}`;
  }
  return undefined;
}

// ── main ────────────────────────────────────────────────────────────────────

/** The jaffle-shop-duckdb sample's App and notebook, which the jaffle-golden fixture leaves out. */
function addSampleAppAndNotebook(project) {
  const writeJson = (path, value) => { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), `${JSON.stringify(value, null, 2)}\n`); };
  writeJson('apps/jaffle-growth/dql.app.json', {
    version: 1, id: 'jaffle-growth', name: 'Jaffle Growth Review', description: 'Certified revenue and beverage blocks.',
    domain: 'commerce', visibility: 'shared', lifecycle: 'certified', owners: ['analytics@jaffle.shop'], tags: ['growth'],
    homepage: { type: 'dashboard', id: 'overview' },
  });
  const tile = (i, blockId, title, type) => ({ i, x: 0, y: 0, w: 6, h: 4, block: { blockId }, viz: { type }, title });
  writeJson('apps/jaffle-growth/dashboards/overview.dqld', {
    version: 1, id: 'overview',
    metadata: { title: 'Jaffle Growth Review', domain: 'commerce', visibility: 'shared', lifecycle: 'certified', tags: ['growth'] },
    layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
      tile('monthly-revenue', 'monthly_revenue', 'Monthly gross revenue', 'line'),
      tile('beverage-products', 'beverage_revenue_by_product', 'Top beverage products', 'bar'),
      tile('beverage-customers', 'top_beverage_customers', 'Top beverage customers', 'table'),
      tile('customer-profile', 'customer_profile', 'Customer lifetime profiles', 'table'),
    ] },
  });
  writeJson('notebooks/welcome.dqlnb', {
    dqlnbVersion: 2, version: 1, title: 'Jaffle Shop Growth & Beverage Insights',
    metadata: { description: 'A ZLens research notebook for the Jaffle Shop commerce domain.', ownerDomain: 'commerce' },
    cells: [
      { id: 'intro', type: 'markdown', name: 'Start here', content: '# Jaffle Shop Growth & Beverage Insights' },
      { id: 'monthly-revenue', type: 'sql', name: 'Monthly gross revenue', content: "SELECT date_trunc('month', ordered_at) AS month, SUM(order_total) AS gross_revenue FROM dev.orders GROUP BY 1 ORDER BY 1" },
    ],
  });
}

const LANES = {
  dbt: { fixture: 'jaffle-golden', seed: 'jaffle-golden/seeds/seed.json', warehouseFile: 'jaffle_shop.duckdb', sync: ['sync', 'dbt'], setup: addSampleAppAndNotebook, run: dbtLane },
  warehouse: { fixture: 'jaffle-warehouse-golden', seed: 'jaffle-golden/seeds/seed.json', warehouseFile: 'jaffle_shop.duckdb', sync: ['sync', 'warehouse'], run: warehouseLane },
  datasets: { fixture: 'app-datasets-pilot', seed: 'app-datasets-pilot/seeds/seed.json', warehouseFile: 'app-datasets-pilot.duckdb', sync: ['compile'], run: datasetsLane },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(cli)) throw new Error(`Build the CLI first (pnpm build): ${cli} is missing.`);
  const started = Date.now();
  if (args.project) {
    controlledRuntime = false;
    const lane = args.lanes?.[0] ?? 'dbt';
    if (!args.runtimeUrl) throw new Error('--project needs --runtime-url (the running workbench for that project).');
    await LANES[lane].run(args.project, args.runtimeUrl);
  } else {
    const connectorRoot = ensureConnectorRoot(args.connectorRoot);
    for (const name of args.lanes ?? Object.keys(LANES)) {
      const spec = LANES[name];
      const { work, project } = prepareProject({ ...spec, connectorRoot, seed: join(fixtures, spec.seed) });
      const workbench = await startWorkbench(project, work, spec.env?.(project) ?? {});
      try {
        await spec.run(project, workbench.baseUrl);
      } catch (error) {
        record(name, 'lane', 'ran to the end', `lane crashed: ${error instanceof Error ? error.stack : String(error)}`);
      } finally {
        await workbench.stop();
        if (args.keep) process.stdout.write(`  kept ${work}\n`);
        else rmSync(work, { recursive: true, force: true });
      }
    }
  }
  const failed = results.filter((entry) => !entry.ok);
  const tools = new Set(results.filter((entry) => !['initialize', 'tools/list', 'instructions', 'lane'].includes(entry.tool)).map((entry) => entry.tool));
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed over ${tools.size} tools in ${Math.round((Date.now() - started) / 1000)} s.\n`);
  if (args.json) writeFileSync(args.json, JSON.stringify({ results, failed: failed.length, tools: [...tools].sort() }, null, 2));
  if (failed.length) {
    process.stdout.write(`Failed:\n${failed.map((entry) => `  [${entry.lane}] ${entry.tool} (${entry.case}): ${entry.failure}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
