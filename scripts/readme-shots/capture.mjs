#!/usr/bin/env node
// Retake the README screenshots (docs/assets/readme/*.png) from the real
// product: the CLI built from this checkout, `zlens notebook` serving the
// Jaffle Shop DuckDB sample, and a real AI provider for Ask. Nothing is
// mocked: every answer, label and number in the images is what the product
// showed during the run. See scripts/readme-shots/README.md.
//
//   pnpm exec turbo run build --filter=@zlens/cli...
//   node scripts/readme-shots/capture.mjs [--sample <dbt-built clone>] [options]

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const cliEntry = join(repoRoot, 'apps/cli/dist/index.js');

const SAMPLE_REPO = 'https://github.com/duckcode-ai/jaffle-shop-duckdb.git';
const SAMPLE_COMMIT = 'a9ec27779995708d961a6cfcad9ee5c049573e6e';
const DUCKDB_VERSION = '1.1.3';
const SAMPLE_OWNER = 'analytics@jaffle.shop';

const { values: args } = parseArgs({
  options: {
    sample: { type: 'string' },
    'work-dir': { type: 'string', default: join(repoRoot, 'node_modules/.cache/zlens-readme-shots') },
    out: { type: 'string', default: join(repoRoot, 'docs/assets/readme') },
    port: { type: 'string', default: '3490' },
    provider: { type: 'string', default: 'claude-code' },
    model: { type: 'string' },
    'ollama-host': { type: 'string', default: 'http://localhost:11434' },
    only: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

const workDir = resolve(args['work-dir']);
const outDir = resolve(args.out);
const port = Number(args.port);
const baseUrl = `http://127.0.0.1:${port}`;

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed (exit ${result.status ?? 'none'})`);
}

function capture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function onPath(binary) {
  return spawnSync('sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' }).status === 0;
}

// --- 1. The sample project --------------------------------------------------

function findPython() {
  for (const candidate of [process.env.PYTHON, 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3'].filter(Boolean)) {
    const version = capture(candidate, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
    if (!version) continue;
    const [major, minor] = version.split('.').map(Number);
    if (major === 3 && minor >= 9 && minor <= 13) return candidate;
  }
  throw new Error('Building the sample needs Python 3.9-3.13 for dbt-duckdb (or pass --sample <dir>).');
}

/** Clone and dbt-build the sample the way docs/get-started/index.md does. */
function buildSample() {
  const cloneDir = join(workDir, 'jaffle-shop-duckdb');
  const stamp = join(cloneDir, '.readme-shots-built');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === SAMPLE_COMMIT) return cloneDir;
  mkdirSync(workDir, { recursive: true });
  if (!existsSync(join(cloneDir, '.git'))) run('git', ['clone', '--quiet', SAMPLE_REPO, cloneDir]);
  if (capture('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }) !== SAMPLE_COMMIT) {
    run('git', ['fetch', '--quiet', 'origin'], { cwd: cloneDir });
    run('git', ['checkout', '--quiet', '--force', SAMPLE_COMMIT], { cwd: cloneDir });
  }
  const venvPython = join(cloneDir, '.venv/bin/python');
  if (!existsSync(venvPython)) run(findPython(), ['-m', 'venv', '.venv'], { cwd: cloneDir });
  run(venvPython, ['-m', 'pip', 'install', '--quiet', '-r', 'requirements.txt'], { cwd: cloneDir });
  const dbt = join(cloneDir, '.venv/bin/dbt');
  const env = { ...process.env, DBT_SEND_ANONYMOUS_USAGE_STATS: 'false' };
  run(dbt, ['deps', '--profiles-dir', '.'], { cwd: cloneDir, env });
  run(dbt, ['seed', '--full-refresh', '--profiles-dir', '.'], { cwd: cloneDir, env });
  run(dbt, ['build', '--profiles-dir', '.', '--exclude', 'resource_type:seed'], { cwd: cloneDir, env });
  writeFileSync(stamp, `${SAMPLE_COMMIT}\n`);
  return cloneDir;
}

const COPY_EXCLUDES = new Set(['.git', '.venv', 'dbt_packages', 'logs', 'node_modules', '.dql', 'dql', 'dql-manifest.json', '.readme-shots-built']);

function prepareProject(sampleDir) {
  if (!existsSync(join(sampleDir, 'jaffle_shop.duckdb')) || !existsSync(join(sampleDir, 'target/manifest.json'))) {
    throw new Error(`${sampleDir} is not a dbt-built Jaffle Shop sample (jaffle_shop.duckdb and target/manifest.json are missing).`);
  }
  const projectDir = join(workDir, 'project');
  rmSync(projectDir, { recursive: true, force: true });
  cpSync(sampleDir, projectDir, {
    recursive: true,
    filter: (source) => !COPY_EXCLUDES.has(relative(sampleDir, source).split('/')[0] ?? ''),
  });

  // The DuckDB driver, installed once and copied in (as the Connections page installs it).
  const connectorCache = join(workDir, 'connectors');
  if (!existsSync(join(connectorCache, 'node_modules/duckdb'))) {
    mkdirSync(connectorCache, { recursive: true });
    writeFileSync(join(connectorCache, 'package.json'), '{"private":true}\n');
    run('npm', ['--prefix', connectorCache, 'install', '--no-save', '--no-package-lock', '--workspaces=false', `duckdb@${DUCKDB_VERSION}`]);
  }
  cpSync(connectorCache, join(projectDir, '.dql/connectors'), { recursive: true });

  // The AI provider Ask uses, written the way Settings -> AI provider saves it.
  const provider = { id: args.provider, enabled: true, updatedAt: new Date().toISOString() };
  if (args.provider === 'ollama') {
    if (!args.model) throw new Error('--provider ollama needs --model <name>');
    Object.assign(provider, { baseUrl: args['ollama-host'], model: args.model });
  } else if (args.model) {
    provider.model = args.model;
  }
  writeFileSync(join(projectDir, '.dql/provider-settings.json'), `${JSON.stringify({ version: 1, activeProvider: args.provider, providers: { [args.provider]: provider } }, null, 2)}\n`);

  // Every git identity the run sees is the sample's analyst, never yours.
  const gitConfig = join(workDir, 'gitconfig');
  writeFileSync(gitConfig, `[user]\n\tname = Jaffle Analyst\n\temail = ${SAMPLE_OWNER}\n[init]\n\tdefaultBranch = main\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };

  run('node', [cliEntry, 'compile', '.'], { cwd: projectDir, env, stdio: 'ignore' });
  run('node', [cliEntry, 'sync', 'dbt'], { cwd: projectDir, env });
  run('git', ['init', '--quiet'], { cwd: projectDir, env });
  run('git', ['add', '-A'], { cwd: projectDir, env, stdio: 'ignore' });
  run('git', ['commit', '--quiet', '-m', 'Jaffle Shop sample'], { cwd: projectDir, env });
  return { projectDir, env };
}

// --- 2. The workbench -------------------------------------------------------

async function startNotebook(projectDir, env) {
  const logPath = join(workDir, 'notebook.log');
  const server = spawn('node', [cliEntry, 'notebook', projectDir, '--port', String(port), '--no-open'], {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Native semantic engine only, so a MetricFlow install on this machine cannot change the run.
    env: { ...env, ZLENS_METRICFLOW_BIN: join(workDir, 'no-metricflow/mf') },
  });
  const log = [];
  server.stdout.on('data', (chunk) => log.push(chunk));
  server.stderr.on('data', (chunk) => log.push(chunk));
  const stop = () => new Promise((done) => {
    writeFileSync(logPath, Buffer.concat(log));
    if (server.exitCode !== null) return done();
    server.once('exit', done);
    server.kill('SIGTERM');
    setTimeout(() => { server.kill('SIGKILL'); done(); }, 5000);
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      if ((await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) {
        // Acknowledge Guided Setup the way finishing it does, so the shots land in the product.
        await fetch(`${baseUrl}/api/onboarding/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        return { stop };
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`zlens notebook did not start on ${baseUrl}; see ${logPath}`);
}

// --- 3. The shots -------------------------------------------------------------

const VIEWPORT = { width: 1440, height: 900 };
const ASK_TIMEOUT = 600_000;

async function waitForWorkbench(page) {
  await page.getByRole('button', { name: 'Ask', exact: true }).first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function settle(page, ms = 1200) {
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
  await page.waitForTimeout(ms);
}

async function ask(page, question) {
  await page.getByRole('button', { name: 'New chat' }).click();
  const box = page.getByPlaceholder(/Ask anything about your data/).first();
  await box.fill(question);
  await box.press('Enter');
  await page.getByRole('button', { name: 'How it was answered' }).last().waitFor({ timeout: ASK_TIMEOUT });
}

async function expectText(page, text, timeout = 30_000) {
  await page.getByText(text).first().waitFor({ timeout });
}

/** Each shot: what it shows, how to get there, and the clip (CSS px) to keep. */
const SHOTS = {
  // Hero: an App page, every tile certified, with its Ask box and story.
  async 'app'(page) {
    await page.goto(`${baseUrl}/?app=jaffle-growth&page=overview`);
    await waitForWorkbench(page);
    await expectText(page, 'Answers read this page', 120_000);
    await expectText(page, 'All 4 tiles certified', 120_000);
    await settle(page, 2500);
    return { clip: { x: 44, y: 48, width: VIEWPORT.width - 44, height: VIEWPORT.height - 48 } };
  },

  // Ask, answered from a certified block, with "How it was answered" open.
  async 'ask-certified'(page) {
    await page.goto(baseUrl);
    await waitForWorkbench(page);
    await page.getByRole('button', { name: 'Ask', exact: true }).first().click();
    await ask(page, 'How has revenue changed by month?');
    await expectText(page, 'Certified answer');
    await page.getByRole('button', { name: 'Visualization', exact: true }).last().click();
    await page.getByRole('button', { name: 'How it was answered' }).last().click();
    await expectText(page, 'Answered from a certified saved query.');
    await settle(page, 2000);
    return {};
  },

  // Ask, answered by AI-written SQL: labelled for review and kept as a draft block.
  async 'ask-review'(page) {
    await page.goto(baseUrl);
    await waitForWorkbench(page);
    await page.getByRole('button', { name: 'Ask', exact: true }).first().click();
    await ask(page, 'Which 5 products have the highest supply cost?');
    await expectText(page, 'AI-generated answer');
    await expectText(page, /Saved for review as a draft saved query/);
    // Scroll the thread so the answer's trust line sits at the top of the view.
    await page.getByText('AI-generated answer', { exact: true }).first().evaluate((el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
          node.scrollTop += el.getBoundingClientRect().top - node.getBoundingClientRect().top - 24;
          break;
        }
      }
    });
    await settle(page, 1500);
    return { clip: { x: 292, y: 48, width: VIEWPORT.width - 292, height: VIEWPORT.height - 48 } };
  },

  // A notebook: a SQL cell and its result, then Save Block -> draft -> Certify.
  async 'notebook'(page, state) {
    await page.goto(baseUrl);
    await waitForWorkbench(page);
    await page.getByRole('button', { name: 'Notebooks', exact: true }).first().click();
    await page.getByRole('button', { name: 'New Notebook' }).first().click();
    await page.getByLabel(/Notebook name/i).fill('Customer orders');
    await page.getByRole('button', { name: 'Create notebook' }).last().click();
    await page.getByRole('button', { name: /Create DQL query/ }).first().click();
    await page.getByRole('button', { name: /Switch to SQL cell/ }).first().click();
    await page.locator('.cm-content').first().click();
    await page.keyboard.type('select customer_name, count_lifetime_orders, lifetime_spend\nfrom dev.customers\norder by lifetime_spend desc\nlimit 10');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Enter');
    await expectText(page, 'Success', 60_000);
    await expectText(page, 'Showing 1–10 of 10 rows', 60_000);
    await settle(page, 2500);
    state.notebookOpen = true;
    return {};
  },

  async 'block-certified'(page, state) {
    if (!state.notebookOpen) await SHOTS.notebook(page, state);
    // The cell toolbar shows on hover.
    await page.locator('.cm-content').first().hover();
    await page.getByRole('button', { name: 'Save as saved query', exact: true }).first().click();
    await page.locator('input[value="new_block"]').first().fill('top_customers_by_spend');
    await page.locator('select').filter({ hasText: 'Global / cross-domain' }).first().selectOption({ label: 'Commerce' });
    await page.getByPlaceholder('data-platform@company.com').fill(SAMPLE_OWNER);
    await page.getByPlaceholder('revenue, dashboard').fill('customers, revenue');
    await page.getByPlaceholder('revenue, dashboard').locator('xpath=following::input[1]').fill('Top 10 customers by lifetime spend, with their lifetime order count.');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByRole('button', { name: 'Certify', exact: true }).first().waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Certify', exact: true }).first().click();
    await expectText(page, 'Saved query certified', 120_000);
    await expectText(page, `Certified by ${SAMPLE_OWNER}`);
    await settle(page, 2000);
    return {};
  },

  // Ask about an App: answered from the page's own certified results.
  async 'app-ask'(page) {
    await page.goto(`${baseUrl}/?app=jaffle-growth&page=overview`);
    await waitForWorkbench(page);
    await expectText(page, 'Answers read this page', 120_000);
    await expectText(page, 'All 4 tiles certified', 120_000);
    await page.getByPlaceholder(/Ask about Jaffle Growth Review/).first().fill('Which customer leads the top beverage customers table on this page?');
    await page.getByRole('button', { name: 'Ask', exact: true }).last().click();
    await expectText(page, /every tile it read runs a certified source/, ASK_TIMEOUT);
    await settle(page, 2000);
    return { clip: { x: 44, y: 48, width: VIEWPORT.width - 44, height: 560 } };
  },

  // Lineage: dbt sources -> models -> the certified block -> the App that shows it.
  async 'lineage'(page) {
    await page.goto(baseUrl);
    await waitForWorkbench(page);
    await page.getByRole('button', { name: 'Lineage', exact: true }).first().click();
    await expectText(page, 'Trace lineage');
    await page.getByRole('button', { name: 'monthly_revenue', exact: true }).click();
    await page.locator('.react-flow__node', { hasText: 'Jaffle Growth Review' }).first().waitFor();
    await page.waitForTimeout(800);
    await page.locator('.react-flow__node', { hasText: 'monthly_revenue' }).first().click();
    await expectText(page, /4 upstream/);
    await settle(page, 1500);
    // The graph, the focused block's card and the status bar; the empty canvas above is cropped.
    return { clip: { x: 44, y: 250, width: VIEWPORT.width - 44, height: VIEWPORT.height - 250 } };
  },
};
const SHOTS_HELP = Object.keys(SHOTS).join(', ');

function optimise(file) {
  if (onPath('pngquant')) {
    run('pngquant', ['--force', '--skip-if-larger', '--quality', '70-95', '--strip', '--output', file, file]);
  } else if (onPath('magick')) {
    run('magick', [file, '-strip', '-dither', 'None', '-colors', '256', `PNG8:${file}`]);
  }
  if (onPath('oxipng')) run('oxipng', ['-q', '-o', '4', '--strip', 'safe', file]);
}

function printHelp() {
  console.log(`Usage: node scripts/readme-shots/capture.mjs [options]

  --sample <dir>       A dbt-built clone of ${SAMPLE_REPO}
                       (default: clone ${SAMPLE_COMMIT.slice(0, 7)} into the work dir and build it)
  --work-dir <dir>     Scratch space (default: node_modules/.cache/zlens-readme-shots)
  --out <dir>          Where the PNGs go (default: docs/assets/readme)
  --port <n>           Notebook port (default: 3490)
  --provider <id>      AI provider for Ask: claude-code (default), codex, ollama
  --model <name>       Model name (required for ollama)
  --only <a,b>         Retake only these shots (${SHOTS_HELP})`);
}


async function main() {
  if (args.help) return printHelp();
  if (!existsSync(cliEntry)) throw new Error(`Build the CLI first: pnpm exec turbo run build --filter=@zlens/cli... (${cliEntry} is missing)`);
  const requireFromNotebook = createRequire(join(repoRoot, 'apps/dql-notebook/package.json'));
  const { chromium } = requireFromNotebook('@playwright/test');

  const wanted = args.only ? args.only.split(',').map((s) => s.trim()) : Object.keys(SHOTS);
  for (const name of wanted) if (!SHOTS[name]) throw new Error(`Unknown shot "${name}" (have: ${SHOTS_HELP})`);

  const sampleDir = args.sample ? resolve(args.sample) : buildSample();
  const { projectDir, env } = prepareProject(sampleDir);
  const server = await startNotebook(projectDir, env);
  const browser = await chromium.launch();
  mkdirSync(outDir, { recursive: true });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const state = {};
    for (const name of wanted) {
      process.stdout.write(`  ${name} … `);
      const started = Date.now();
      const { clip } = await SHOTS[name](page, state);
      const file = join(outDir, `${name}.png`);
      await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
      optimise(file);
      console.log(`${Math.round(statSync(file).size / 1024)} KB, ${Math.round((Date.now() - started) / 1000)} s`);
    }
  } finally {
    await browser.close();
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
