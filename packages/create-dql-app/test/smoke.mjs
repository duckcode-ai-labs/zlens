#!/usr/bin/env node
// Smoke test: scaffold the starter template into a tmp dir, assert the
// expected files exist and placeholder substitution ran. Keeps us honest
// about the 5-minute demo gate — if this test fails, create-zlens-app is
// broken.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, '..', 'bin', 'create-zlens-app.mjs');

function scaffold(template, name, extraEnv = {}) {
  const base = mkdtempSync(join(tmpdir(), 'create-zlens-app-test-'));
  const target = join(base, name);
  const result = spawnSync('node', [BIN, target, '--template', template], {
    encoding: 'utf-8',
    env: { ...process.env, CI: '1', ...extraEnv },
  });
  return { base, target, result };
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

// Must pin the current CLI so a fresh scaffold includes the supported OSS layout
// (install of an older CLI fails there and never links the `dql` binary).
//
// Derived from this package's own version rather than hand-written: every
// release bumps the whole workspace in lockstep, and a hardcoded literal here
// just fails the release gate one version late, every single time.
const EXPECTED_CLI_RANGE = `^${JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
).version}`;

function collectFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) collectFiles(abs, predicate, out);
    else if (predicate(abs)) out.push(abs);
  }
  return out;
}

function assertGeneratedPackage(target) {
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf-8'));
  assert(
    pkg.devDependencies?.['@zlens/cli'] === EXPECTED_CLI_RANGE,
    `package.json uses @zlens/cli ${EXPECTED_CLI_RANGE}`,
  );
  assert(!Object.values(pkg.scripts ?? {}).includes('zlens test'), 'package.json does not use deprecated zlens test');
  // npm 12 blocks dependency install scripts unless allowScripts lists them;
  // better-sqlite3 downloads its native binary in its script.
  assert(pkg.allowScripts?.['better-sqlite3'] === true, 'package.json allows better-sqlite3\'s install script (npm 12)');
  assert(pkg.pnpm?.onlyBuiltDependencies?.includes('better-sqlite3'), 'package.json lets pnpm 10 build better-sqlite3');
  const connectors = JSON.parse(readFileSync(join(target, '.dql', 'connectors', 'package.json'), 'utf-8'));
  assert(connectors.private === true && connectors.allowScripts === undefined, '.dql/connectors/package.json exists and allows no install script (the DuckDB driver has none)');
}

function assertTemplateDqlSyntax(target) {
  const dqlFiles = collectFiles(target, (abs) => abs.endsWith('.dql'));
  for (const file of dqlFiles) {
    const source = readFileSync(file, 'utf-8');
    assert(!/\blifecycle\s*=/.test(source), `${file.slice(target.length + 1)} uses block status, not lifecycle`);
    assert(!/^\s*block\s+[A-Za-z0-9_]+\s*\{/m.test(source), `${file.slice(target.length + 1)} quotes block names`);
  }
}

function assertGitContract(target) {
  const lines = readFileSync(join(target, '.gitignore'), 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim());
  assert(!lines.includes('.dql/') && !lines.includes('/.dql/'), '.gitignore does not hide governed Hint Graph source');
  assert(lines.includes('**/.dql/cache/'), '.gitignore keeps generated Hint Graph indexes local');
  assert(lines.includes('**/.dql/local/'), '.gitignore keeps private local state local');
  assert(!lines.includes('.dql/hints/'), '.gitignore leaves approved hint source visible to Git');
}

// A new project's repository starts on `main` (or the user's init.defaultBranch),
// never git's `master` fallback: a first send would land beside GitHub's `main`.
function runDefaultBranchTest() {
  console.log('\n▸ git default branch');
  for (const [configured, expected] of [['', 'main'], ['trunk', 'trunk']]) {
    const home = mkdtempSync(join(tmpdir(), 'create-zlens-app-gitcfg-'));
    const gitconfig = join(home, '.gitconfig');
    writeFileSync(gitconfig, configured ? `[init]\n\tdefaultBranch = ${configured}\n` : '');
    const { base, target, result } = scaffold('starter', `branch-${expected}`, { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' });
    try {
      assert(result.status === 0, `scaffold exits 0 with init.defaultBranch ${configured || 'unset'}`);
      const head = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: target, encoding: 'utf-8' });
      assert(head.status === 0 && head.stdout.trim() === expected, `new repository starts on ${expected} (got ${head.stdout.trim()})`);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
}

function runTest(template, name, expected, placeholderFile) {
  console.log(`\n▸ template: ${template}`);
  const { base, target, result } = scaffold(template, name);
  try {
    assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
    for (const f of expected) {
      assert(existsSync(join(target, f)), `emits ${f}`);
    }
    const placeholder = readFileSync(join(target, placeholderFile), 'utf-8');
    assert(placeholder.includes(name), `${placeholderFile} got PROJECT_NAME substituted`);
    assert(!placeholder.includes('{{PROJECT_NAME}}'), `${placeholderFile} has no unresolved placeholders`);
    assertGeneratedPackage(target);
    assertTemplateDqlSyntax(target);
    assertGitContract(target);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

runDefaultBranchTest();

runTest('starter', 'smoke-starter', [
  'apps/.gitkeep',
  'domains/.gitkeep',
  'dql.config.json',
  'package.json',
  'README.md',
  'notebooks/welcome.dqlnb',
  'semantic-layer/.gitkeep',
  'skills/.gitkeep',
  'tests/blocks/.gitkeep',
  'tests/agent-evals/.gitkeep',
  '.gitignore',
], 'dql.config.json');

// The default template (no --template flag) must be the starter.
console.log('\n▸ default template');
{
  const base = mkdtempSync(join(tmpdir(), 'create-zlens-app-test-'));
  const target = join(base, 'smoke-default');
  const result = spawnSync('node', [BIN, target], { encoding: 'utf-8', env: { ...process.env, CI: '1' } });
  try {
    assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
    assert(existsSync(join(target, 'dql.config.json')), 'default template emits dql.config.json');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// dbt vs database-only (D3). Every scaffold below runs in its own temp base
// folder, with that folder as the working directory, so no dbt_project.yml
// outside the test leaks into detection.

const DBT_SCRIPTS = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'templates', 'starter', 'package.json'), 'utf-8'),
).scripts;

function withBase(fn) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'create-zlens-app-test-')));
  try {
    fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function run(base, args, { input = '', env = {}, prompt = false } = {}) {
  const childEnv = { ...process.env, CI: '1', ...env };
  delete childEnv.ZLENS_CREATE_APP_PROMPT;
  if (prompt) childEnv.ZLENS_CREATE_APP_PROMPT = '1';
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
  return spawnSync('node', [BIN, ...args], { cwd: base, input, encoding: 'utf-8', env: childEnv });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function assertDbtWorkspace(target, projectDir) {
  const cfg = readJson(join(target, 'dql.config.json'));
  assert(cfg.dbt?.projectDir === projectDir, `dbt.projectDir is ${projectDir} (got ${cfg.dbt?.projectDir})`);
  assert(cfg.dbt?.manifestPath === 'target/manifest.json', 'dbt.manifestPath is target/manifest.json');
  assert(cfg.layout?.mode === 'oss-dbt-workspace', 'layout.mode stays oss-dbt-workspace');
  assert(cfg.manifestVersion === undefined && cfg.modeling === undefined, 'dbt config is unchanged (no manifestVersion/modeling)');
  assert(cfg.connections === undefined, 'dbt config has no connection stub');
  const pkg = readJson(join(target, 'package.json'));
  assert(pkg.scripts.sync === 'zlens sync dbt', 'sync script runs zlens sync dbt');
  assert(readFileSync(join(target, 'README.md'), 'utf-8').includes('## Have a dbt project?'), 'README keeps the dbt section');
  assertGeneratedPackage(target);
}

function assertWarehouseWorkspace(target, driver, expectedConnection) {
  const cfg = readJson(join(target, 'dql.config.json'));
  assert(cfg.manifestVersion === 3, 'manifestVersion is 3');
  assert(cfg.modeling?.mode === 'warehouse-first', 'modeling.mode is warehouse-first');
  assert(!('dbt' in cfg), 'no dbt block');
  assert(cfg.layout?.mode === 'oss-dbt-workspace' && cfg.layout?.skillsPath === 'skills', 'layout matches zlens init --warehouse-first');
  assert(cfg.defaultConnectionName === 'default', 'defaultConnectionName is default');
  assert(cfg.connections?.default?.driver === driver, `connection driver is ${driver}`);
  if (expectedConnection) {
    assert(JSON.stringify(cfg.connections.default) === JSON.stringify(expectedConnection), `connection stub is ${JSON.stringify(expectedConnection)}`);
  }
  for (const [field, value] of Object.entries(cfg.connections.default)) {
    if (/password|token|secret/i.test(field)) {
      assert(/^\$\{[A-Z0-9_]+\}$/.test(String(value)), `${field} is an \${ENV_VAR} placeholder, not a literal`);
    }
  }
  const pkg = readJson(join(target, 'package.json'));
  assert(pkg.scripts.sync === 'zlens sync warehouse', 'sync script runs zlens sync warehouse');
  assert(
    JSON.stringify({ ...pkg.scripts, sync: DBT_SCRIPTS.sync }) === JSON.stringify(DBT_SCRIPTS),
    'every other npm script matches the dbt template',
  );
  const readme = readFileSync(join(target, 'README.md'), 'utf-8');
  assert(!readme.includes('## Have a dbt project?'), 'README drops the dbt section');
  for (const step of ['npm run sync', 'npx zlens sync warehouse --schemas', 'npx zlens model discover --validate', 'Modeling', 'Ask']) {
    assert(readme.includes(step), `README next steps mention ${step}`);
  }
  assert(!readme.includes('{{'), 'README has no unresolved placeholders');
  assertGeneratedPackage(target);
  assertGitContract(target);
}

console.log('\n▸ non-interactive default (no dbt found) is unchanged');
withBase((base) => {
  // CI unset and stdin piped (not a TTY): still no prompt, even with input.
  const result = run(base, ['app'], { input: '2\npostgres\n', env: { CI: undefined } });
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assert(!result.stdout.includes('Choose 1 or 2'), 'does not prompt without a TTY');
  assertDbtWorkspace(join(base, 'app'), '../my-dbt-project');
});

console.log('\n▸ --dbt <path>');
withBase((base) => {
  mkdirSync(join(base, 'analytics-dbt'));
  writeFileSync(join(base, 'analytics-dbt', 'dbt_project.yml'), 'name: analytics\n');
  const result = run(base, ['nested/app', '--dbt', 'analytics-dbt']);
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertDbtWorkspace(join(base, 'nested', 'app'), '../../analytics-dbt');
  assert(result.stdout.includes('using dbt project at'), 'reports the dbt project it used');
});

console.log('\n▸ --dbt <path> without dbt_project.yml warns but wires it');
withBase((base) => {
  const result = run(base, ['app', '--dbt', '../later-dbt']);
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assert(result.stdout.includes('no dbt_project.yml'), 'warns that dbt_project.yml is missing');
  assertDbtWorkspace(join(base, 'app'), '../../later-dbt');
});

console.log('\n▸ dbt auto-detected next to the new folder');
withBase((base) => {
  writeFileSync(join(base, 'dbt_project.yml'), 'name: jaffle\n');
  const result = run(base, ['dql']);
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assert(result.stdout.includes('detected sibling dbt project'), 'reports the detected dbt project');
  assertDbtWorkspace(join(base, 'dql'), '..');
});

console.log('\n▸ dbt auto-detected in the folder it is run from');
withBase((base) => {
  writeFileSync(join(base, 'dbt_project.yml'), 'name: jaffle\n');
  const result = run(base, ['tools/zlens/dql']);
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertDbtWorkspace(join(base, 'tools', 'zlens', 'dql'), '../../..');
});

console.log('\n▸ --warehouse duckdb --database-path');
withBase((base) => {
  const result = run(base, ['app', '--warehouse', 'duckdb', '--database-path', 'data/jaffle_shop.duckdb']);
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertWarehouseWorkspace(join(base, 'app'), 'duckdb', { driver: 'duckdb', filepath: '../data/jaffle_shop.duckdb' });
  assert(!result.stdout.includes('npm install --prefix .dql/connectors'), 'next steps have no separate driver install (sync installs it)');
  assert(readFileSync(join(base, 'app', 'README.md'), 'utf-8').includes("npm install --prefix .dql/connectors '@duckdb/node-api@^1.5.6-r.1'"), 'README names the manual DuckDB driver install on the 1.5 line');
});

console.log('\n▸ --warehouse duckdb (default file), even next to a dbt project');
withBase((base) => {
  writeFileSync(join(base, 'dbt_project.yml'), 'name: jaffle\n');
  const result = run(base, ['app', '--warehouse', 'DuckDB']);
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertWarehouseWorkspace(join(base, 'app'), 'duckdb', { driver: 'duckdb', filepath: './warehouse.duckdb' });
});

console.log('\n▸ --warehouse postgres (alias of postgresql)');
withBase((base) => {
  const result = run(base, ['app', '--warehouse', 'postgres']);
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertWarehouseWorkspace(join(base, 'app'), 'postgresql', {
    driver: 'postgresql', host: '${PGHOST}', port: 5432, database: '${PGDATABASE}', username: '${PGUSER}', password: '${PGPASSWORD}',
  });
  assert(!result.stdout.includes('npm install --prefix .dql/connectors') && result.stdout.includes('installs the driver the first time'), 'next steps say sync installs the pg driver');
});

console.log('\n▸ --warehouse snowflake');
withBase((base) => {
  const result = run(base, ['app', '--warehouse', 'snowflake']);
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertWarehouseWorkspace(join(base, 'app'), 'snowflake', {
    driver: 'snowflake', account: '${SNOWFLAKE_ACCOUNT}', username: '${SNOWFLAKE_USER}', authMethod: 'password',
    password: '${SNOWFLAKE_PASSWORD}', warehouse: '${SNOWFLAKE_WAREHOUSE}', database: '${SNOWFLAKE_DATABASE}',
  });
});

console.log('\n▸ every other --warehouse driver scaffolds');
for (const driver of ['bigquery', 'databricks', 'redshift', 'mysql', 'mssql', 'fabric', 'clickhouse', 'trino', 'athena', 'sqlite']) {
  withBase((base) => {
    const result = run(base, ['app', '--warehouse', driver]);
    assert(result.status === 0, `${driver}: scaffold exits 0 (got ${result.status})`);
    const cfg = readJson(join(base, 'app', 'dql.config.json'));
    assert(cfg.connections?.default?.driver === driver && cfg.modeling?.mode === 'warehouse-first' && !('dbt' in cfg), `${driver}: warehouse-first config with a ${driver} connection`);
  });
}

console.log('\n▸ bad flags fail clearly and write nothing');
withBase((base) => {
  const cases = [
    [['app', '--warehouse', 'oracle'], 'Unknown --warehouse "oracle"'],
    [['app', '--warehouse'], '--warehouse needs a value'],
    [['app', '--dbt', '../x', '--warehouse', 'duckdb'], 'either --dbt or --warehouse'],
    [['app', '--warehouse', 'snowflake', '--database-path', 'x.duckdb'], '--database-path only applies'],
  ];
  for (const [args, message] of cases) {
    const result = run(base, args);
    assert(result.status === 2, `${args.join(' ')} exits 2 (got ${result.status})`);
    assert(result.stderr.includes(message), `${args.join(' ')} says "${message}"`);
    assert(!existsSync(join(base, 'app')), `${args.join(' ')} creates no folder`);
  }
  const unknown = run(base, ['app', '--warehouse', 'oracle']);
  assert(unknown.stderr.includes('duckdb') && unknown.stderr.includes('postgresql'), 'unknown driver error lists the valid drivers');
});

console.log('\n▸ interactive: database only → postgres');
withBase((base) => {
  const result = run(base, ['app'], { prompt: true, input: '2\npostgres\n' });
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assert(result.stdout.includes('Is this workspace for a dbt project, or a database only?'), 'asks dbt project or database only');
  assertWarehouseWorkspace(join(base, 'app'), 'postgresql');
});

console.log('\n▸ interactive: database only → duckdb defaults');
withBase((base) => {
  const result = run(base, ['app'], { prompt: true, input: '2\n\n\n' });
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertWarehouseWorkspace(join(base, 'app'), 'duckdb', { driver: 'duckdb', filepath: './warehouse.duckdb' });
});

console.log('\n▸ interactive: database only → duckdb file path');
withBase((base) => {
  const result = run(base, ['app'], { prompt: true, input: '2\nduckdb\nwarehouse/prod.duckdb\n' });
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertWarehouseWorkspace(join(base, 'app'), 'duckdb', { driver: 'duckdb', filepath: '../warehouse/prod.duckdb' });
});

console.log('\n▸ interactive: bad answers are asked again');
withBase((base) => {
  const result = run(base, ['app'], { prompt: true, input: 'maybe\n2\noracle\nbigquery\n' });
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assert(result.stdout.includes('Please answer 1'), 're-asks after an unclear choice');
  assert(result.stdout.includes('Unknown database "oracle"'), 're-asks after an unknown database');
  assertWarehouseWorkspace(join(base, 'app'), 'bigquery');
});

console.log('\n▸ interactive: dbt project with a path');
withBase((base) => {
  mkdirSync(join(base, 'dbt'));
  writeFileSync(join(base, 'dbt', 'dbt_project.yml'), 'name: shop\n');
  const result = run(base, ['nested/app'], { prompt: true, input: '1\ndbt\n' });
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertDbtWorkspace(join(base, 'nested', 'app'), '../../dbt');
});

console.log('\n▸ interactive: blank answers keep the dbt placeholder');
withBase((base) => {
  const result = run(base, ['app'], { prompt: true, input: '\n\n' });
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertDbtWorkspace(join(base, 'app'), '../my-dbt-project');
});

console.log('\n▸ interactive: stdin closed before an answer keeps the default');
withBase((base) => {
  const result = run(base, ['app'], { prompt: true, input: '' });
  assert(result.status === 0, `scaffold exits 0 (got ${result.status})`);
  assertDbtWorkspace(join(base, 'app'), '../my-dbt-project');
});

console.log('\n✓ all smoke tests passed');
