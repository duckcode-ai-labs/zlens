#!/usr/bin/env node
// The clean-machine launch gate. See scripts/launch-gate/README.md.
//
//   node scripts/launch-gate.mjs [--out <dir>] [--tarballs <dir>] [--only dbt,warehouse,create]
//                                [--port <first port>] [--python <bin>]
//                                [--npm system,12,bundled:<node dir>] [--node <dir of a node binary>]
//
// It packs the release from this checkout (the same tarballs `npm publish`
// would upload), serves them from a local registry, and then follows the
// README / docs quickstart exactly, in fresh folders, for both samples and
// for `create-zlens-app --warehouse duckdb`. Every check is one row of a
// pass/fail table; logs and screenshots are kept as evidence under --out.
// Exit code 0 only when every row passed.
//
// It runs all of that once per npm "lane": the system npm, and npm 12
// (`--npm system,12`, the default). npm 12 blocks dependency install scripts
// unless package.json allows them, which left better-sqlite3 without its
// native binary in 0.2.0; a gate on npm 10 alone could not see it. npm 12
// needs Node ^22.22.2 || ^24.15.0 || >=26: when the gate's own Node is older,
// pass --node <folder with a newer node binary>. A `bundled:<node dir>` lane
// runs that Node with the npm it ships with, for a Node line the other lanes do
// not cover (the release gate adds Node 26 LTS this way).

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startLocalRegistry } from './launch-gate/local-registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SAMPLES = {
  dbt: {
    repo: 'https://github.com/duckcode-ai/jaffle-shop-duckdb.git',
    dir: 'jaffle-shop-duckdb',
    spec: 'browser/gate/dbt-sample.gate.ts',
  },
  warehouse: {
    repo: 'https://github.com/duckcode-ai/jaffle-shop-warehouse.git',
    dir: 'jaffle-shop-warehouse',
    spec: 'browser/gate/warehouse-sample.gate.ts',
  },
};

// ── arguments ──────────────────────────────────────────────────────────────

export function parseGateArguments(argv, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const options = {
    out: path.join(tmpdir(), 'zlens-launch-gate', `gate-${stamp}`),
    tarballs: null,
    only: new Set(['dbt', 'warehouse', 'create']),
    port: 3620,
    python: 'python3',
    npm: ['system', '12'],
    node: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return next;
    };
    if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--tarballs') options.tarballs = path.resolve(value());
    else if (arg === '--only') {
      const parts = value().split(',').map((part) => part.trim()).filter(Boolean);
      for (const part of parts) if (!['dbt', 'warehouse', 'create'].includes(part)) throw new Error(`Unknown --only part: ${part}`);
      options.only = new Set(parts);
    } else if (arg === '--port') options.port = Number(value());
    else if (arg === '--python') options.python = value();
    else if (arg === '--npm') {
      const lanes = value().split(',').map((part) => part.trim()).filter(Boolean);
      for (const lane of lanes) if (lane !== 'system' && !/^\d+(\.\d+){0,2}$/.test(lane) && !/^bundled:.+/.test(lane)) throw new Error(`Unknown --npm lane: ${lane} (use system, an npm version such as 12, or bundled:<folder with a node binary>)`);
      if (lanes.length === 0) throw new Error('--npm needs at least one lane.');
      options.npm = [...new Set(lanes)];
    } else if (arg === '--node') options.node = path.resolve(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024) throw new Error('--port must be a port number of 1024 or more.');
  return options;
}

/**
 * Whether `version` satisfies a package.json range as npm reads it: exact,
 * `^x.y.z` (below 1.0 a caret does not cross minor versions) or `~x.y.z`.
 * Enough for the samples' and the template's `@zlens/cli` range.
 */
export function rangeAllows(range, version) {
  const parse = (text) => text.split('-')[0].split('.').map(Number);
  const [major, minor, patch] = parse(version);
  const prerelease = version.includes('-');
  const match = /^([\^~]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(range).trim());
  if (!match) return false;
  const [, op, base] = match;
  if (prerelease && base !== version) return false;
  const [bMajor, bMinor, bPatch] = parse(base);
  const gte = major > bMajor || (major === bMajor && (minor > bMinor || (minor === bMinor && patch >= bPatch)));
  if (!op) return base === version;
  if (!gte) return false;
  if (op === '~') return major === bMajor && minor === bMinor;
  if (bMajor > 0) return major === bMajor;
  if (bMinor > 0) return major === 0 && minor === bMinor;
  return major === 0 && minor === 0 && patch === bPatch;
}

/**
 * Whether a Node version satisfies an `engines.node` range as npm 12 writes
 * it: `||` alternatives of `^x.y.z`, `>=x.y.z`, `x.y.z` or `x` (any x.*).
 */
export function nodeSatisfies(range, version) {
  const parse = (text) => String(text).replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  const compare = (a, b) => {
    for (let index = 0; index < 3; index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
    return 0;
  };
  const have = parse(version);
  return String(range).split('||').map((part) => part.trim()).filter(Boolean).some((alternative) => {
    return alternative.split(/\s+/).every((comparator) => {
      const match = /^(\^|>=|>|<=|<|=)?v?(\d+(?:\.\d+){0,2})$/.exec(comparator);
      if (!match) return false;
      const [, op = '', base] = match;
      const want = parse(base);
      const cmp = compare(have, want);
      if (op === '^') return cmp >= 0 && have[0] === want[0];
      if (op === '>=') return cmp >= 0;
      if (op === '>') return cmp > 0;
      if (op === '<=') return cmp <= 0;
      if (op === '<') return cmp < 0;
      return base.split('.').length === 1 ? have[0] === want[0] : cmp === 0;
    });
  });
}

// ── processes ──────────────────────────────────────────────────────────────

export async function freePort(from) {
  for (let port = from; port < from + 200; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`No free port from ${from}.`);
}

/**
 * Run a command line the way a person types it (bash -c), asynchronously so
 * the in-process registry keeps answering. Output goes to `logFile` too.
 */
function sh(command, { cwd, env, logFile, timeoutMs = 20 * 60 * 1000 }) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const onData = (chunk) => { output += chunk; };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { output += `\n[gate] timed out after ${timeoutMs / 1000}s\n`; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      if (logFile) writeFileSync(logFile, `$ ${command}\n(cwd ${cwd})\n\n${output}\n[exit ${status}]\n`, { flag: 'a' });
      resolve({ status, output });
    });
  });
}

/** Start `npm run notebook -- --port <port>` and wait for "Notebook ready". */
function startWorkbench({ cwd, env, port, logFile }) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', `npm run notebook -- --port ${port}`], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const stop = () => new Promise((done) => {
      if (child.exitCode !== null) { done(); return; }
      try { process.kill(-child.pid, 'SIGINT'); } catch { /* gone */ }
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } done(); }, 8000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
    const onData = (chunk) => {
      output += chunk;
      writeFileSync(logFile, chunk, { flag: 'a' });
      const ready = /Notebook ready: (http:\/\/[^\s]+)/.exec(output);
      if (ready && !settled) { settled = true; resolve({ url: ready[1].replace(/\/$/, ''), stop, output: () => output }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(`npm run notebook exited (${code}) before "Notebook ready":\n${output.slice(-2000)}`)); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; void stop(); reject(new Error(`No "Notebook ready" within 180s:\n${output.slice(-2000)}`)); }
    }, 180_000);
  });
}

// ── the gate ───────────────────────────────────────────────────────────────

class Gate {
  constructor(out) {
    this.out = out;
    this.rows = [];
    this.logs = path.join(out, 'logs');
    this.evidence = path.join(out, 'evidence');
    mkdirSync(this.logs, { recursive: true });
    mkdirSync(this.evidence, { recursive: true });
  }

  record(row) {
    this.rows.push(row);
    const mark = row.status === 'pass' ? 'PASS' : row.status === 'fail' ? 'FAIL' : 'SKIP';
    console.log(`  ${mark}  ${row.area} · ${row.check}${row.detail ? ` — ${row.detail.split('\n')[0].slice(0, 160)}` : ''}`);
  }

  /** Run one check; a thrown error is a failure with its message as detail. */
  async check(area, check, fn, { evidence } = {}) {
    try {
      const detail = await fn();
      this.record({ area, check, status: 'pass', detail: detail ?? '', evidence: evidence ?? '' });
      return true;
    } catch (error) {
      this.record({ area, check, status: 'fail', detail: error instanceof Error ? error.message : String(error), evidence: evidence ?? '' });
      return false;
    }
  }

  skip(area, check, why) {
    this.record({ area, check, status: 'skip', detail: why, evidence: '' });
  }
}

function expectRun(result, what, { contains } = {}) {
  if (result.status !== 0) throw new Error(`${what} exited ${result.status}: ${result.output.trim().split('\n').slice(-6).join(' ⏎ ')}`);
  if (contains && !contains.test(result.output)) throw new Error(`${what} did not print ${contains}: ${result.output.trim().split('\n').slice(-4).join(' ⏎ ')}`);
}

/**
 * The environment of a person's own shell on a machine that has never run
 * ZLens: no npm/pnpm variables from this harness, a fresh npm cache and user
 * config, npm pointed at the gate's registry, and no dbt / mf / zlens from a
 * developer's PATH (the quickstart uses the sample's own .venv/bin/dbt).
 */
function cleanEnv({ out, registryUrl, shims, prepend = [] }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_|PNPM_|INIT_CWD$|PLAYWRIGHT_|TEST_|ZLENS_|DQL_|VIRTUAL_ENV$|CONDA_)/i.test(key)) continue;
    env[key] = value;
  }
  // A PATH directory that holds one of these keeps everything else: it is
  // replaced by a folder of links to its other entries. (Dropping the whole
  // directory also dropped /opt/homebrew/bin, and with it the claude CLI.)
  const hidden = new Set(['dbt', 'mf', 'zlens', 'dql']);
  const removed = [];
  const keep = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir, index) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return dir; }
    const hits = entries.filter((entry) => hidden.has(entry));
    if (hits.length === 0) return dir;
    removed.push(`${dir}/{${hits.join(',')}}`);
    const filtered = path.join(out, 'path', String(index));
    mkdirSync(filtered, { recursive: true });
    for (const entry of entries) {
      if (hidden.has(entry)) continue;
      try { symlinkSync(path.join(dir, entry), path.join(filtered, entry)); } catch { /* exists */ }
    }
    return filtered;
  });
  const npmrc = path.join(out, 'npmrc');
  writeFileSync(npmrc, '');
  Object.assign(env, {
    PATH: [shims, ...prepend, ...keep].join(path.delimiter),
    npm_config_registry: registryUrl,
    npm_config_cache: path.join(out, 'npm-cache'),
    npm_config_userconfig: npmrc,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    // A clean machine has no Ollama: keep a developer's local Ollama from
    // switching the workbench to semantic embeddings (the default is offline).
    ZLENS_EMBEDDINGS_AUTODETECT: 'off',
  });
  return { env, removed };
}

async function packTarballs(gate, options) {
  const cli = JSON.parse(readFileSync(path.join(repoRoot, 'apps/cli/package.json'), 'utf8'));
  const version = cli.version;
  const packDir = path.join(gate.out, 'pack');
  mkdirSync(packDir, { recursive: true });
  const sha = (await sh('git rev-parse HEAD', { cwd: repoRoot, env: process.env })).output.trim();
  const dirty = Boolean((await sh('git status --porcelain', { cwd: repoRoot, env: process.env })).output.trim());
  let source = options.tarballs;
  await gate.check('release', `${options.tarballs ? 'reuse packed' : 'pack'} ${version} at ${sha.slice(0, 8)}${dirty ? ' (uncommitted changes)' : ''}`, async () => {
    if (!source) {
      const tag = version.includes('-') ? 'next' : 'latest';
      const result = await sh(`node scripts/release-packages.mjs --dry-run --tag ${tag} --expected-version ${version}`, {
        cwd: repoRoot, env: process.env, logFile: path.join(gate.logs, 'pack.log'), timeoutMs: 40 * 60 * 1000,
      });
      expectRun(result, 'release-packages.mjs --dry-run');
      source = path.join(repoRoot, '.release-artifacts');
    }
    const files = readdirSync(source).filter((file) => file.endsWith(`-${version}.tgz`));
    for (const file of files) copyFileSync(path.join(source, file), path.join(packDir, file));
    if (files.length !== 18) throw new Error(`expected 18 release tarballs for ${version} in ${source}, found ${files.length}`);
    return `${files.length} tarballs → ${path.relative(gate.out, packDir)}/`;
  });
  return { version, sha, dirty, packDir };
}

// ── npm lanes ──────────────────────────────────────────────────────────────

/** Loads better-sqlite3 from the project and opens a database: what every ZLens store does first. */
const LOAD_SQLITE = `node -e "const D = require('better-sqlite3'); new D(':memory:').close(); console.log('better-sqlite3 loads')"`;
/** Loads the DuckDB driver from .dql/connectors, as the connector does, and says which DuckDB it is. */
const LOAD_DUCKDB = `node -e "const { DuckDBInstance } = require('./.dql/connectors/node_modules/@duckdb/node-api'); DuckDBInstance.create(':memory:').then(async (db) => { const c = await db.connect(); const r = await c.runAndReadAll('SELECT version() AS v'); console.log('duckdb loads ' + r.getRows()[0][0]); c.closeSync(); db.closeSync(); }).catch((e) => { console.error(e); process.exit(1); })"`;
/** The DuckDB line ZLens reads (RFC 0011): a driver from another line is a failed row. */
const DUCKDB_LINE = /duckdb loads v1\.5\./;
const BLOCKED_SCRIPTS = /install-scripts[^\n]*(better-sqlite3|duckdb)@/g;

/** The `zlens x.y.z` line of `npx zlens --version` (npm 12 also prints "npm notice run …" lines). */
function versionLine(output) {
  return output.split('\n').map((line) => line.trim()).find((line) => /^zlens \d/.test(line)) ?? output.trim();
}

/** The packages whose install scripts npm said it blocked. */
function blockedScripts(output) {
  return [...new Set([...output.matchAll(BLOCKED_SCRIPTS)].map((match) => match[1]))];
}

/**
 * Set up each npm lane's clean shell. `system` is the npm on PATH; a version
 * (`12`) is installed into the gate's folder and put first on PATH, with the
 * Node it needs (`--node`, else the gate's own Node when it satisfies npm's
 * engines). A lane that cannot be set up is a failed row, never skipped.
 */
async function prepareLanes(gate, options, { registryUrl, shims }) {
  const lanes = [];
  for (const spec of options.npm) {
    if (spec.startsWith('bundled:')) {
      let lane = null;
      await gate.check('machine', `${spec} lane: that Node with the npm it ships with`, async () => {
        const given = spec.slice('bundled:'.length);
        const nodeDir = statSync(given).isDirectory() ? given : path.dirname(given);
        const { env, removed } = cleanEnv({ out: gate.out, registryUrl, shims, prepend: [nodeDir] });
        const npmVersion = (await sh('npm --version', { cwd: gate.out, env })).output.trim();
        const nodeVersion = (await sh('node --version', { cwd: gate.out, env })).output.trim();
        const major = nodeVersion.replace(/^v/, '').split('.')[0];
        lane = { id: `node${major}`, label: `node ${major}`, npmVersion, nodeVersion, env, removed };
        return `npm ${npmVersion} on node ${nodeVersion} (${nodeDir})`;
      });
      if (lane) lanes.push(lane);
      continue;
    }
    if (spec === 'system') {
      const { env, removed } = cleanEnv({ out: gate.out, registryUrl, shims });
      const npmVersion = (await sh('npm --version', { cwd: gate.out, env })).output.trim();
      const nodeVersion = (await sh('node --version', { cwd: gate.out, env })).output.trim();
      lanes.push({ id: 'system', label: `npm ${npmVersion.split('.')[0]}`, npmVersion, nodeVersion, env, removed });
      continue;
    }
    let lane = null;
    await gate.check('machine', `npm ${spec} lane: install npm@${spec} and a Node it supports`, async () => {
      const resolved = await sh(`npm view npm@${spec} version --json`, { cwd: gate.out, env: process.env, logFile: path.join(gate.logs, `npm${spec}-setup.log`) });
      expectRun(resolved, `npm view npm@${spec} version`);
      const versions = [JSON.parse(resolved.output.trim())].flat();
      // As `npm install npm@12` picks: the `latest` tag when it matches, else the highest match.
      const latest = (await sh('npm view npm dist-tags.latest', { cwd: gate.out, env: process.env })).output.trim();
      const npmVersion = versions.includes(latest) ? latest : versions[versions.length - 1];
      const engines = (await sh(`npm view npm@${npmVersion} engines.node`, { cwd: gate.out, env: process.env })).output.trim();
      let nodeDir = path.dirname(process.execPath);
      if (options.node) nodeDir = statSync(options.node).isDirectory() ? options.node : path.dirname(options.node);
      const nodeVersion = (await sh(`"${path.join(nodeDir, 'node')}" --version`, { cwd: gate.out, env: process.env })).output.trim();
      if (!nodeSatisfies(engines, nodeVersion)) {
        throw new Error(`npm ${npmVersion} needs Node ${engines}; ${path.join(nodeDir, 'node')} is ${nodeVersion}. Pass --node <folder with a node binary that satisfies it>, e.g. Node 24 from https://nodejs.org/dist/latest-v24.x/.`);
      }
      const prefix = path.join(gate.out, 'lanes', `npm-${npmVersion}`);
      mkdirSync(prefix, { recursive: true });
      expectRun(await sh(`npm install --prefix "${prefix}" --no-audit --no-fund npm@${npmVersion}`, {
        cwd: gate.out, env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH}` }, logFile: path.join(gate.logs, `npm${spec}-setup.log`),
      }), `npm install npm@${npmVersion}`);
      const npmBin = path.join(prefix, 'node_modules', '.bin');
      const { env, removed } = cleanEnv({ out: gate.out, registryUrl, shims, prepend: [npmBin, nodeDir] });
      const seenNpm = (await sh('npm --version', { cwd: gate.out, env })).output.trim();
      const seenNode = (await sh('node --version', { cwd: gate.out, env })).output.trim();
      if (seenNpm !== npmVersion || seenNode !== nodeVersion) throw new Error(`the lane's shell runs npm ${seenNpm} on node ${seenNode}, expected npm ${npmVersion} on ${nodeVersion}`);
      lane = { id: `npm${spec}`, label: `npm ${spec}`, npmVersion, nodeVersion, env, removed };
      return `npm ${npmVersion} on node ${nodeVersion} (${nodeDir}); npm's engines: ${engines}`;
    }, { evidence: `logs/npm${spec}-setup.log` });
    if (lane) lanes.push(lane);
  }
  return lanes;
}

async function runBrowserChecks(gate, { sample, url, projectDir, env, lane, area }) {
  const report = path.join(gate.out, `playwright-${lane.id}-${sample}.json`);
  const evidenceDir = path.join(gate.evidence, lane.id);
  mkdirSync(evidenceDir, { recursive: true });
  const result = await sh(
    `pnpm --filter @zlens/notebook-app exec playwright test --config playwright.gate.config.ts ${SAMPLES[sample].spec}`,
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env.passThrough,
        ZLENS_GATE_BASE_URL: url,
        ZLENS_GATE_PROJECT_DIR: projectDir,
        ZLENS_GATE_EVIDENCE_DIR: evidenceDir,
        ZLENS_GATE_SAMPLE: sample,
        ZLENS_GATE_REPORT: report,
        ZLENS_GATE_OUTPUT_DIR: path.join(gate.out, 'playwright', lane.id, sample),
      },
      logFile: path.join(gate.logs, `${lane.id}-${sample}-browser.log`),
      timeoutMs: 60 * 60 * 1000,
    },
  );
  if (!existsSync(report)) {
    gate.record({ area, check: 'browser checks', status: 'fail', detail: `Playwright wrote no report (exit ${result.status}): ${result.output.slice(-600)}`, evidence: `logs/${lane.id}-${sample}-browser.log` });
    return;
  }
  const json = JSON.parse(readFileSync(report, 'utf8'));
  const specs = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) specs.push(spec);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of json.suites ?? []) walk(suite);
  for (const spec of specs) {
    const test = spec.tests?.[0];
    const last = test?.results?.[test.results.length - 1];
    const status = last?.status === 'passed' ? 'pass' : last?.status === 'skipped' ? 'skip' : 'fail';
    const notes = (test?.annotations ?? []).filter((note) => note.type === 'note').map((note) => note.description);
    const error = (last?.errors ?? []).map((entry) => entry.message ?? '').join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const slug = spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    gate.record({
      area,
      check: spec.title,
      status,
      detail: status === 'pass' ? notes.join(' · ') : `${error.split('\n').filter(Boolean).slice(0, 4).join(' ⏎ ')}${notes.length ? ` (notes: ${notes.join(' · ')})` : ''}`,
      evidence: `evidence/${lane.id}/${sample}-${slug}.png`,
    });
  }
}

async function sampleFlow(gate, sample, ctx, lane) {
  const { registryUrl, version, options } = ctx;
  const { env } = lane;
  const meta = SAMPLES[sample];
  const area = `${sample} · ${lane.label}`;
  const workDir = path.join(gate.out, lane.id, sample);
  mkdirSync(workDir, { recursive: true });
  const projectDir = path.join(workDir, meta.dir);
  const logName = (name) => `${lane.id}-${sample}-${name}.log`;
  const log = (name) => path.join(gate.logs, logName(name));
  const run = (command, name, extra = {}) => sh(command, { cwd: projectDir, env, logFile: log(name), ...extra });

  if (!(await gate.check(area, `git clone ${meta.repo.replace('https://github.com/', '')}`, async () => {
    expectRun(await sh(`git clone ${meta.repo}`, { cwd: workDir, env, logFile: log('clone') }), 'git clone');
    const head = (await sh('git rev-parse --short HEAD', { cwd: projectDir, env })).output.trim();
    return `at ${head}`;
  }, { evidence: `logs/${logName('clone')}` }))) return;

  // The sample's own @zlens/cli range decides what `npm install` installs.
  const pkgPath = path.join(projectDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const range = pkg.devDependencies?.['@zlens/cli'] ?? pkg.dependencies?.['@zlens/cli'];
  const allowed = await gate.check(area, `sample's @zlens/cli range installs ${version}`, async () => {
    if (!rangeAllows(range, version)) {
      throw new Error(`package.json declares "@zlens/cli": "${range}", so \`npm install\` would not install ${version}. Bump the sample to "^${version}" when ${version} is published.`);
    }
    return `"${range}"`;
  });
  if (!allowed) {
    // Test the release anyway, as the sample will be once it is bumped.
    pkg.devDependencies = { ...(pkg.devDependencies ?? {}), '@zlens/cli': `^${version}` };
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(log('range'), `The gate set "@zlens/cli": "^${version}" in ${pkgPath} to continue.\n`);
  }

  if (sample === 'dbt') {
    const ok = await gate.check(area, 'README step 1: python venv, pip install, dbt deps/seed/build', async () => {
      const steps = [
        `${options.python} -m venv .venv`,
        '.venv/bin/pip install -r requirements.txt',
        '.venv/bin/dbt deps --profiles-dir .',
        '.venv/bin/dbt seed --profiles-dir .',
        '.venv/bin/dbt build --profiles-dir . --exclude resource_type:seed',
      ];
      for (const step of steps) expectRun(await run(step, 'dbt'), step);
      if (!existsSync(path.join(projectDir, 'target', 'manifest.json'))) throw new Error('no target/manifest.json after dbt build');
      return `${(await run(`${options.python} --version`, 'dbt')).output.trim()}; jaffle_shop.duckdb and target/manifest.json built`;
    }, { evidence: `logs/${logName('dbt')}` });
    if (!ok) return;
  }

  if (!(await gate.check(area, 'npm install (installs @zlens/cli from the packed release)', async () => {
    const install = await run('npm install', 'npm-install');
    expectRun(install, 'npm install');
    const installed = JSON.parse(readFileSync(path.join(projectDir, 'node_modules', '@zlens', 'cli', 'package.json'), 'utf8')).version;
    const zlens = await run('npx zlens --version', 'npm-install');
    expectRun(zlens, 'npx zlens --version');
    if (versionLine(zlens.output) !== `zlens ${version}` || installed !== version) throw new Error(`installed ${installed}, \`npx zlens --version\` says ${versionLine(zlens.output)}`);
    const lock = readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8');
    if (!lock.includes(`${registryUrl}-/gate/zlens-cli-${version}.tgz`)) throw new Error('package-lock.json does not resolve @zlens/cli to the packed tarball');
    const blocked = blockedScripts(install.output);
    if (blocked.length) throw new Error(`npm blocked the install script of ${blocked.join(', ')}: the sample's package.json needs "allowScripts": { "better-sqlite3": true }`);
    return `zlens ${version} from the packed tarball; no install script blocked`;
  }, { evidence: `logs/${logName('npm-install')}` }))) return;

  await gate.check(area, 'better-sqlite3 native binary loads', async () => {
    const result = await run(LOAD_SQLITE, 'native');
    expectRun(result, 'require better-sqlite3 + open :memory:');
    return 'opens an in-memory database';
  }, { evidence: `logs/${logName('native')}` });

  // No driver step: `npm run sync` (a warehouse sync) or `npm run notebook`
  // installs @duckdb/node-api into .dql/connectors the first time (RFC 0011).
  const driverPackageJson = path.join(projectDir, '.dql', 'connectors', 'node_modules', '@duckdb', 'node-api', 'package.json');
  await gate.check(area, 'npm run sync', async () => {
    const result = await run('npm run sync', 'sync');
    if (sample === 'dbt') expectRun(result, 'npm run sync', { contains: /✓ dbt sync complete/ });
    else expectRun(result, 'npm run sync', { contains: /✓ Warehouse catalog: 13 relation\(s\)/ });
    const last = result.output.trim().split('\n').filter((line) => line.includes('✓')).slice(-1)[0]?.trim() ?? '';
    if (sample === 'dbt') return last;
    if (!existsSync(driverPackageJson)) throw new Error('the warehouse sync did not install @duckdb/node-api into .dql/connectors');
    return `${last}; installed @duckdb/node-api ${JSON.parse(readFileSync(driverPackageJson, 'utf8')).version}`;
  }, { evidence: `logs/${logName('sync')}` });

  await gate.check(area, 'npm run validate', async () => {
    const result = await run('npm run validate', 'validate');
    expectRun(result, 'npm run validate');
    return result.output.trim().split('\n').slice(-1)[0]?.trim() ?? '';
  }, { evidence: `logs/${logName('validate')}` });

  const port = await freePort(ctx.nextPort());
  let workbench = null;
  const started = await gate.check(area, 'npm run notebook (Notebook ready)', async () => {
    workbench = await startWorkbench({ cwd: projectDir, env, port, logFile: log('notebook') });
    const installed = /Installing the DuckDB driver/.test(workbench.output()) ? '; installed the DuckDB driver on start' : '';
    return `${workbench.url} (README: 3474; the gate uses a free port and passes --port)${installed}`;
  }, { evidence: `logs/${logName('notebook')}` });
  if (!started) return;

  await gate.check(area, 'DuckDB driver loads from .dql/connectors (DuckDB 1.5)', async () => {
    const result = await run(LOAD_DUCKDB, 'native');
    expectRun(result, 'require .dql/connectors @duckdb/node-api + open :memory:', { contains: DUCKDB_LINE });
    return `${result.output.trim().split('\n').find((line) => line.startsWith('duckdb loads'))}; no source build`;
  }, { evidence: `logs/${logName('native')}` });

  const runtimeEnv = { ...env, ZLENS_RUNTIME_URL: workbench.url };
  try {
    await runBrowserChecks(gate, { sample, url: workbench.url, projectDir, env: { passThrough: {} }, lane, area });

    await gate.check(area, 'zlens connect claude-code writes the MCP config', async () => {
      const result = await run('npx zlens connect claude-code', 'connect');
      expectRun(result, 'npx zlens connect claude-code');
      const mcpPath = path.join(projectDir, '.mcp.json');
      if (!existsSync(mcpPath)) throw new Error('no .mcp.json in the project');
      const config = JSON.parse(readFileSync(mcpPath, 'utf8'));
      const server = config.mcpServers?.dql;
      if (!server) throw new Error(`.mcp.json has no mcpServers.dql: ${JSON.stringify(config).slice(0, 300)}`);
      return `.mcp.json mcpServers.dql: ${server.command} ${(server.args ?? []).join(' ')}`;
    }, { evidence: `logs/${logName('connect')}` });

    await gate.check(area, 'zlens mcp test passes with the workbench up', async () => {
      const result = await sh('npx zlens mcp test', { cwd: projectDir, env: runtimeEnv, logFile: log('mcp-test-up') });
      expectRun(result, 'zlens mcp test (workbench up)', { contains: /Ready/ });
      if (/Not ready/.test(result.output)) throw new Error('printed Not ready');
      return `exit 0, Ready (ZLENS_RUNTIME_URL=${workbench.url})`;
    }, { evidence: `logs/${logName('mcp-test-up')}` });

    await gate.check(area, 'CLI works while the workbench runs (zlens doctor)', async () => {
      const result = await run('npx zlens doctor .', 'doctor-while-running');
      const lockError = /Could not set lock|Conflicting lock/i;
      if (lockError.test(result.output)) {
        throw new Error(`DuckDB lock error while the workbench runs: ${result.output.split('\n').find((line) => lockError.test(line))?.trim()}`);
      }
      const nativeFailure = /✗ (SQLite native module|DuckDB connector package)/.exec(result.output);
      if (nativeFailure) throw new Error(`doctor failed its ${nativeFailure[1]} check`);
      return `exit ${result.status}, no DuckDB lock error; SQLite native module and DuckDB driver checks pass`;
    }, { evidence: `logs/${logName('doctor-while-running')}` });
  } finally {
    await workbench.stop();
  }

  await gate.check(area, 'zlens mcp test fails with the workbench down', async () => {
    const result = await sh('npx zlens mcp test', { cwd: projectDir, env: runtimeEnv, logFile: log('mcp-test-down') });
    if (result.status === 0) throw new Error('exit 0 with no workbench running');
    if (!/Not ready/.test(result.output)) throw new Error(`exit ${result.status} but no "Not ready" summary`);
    return `exit ${result.status}, Not ready with Fix: lines`;
  }, { evidence: `logs/${logName('mcp-test-down')}` });
}

async function createFlow(gate, ctx, lane) {
  const { version } = ctx;
  const { env } = lane;
  const area = `create · ${lane.label}`;
  const workDir = path.join(gate.out, lane.id, 'create', 'empty');
  mkdirSync(workDir, { recursive: true });
  const logName = `${lane.id}-create.log`;
  const log = path.join(gate.logs, logName);
  const appDir = path.join(workDir, 'my-analytics');
  const created = await gate.check(area, `npx create-zlens-app@${version} my-analytics --warehouse duckdb (empty folder)`, async () => {
    const result = await sh(`npx --yes create-zlens-app@${version} my-analytics --warehouse duckdb`, { cwd: workDir, env, logFile: log });
    expectRun(result, 'create-zlens-app');
    const config = JSON.parse(readFileSync(path.join(appDir, 'dql.config.json'), 'utf8'));
    const problems = [];
    if (config.modeling?.mode !== 'warehouse-first') problems.push(`modeling.mode=${config.modeling?.mode}`);
    if (config.dbt) problems.push('has a dbt block');
    const connection = config.connections?.[config.defaultConnectionName ?? 'default'] ?? config.connections?.default;
    if (connection?.driver !== 'duckdb') problems.push(`default connection driver=${connection?.driver}`);
    const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    const range = pkg.devDependencies?.['@zlens/cli'];
    if (!rangeAllows(range, version)) problems.push(`@zlens/cli range ${range} does not install ${version}`);
    if (!/zlens sync warehouse/.test(pkg.scripts?.sync ?? '')) problems.push(`npm run sync is "${pkg.scripts?.sync}"`);
    if (pkg.allowScripts?.['better-sqlite3'] !== true) problems.push('package.json does not allow better-sqlite3\'s install script (npm 12)');
    if (problems.length) throw new Error(problems.join('; '));
    return `warehouse-first, duckdb default connection, @zlens/cli ${range}, sync = ${pkg.scripts.sync}, allowScripts better-sqlite3`;
  }, { evidence: `logs/${logName}` });
  if (!created) return;
  if (!(await gate.check(area, 'npm install in the new project; zlens runs; better-sqlite3 loads', async () => {
    const install = await sh('npm install', { cwd: appDir, env, logFile: log });
    expectRun(install, 'npm install');
    const blocked = blockedScripts(install.output);
    if (blocked.length) throw new Error(`npm blocked the install script of ${blocked.join(', ')}`);
    const zlens = await sh('npx zlens --version', { cwd: appDir, env, logFile: log });
    expectRun(zlens, 'npx zlens --version');
    if (versionLine(zlens.output) !== `zlens ${version}`) throw new Error(`npx zlens --version says ${versionLine(zlens.output)}`);
    expectRun(await sh(LOAD_SQLITE, { cwd: appDir, env, logFile: log }), 'require better-sqlite3 + open :memory:');
    return `${versionLine(zlens.output)}; better-sqlite3 opens a database`;
  }, { evidence: `logs/${logName}` }))) return;
  await gate.check(area, "README's manual driver install (@duckdb/node-api 1.5); it loads", async () => {
    const install = await sh("npm install --prefix .dql/connectors '@duckdb/node-api@^1.5.6-r.1'", { cwd: appDir, env, logFile: log });
    expectRun(install, '@duckdb/node-api driver install');
    const blocked = blockedScripts(install.output);
    if (blocked.length) throw new Error(`npm blocked the install script of ${blocked.join(', ')}`);
    const loaded = await sh(LOAD_DUCKDB, { cwd: appDir, env, logFile: log });
    expectRun(loaded, 'require .dql/connectors @duckdb/node-api + open :memory:', { contains: DUCKDB_LINE });
    return `no install script; ${loaded.output.trim().split('\n').find((line) => line.startsWith('duckdb loads'))}`;
  }, { evidence: `logs/${logName}` });
}

function writeSummary(gate, meta) {
  const failed = gate.rows.filter((row) => row.status === 'fail');
  const escape = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# ZLens launch gate — ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length} failed)`}`,
    '',
    `- commit: ${meta.sha}${meta.dirty ? ' (with uncommitted changes)' : ''}`,
    `- version: ${meta.version} (packed tarballs served from a local registry)`,
    `- started: ${meta.started}, finished: ${new Date().toISOString()}`,
    `- npm lanes: ${meta.lanes.length ? meta.lanes.map((lane) => `${lane.label} = npm ${lane.npmVersion} on node ${lane.nodeVersion}`).join('; ') : 'none could be set up'}`,
    `- gate node ${process.version}; commands hidden from the clean shell: ${meta.removed.length ? meta.removed.join(', ') : 'none'}`,
    '',
    '| # | Area | Check | Result | Detail | Evidence |',
    '|---|---|---|---|---|---|',
    ...gate.rows.map((row, index) => `| ${index + 1} | ${row.area} | ${escape(row.check)} | ${row.status.toUpperCase()} | ${escape(row.detail).slice(0, 400)} | ${row.evidence} |`),
    '',
  ];
  writeFileSync(path.join(gate.out, 'summary.md'), lines.join('\n'));
  writeFileSync(path.join(gate.out, 'summary.json'), `${JSON.stringify({ ...meta, rows: gate.rows }, null, 2)}\n`);
  return failed.length;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseGateArguments(argv);
  if (options.help) {
    console.log(readFileSync(path.join(repoRoot, 'scripts/launch-gate/README.md'), 'utf8'));
    return 0;
  }
  mkdirSync(options.out, { recursive: true });
  const gate = new Gate(options.out);
  const started = new Date().toISOString();
  console.log(`\nZLens launch gate → ${options.out}\n`);

  const { version, sha, dirty, packDir } = await packTarballs(gate, options);
  let nextPort = options.port;
  const registryPort = await freePort(nextPort);
  nextPort = registryPort + 1;
  const registry = await startLocalRegistry({ tarballDir: packDir, port: registryPort, log: (line) => writeFileSync(path.join(gate.logs, 'registry.log'), `${line}\n`, { flag: 'a' }) });
  const shims = path.join(options.out, 'shims');
  mkdirSync(shims, { recursive: true });
  // `zlens notebook` opens a browser with open/xdg-open; the gate's browser is Playwright.
  for (const name of ['open', 'xdg-open']) writeFileSync(path.join(shims, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const { env: machineEnv, removed } = cleanEnv({ out: options.out, registryUrl: registry.url, shims });

  await gate.check('machine', 'prerequisites: node 20+, git, python, claude CLI', async () => {
    const node = await sh('node --version', { cwd: options.out, env: machineEnv });
    if (Number(node.output.trim().replace(/^v/, '').split('.')[0]) < 20) throw new Error(`node ${node.output.trim()}`);
    expectRun(await sh('git --version', { cwd: options.out, env: machineEnv }), 'git --version');
    const python = await sh(`${options.python} --version`, { cwd: options.out, env: machineEnv });
    expectRun(python, `${options.python} --version`);
    const claude = await sh('claude --version', { cwd: options.out, env: machineEnv });
    expectRun(claude, 'claude --version (the claude-code provider runs the local claude CLI)');
    return `node ${node.output.trim()}, ${python.output.trim()}, claude ${claude.output.trim()}`;
  });

  const lanes = await prepareLanes(gate, options, { registryUrl: registry.url, shims });
  const ctx = { registryUrl: registry.url, version, options, nextPort: () => { const port = nextPort; nextPort += 1; return port; } };
  try {
    for (const lane of lanes) {
      for (const sample of ['dbt', 'warehouse']) {
        if (!options.only.has(sample)) continue;
        console.log(`\n▸ ${sample} sample · ${lane.label} (npm ${lane.npmVersion}, node ${lane.nodeVersion})`);
        await sampleFlow(gate, sample, ctx, lane);
      }
      if (options.only.has('create')) {
        console.log(`\n▸ create-zlens-app · ${lane.label}`);
        await createFlow(gate, ctx, lane);
      }
    }
  } finally {
    await registry.stop();
    writeFileSync(path.join(gate.logs, 'registry-requests.log'), `${registry.requests.join('\n')}\n`);
  }

  const failed = writeSummary(gate, {
    sha, dirty, version, started, removed, out: options.out,
    lanes: lanes.map(({ id, label, npmVersion, nodeVersion }) => ({ id, label, npmVersion, nodeVersion })),
  });
  console.log(`\n${readFileSync(path.join(options.out, 'summary.md'), 'utf8')}`);
  console.log(failed === 0 ? '✓ launch gate passed' : `✗ launch gate: ${failed} check(s) failed`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Exit explicitly: pooled upstream connections from the registry's fetches
  // would otherwise keep the process alive after the summary.
  main().then((code) => process.exit(code), (error) => {
    console.error(`launch gate error: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(2);
  });
}
