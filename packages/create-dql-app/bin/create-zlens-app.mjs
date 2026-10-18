#!/usr/bin/env node
// create-zlens-app — self-contained scaffolder.
//
// Contract (from the v1.0 "demo gate"): on a clean machine, `npx
// create-zlens-app` followed by `cd … && npx zlens notebook`
// produces a running notebook in under 5 minutes.
//
// Design: this package writes template files *itself* rather than
// delegating to `zlens init`, so it stays self-contained and installable
// with zero-peer-dep friction. Templates live under ../templates/ and are
// copied verbatim.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename, relative, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version;
const TEMPLATES_DIR = resolve(__dirname, '..', 'templates');

// Tiny ANSI helpers — no dep on chalk/kleur so the bin runs before
// `npm install` finishes on slow machines.
const c = {
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

// Database-only (warehouse-first) workspaces. Driver names and connection
// fields are the ones @zlens/connectors reads (ConnectionConfig) and that
// Settings → Database writes; secrets are `${ENV_VAR}` placeholders, which
// the runtime expands when it connects, so nothing secret lands in git.
// `file` is left out on purpose: it is for ad-hoc CSV/Parquet reads, not a
// warehouse to model.
const CONNECTION_STUBS = {
  duckdb:     { driver: 'duckdb', filepath: './warehouse.duckdb' },
  postgresql: { driver: 'postgresql', host: '${PGHOST}', port: 5432, database: '${PGDATABASE}', username: '${PGUSER}', password: '${PGPASSWORD}' },
  snowflake:  { driver: 'snowflake', account: '${SNOWFLAKE_ACCOUNT}', username: '${SNOWFLAKE_USER}', authMethod: 'password', password: '${SNOWFLAKE_PASSWORD}', warehouse: '${SNOWFLAKE_WAREHOUSE}', database: '${SNOWFLAKE_DATABASE}' },
  bigquery:   { driver: 'bigquery', projectId: '${GOOGLE_CLOUD_PROJECT}', location: 'US', authMethod: 'application_default' },
  databricks: { driver: 'databricks', host: '${DATABRICKS_HOST}', httpPath: '${DATABRICKS_HTTP_PATH}', catalog: 'main', token: '${DATABRICKS_TOKEN}' },
  redshift:   { driver: 'redshift', host: '${REDSHIFT_HOST}', port: 5439, database: '${REDSHIFT_DATABASE}', username: '${REDSHIFT_USER}', password: '${REDSHIFT_PASSWORD}' },
  mysql:      { driver: 'mysql', host: '${MYSQL_HOST}', port: 3306, database: '${MYSQL_DATABASE}', username: '${MYSQL_USER}', password: '${MYSQL_PASSWORD}' },
  mssql:      { driver: 'mssql', host: '${MSSQL_HOST}', database: '${MSSQL_DATABASE}', authMethod: 'password', username: '${MSSQL_USER}', password: '${MSSQL_PASSWORD}' },
  fabric:     { driver: 'fabric', host: '${FABRIC_SQL_ENDPOINT}', database: '${FABRIC_DATABASE}', authMethod: 'azure_default' },
  clickhouse: { driver: 'clickhouse', host: '${CLICKHOUSE_HOST}', ssl: true, database: 'default', username: '${CLICKHOUSE_USER}', password: '${CLICKHOUSE_PASSWORD}' },
  trino:      { driver: 'trino', host: '${TRINO_HOST}', port: 443, ssl: true, catalog: '${TRINO_CATALOG}', username: '${TRINO_USER}', password: '${TRINO_PASSWORD}' },
  athena:     { driver: 'athena', region: '${AWS_REGION}', workgroup: 'primary', database: '${ATHENA_DATABASE}', outputLocation: '${ATHENA_OUTPUT_LOCATION}', authMethod: 'aws_default' },
  sqlite:     { driver: 'sqlite', filepath: './data/app.sqlite' },
};
const WAREHOUSE_DRIVERS = Object.keys(CONNECTION_STUBS);
const DRIVER_ALIASES = { postgres: 'postgresql' };
const FILE_DRIVERS = new Set(['duckdb', 'sqlite']);
// The project-local package each driver needs (none = built in).
const DRIVER_PACKAGES = {
  duckdb: 'duckdb',
  postgresql: 'pg',
  redshift: 'pg',
  snowflake: 'snowflake-sdk',
  bigquery: '@google-cloud/bigquery',
  mysql: 'mysql2',
  mssql: 'mssql',
  fabric: 'mssql',
  athena: '@aws-sdk/client-athena',
};

function normalizeDriver(value) {
  const key = String(value ?? '').trim().toLowerCase();
  const driver = DRIVER_ALIASES[key] ?? key;
  return WAREHOUSE_DRIVERS.includes(driver) ? driver : null;
}

function usage() {
  console.log(`create-zlens-app ${VERSION}

Usage:
  npx create-zlens-app@latest <project-dir> [options]

Options:
  --dbt <path>             Use the dbt project at <path> (the folder with dbt_project.yml)
  --warehouse <driver>     Database only, no dbt: model warehouse tables directly.
                           Drivers: ${WAREHOUSE_DRIVERS.join(', ')}
                           (postgres is accepted for postgresql)
  --database-path <file>   With --warehouse duckdb or sqlite: the database file
  --template <name>        Starter template (default: starter)
  --help, -h               Show this help
  --version, -v            Show version

Without --dbt or --warehouse, a dbt project next to the new folder (or next
to where you run this) is wired in. If none is found, an interactive run asks
"dbt project or database only?"; a non-interactive run (CI, piped input)
writes a dbt config pointing at ../my-dbt-project for you to edit.

Examples:
  npx create-zlens-app@latest my-analytics
  npx create-zlens-app@latest dql --template starter   # inside your dbt repo
  npx create-zlens-app@latest my-analytics --dbt ../my-dbt-project
  npx create-zlens-app@latest my-analytics --warehouse snowflake
  npx create-zlens-app@latest my-analytics --warehouse duckdb --database-path ./warehouse.duckdb

Want a ready-made dbt project to try ZLens on?
  git clone https://github.com/duckcode-ai/jaffle-shop-duckdb
`);
}

function fail(message, code = 2) {
  console.error(c.red(`✗ ${message}`));
  process.exit(code);
}

function needValue(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value.`);
  return value;
}

function parseArgs(argv) {
  const args = { dir: null, template: 'starter', dbt: null, warehouse: null, databasePath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    if (a === '--version' || a === '-v') { console.log(VERSION); process.exit(0); }
    if (a === '--template') { args.template = argv[++i]; continue; }
    if (a === '--dbt') { args.dbt = needValue(argv, i, a); i++; continue; }
    if (a === '--warehouse') { args.warehouse = needValue(argv, i, a); i++; continue; }
    if (a === '--database-path') { args.databasePath = needValue(argv, i, a); i++; continue; }
    if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    if (!args.dir) args.dir = a;
  }
  if (args.dbt && args.warehouse) fail('Use either --dbt or --warehouse, not both.');
  if (args.warehouse) {
    const driver = normalizeDriver(args.warehouse);
    if (!driver) {
      fail(`Unknown --warehouse "${args.warehouse}". Use one of: ${WAREHOUSE_DRIVERS.join(', ')} (or postgres for postgresql).`);
    }
    args.warehouse = driver;
  }
  if (args.databasePath && !FILE_DRIVERS.has(args.warehouse ?? '')) {
    fail('--database-path only applies with --warehouse duckdb or --warehouse sqlite.');
  }
  return args;
}

function isEmptyDir(dir) {
  try { return readdirSync(dir).length === 0; } catch { return true; }
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    // npm strips .gitignore files from published tarballs, so templates ship
    // it as "gitignore" and we restore the dot on scaffold.
    const d = join(dst, entry === 'gitignore' ? '.gitignore' : entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

function substitute(file, vars) {
  const raw = readFileSync(file, 'utf-8');
  const out = raw.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
  if (out !== raw) writeFileSync(file, out, 'utf-8');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function detectDbtSibling(target, cwd = process.cwd()) {
  // Walk up 2 levels looking for a dbt_project.yml — common layout is
  // myproject/dql + myproject/dbt, or myproject with dbt + dql as siblings.
  // Then the folder this is run from and its parent, as `zlens init` does,
  // for a nested target such as `npx create-zlens-app tools/dql`.
  const probes = [
    ...['..', '../..', '../dbt', '../../dbt'].map((rel) => resolve(target, rel)),
    resolve(cwd),
    resolve(cwd, '..'),
  ];
  for (const dir of probes) {
    if (existsSync(join(dir, 'dbt_project.yml'))) return dir;
  }
  return null;
}

function detectPackageManager() {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm/')) return 'pnpm';
  if (ua.startsWith('yarn/')) return 'yarn';
  return 'npm';
}

// Ask only when a person is at the keyboard. CI and piped runs keep the
// non-interactive default. ZLENS_CREATE_APP_PROMPT=1 forces the questions
// (answers read line by line from stdin) — used by the tests.
function canPrompt() {
  if (process.env.ZLENS_CREATE_APP_PROMPT === '1') return true;
  if (process.env.CI) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function createPrompter() {
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal });
  // Without a listener, Ctrl-C at a question only pauses readline; quit
  // instead, before anything has been written.
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    rl.close();
    process.exit(130);
  });
  // The async iterator buffers lines, so piped answers that arrive before
  // the question is asked are not lost.
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question) {
      rl.setPrompt(question);
      rl.prompt();
      const { value, done } = await lines.next();
      if (!terminal) process.stdout.write('\n');
      return done ? null : String(value).trim();
    },
    close() { rl.close(); },
  };
}

/**
 * No dbt project was found: ask "dbt project or database only?".
 * Returns a mode, or null when stdin closed (the caller then keeps the
 * non-interactive default).
 */
async function promptForMode(target, prompter) {
  console.log(`  No dbt project found next to ${c.bold(basename(target))}.`);
  console.log('  Is this workspace for a dbt project, or a database only?');
  console.log('    1) dbt project');
  console.log('    2) database only (no dbt): model your warehouse tables directly');
  let choice = null;
  for (let tries = 0; tries < 3 && choice === null; tries++) {
    const answer = await prompter.ask('  Choose 1 or 2 [1]: ');
    if (answer === null) return null;
    const a = answer.toLowerCase();
    if (a === '' || a === '1' || a === 'dbt' || a === 'dbt project') choice = 'dbt';
    else if (a === '2' || a === 'database' || a === 'database only' || a === 'db') choice = 'warehouse';
    else console.log(c.yellow('  Please answer 1 (dbt project) or 2 (database only).'));
  }
  if (choice === null) fail('No choice made. Re-run with --dbt <path> or --warehouse <driver>.');

  if (choice === 'dbt') {
    const answer = await prompter.ask('  Path to your dbt project (the folder with dbt_project.yml) [../my-dbt-project]: ');
    if (answer === null) return null;
    return { kind: 'dbt', dbtDir: answer ? resolve(process.cwd(), answer) : null, source: 'prompt' };
  }

  let driver = null;
  for (let tries = 0; tries < 3 && driver === null; tries++) {
    const answer = await prompter.ask(`  Database (${WAREHOUSE_DRIVERS.join(', ')}) [duckdb]: `);
    if (answer === null) return null;
    driver = normalizeDriver(answer === '' ? 'duckdb' : answer);
    if (!driver) console.log(c.yellow(`  Unknown database "${answer}". Use one of: ${WAREHOUSE_DRIVERS.join(', ')}.`));
  }
  if (driver === null) fail(`No database chosen. Re-run with --warehouse <driver> (one of: ${WAREHOUSE_DRIVERS.join(', ')}).`);

  let databasePath = null;
  if (FILE_DRIVERS.has(driver)) {
    const fallback = CONNECTION_STUBS[driver].filepath.replace(/^\.\//, '');
    const answer = await prompter.ask(`  Path to the ${driver === 'duckdb' ? 'DuckDB' : 'SQLite'} file, from this folder [${basename(target)}/${fallback}]: `);
    if (answer === null) return null;
    if (answer) databasePath = resolve(process.cwd(), answer);
  }
  return { kind: 'warehouse', driver, databasePath };
}

function warehouseConnection(target, driver, databasePath) {
  const connection = { ...CONNECTION_STUBS[driver] };
  if (databasePath) {
    // Stored relative to the project (the runtime resolves it from there),
    // so dql.config.json stays portable.
    const rel = relative(target, databasePath);
    connection.filepath = rel.startsWith('..') || isAbsolute(rel) ? rel : `./${rel}`;
  }
  return connection;
}

// npm 12 blocks a dependency's install script unless package.json lists it
// in "allowScripts" (the template's own package.json allows better-sqlite3).
// duckdb downloads its native binary in that script, so the driver folder
// gets a package.json that allows it before anyone installs there; ZLens
// writes the same file when it installs a driver itself.
const NATIVE_DRIVER_PACKAGES = ['duckdb'];

function seedConnectorFolder(target) {
  const dir = join(target, '.dql', 'connectors');
  mkdirSync(dir, { recursive: true });
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) return;
  const pkg = {
    private: true,
    description: 'Project-local ZLens connector packages',
    allowScripts: Object.fromEntries(NATIVE_DRIVER_PACKAGES.map((name) => [name, true])),
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

function connectorInstall(pkg) {
  // Drivers always install with npm (it ships with Node): pnpm 10 skips
  // duckdb's native build script and Yarn Berry has no --prefix equivalent,
  // so neither yields a driver the runtime can load from .dql/connectors.
  return `npm install --prefix .dql/connectors ${pkg}`;
}

function warehouseReadmeSection(driver, connection) {
  const pkg = DRIVER_PACKAGES[driver];
  const secrets = Object.values(connection)
    .filter((v) => typeof v === 'string')
    .flatMap((v) => [...v.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]));
  const fill = FILE_DRIVERS.has(driver)
    ? `Check \`filepath\` in the \`default\` connection in \`dql.config.json\` (driver \`${driver}\`); a relative path is read from this folder.`
    : `Fill in the \`default\` connection in \`dql.config.json\` (driver \`${driver}\`). The \`\${...}\` values (${secrets.map((name) => `\`${name}\``).join(', ')}) are read from environment variables when ZLens connects, so secrets stay out of git. Set them, or edit the connection in the notebook under Settings → Database, which keeps typed secrets in a git-ignored file.`;
  const install = pkg
    ? `\n   Install the driver once:\n\n   \`\`\`bash\n   ${connectorInstall(pkg)}\n   \`\`\`\n`
    : '\n   This driver is built in; nothing else to install.\n';
  return `## Database only (no dbt)

This workspace models your warehouse tables directly: \`dql.config.json\` sets
\`"modeling": { "mode": "warehouse-first" }\` and has no dbt block.

1. ${fill}
${install}
2. Read the warehouse's tables, columns and keys (metadata only, never rows).
   The first time, name the schemas to model; \`npm run sync\` reuses that
   choice afterwards:

   \`\`\`bash
   npx zlens sync warehouse --schemas <schema>[,<schema>]
   npm run sync
   \`\`\`

3. Preview the entities and relationships ZLens would draft from what was
   read, with each join checked on the warehouse:

   \`\`\`bash
   npx zlens model discover --validate
   \`\`\`

4. Run \`npm run notebook\`, open Modeling and choose **Draft from warehouse**,
   then review and certify the drafts.
5. Ask questions in Ask. Answers use what you certified.

Have a dbt project after all? Re-scaffold with
\`npx create-zlens-app <dir> --dbt <path-to-dbt-project>\`.
`;
}

function applyWarehouseMode(target, driver, connection) {
  const configPath = join(target, 'dql.config.json');
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
  const { project, dbt: _dbt, layout, semanticLayer, ...rest } = cfg;
  const out = {
    project,
    // RFC 0007, as `zlens init --warehouse-first` writes it.
    manifestVersion: 3,
    modeling: { mode: 'warehouse-first' },
    layout,
    semanticLayer,
    defaultConnectionName: 'default',
    connections: { default: connection },
    ...rest,
  };
  writeFileSync(configPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');

  const pkgPath = join(target, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.scripts = { ...pkg.scripts, sync: 'zlens sync warehouse' };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

  const readmePath = join(target, 'README.md');
  const readme = readFileSync(readmePath, 'utf-8');
  const marker = readme.indexOf('## Have a dbt project?');
  const head = marker >= 0 ? readme.slice(0, marker) : `${readme.trimEnd()}\n\n`;
  writeFileSync(readmePath, head + warehouseReadmeSection(driver, connection), 'utf-8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Error: project directory is required.\n');
    usage();
    process.exit(2);
  }

  const target = resolve(process.cwd(), args.dir);
  const projectName = basename(target);

  if (existsSync(target) && !isEmptyDir(target)) {
    console.error(c.red(`✗ Target directory "${args.dir}" exists and is not empty.`));
    process.exit(1);
  }

  const tplDir = join(TEMPLATES_DIR, args.template);
  if (!existsSync(tplDir)) {
    console.error(c.red(`✗ Unknown template: ${args.template}`));
    console.error(`   Available: ${readdirSync(TEMPLATES_DIR).join(', ')}`);
    process.exit(1);
  }

  console.log(c.cyan(`\n⌁ create-zlens-app ${VERSION}`));
  console.log(`  scaffolding ${c.bold(projectName)} (template: ${c.bold(args.template)})\n`);

  // Decide dbt vs database-only before writing anything.
  //   { kind: 'dbt', dbtDir: <abs path> | null (placeholder), source }
  //   { kind: 'warehouse', driver, databasePath: <abs path> | null }
  let mode;
  if (args.warehouse) {
    mode = { kind: 'warehouse', driver: args.warehouse, databasePath: args.databasePath ? resolve(process.cwd(), args.databasePath) : null };
  } else if (args.dbt) {
    mode = { kind: 'dbt', dbtDir: resolve(process.cwd(), args.dbt), source: 'flag' };
  } else {
    const detected = detectDbtSibling(target);
    if (detected) {
      mode = { kind: 'dbt', dbtDir: detected, source: 'detected' };
    } else if (canPrompt()) {
      const prompter = createPrompter();
      try {
        mode = await promptForMode(target, prompter);
      } finally {
        prompter.close();
      }
      if (mode) console.log('');
    }
    // Non-interactive (or stdin closed): today's default, a dbt config
    // pointing at the ../my-dbt-project placeholder.
    mode ??= { kind: 'dbt', dbtDir: null, source: 'placeholder' };
  }

  if (mode.kind === 'dbt' && mode.dbtDir && mode.source !== 'detected' && !existsSync(join(mode.dbtDir, 'dbt_project.yml'))) {
    console.log(c.yellow(`  ! no dbt_project.yml in ${mode.dbtDir} yet; wiring it anyway\n`));
  }
  if (mode.kind === 'warehouse' && mode.databasePath && !existsSync(mode.databasePath)) {
    console.log(c.yellow(`  ! ${mode.databasePath} does not exist yet; ${mode.driver === 'duckdb' ? 'DuckDB creates it on first use' : 'create it before syncing'}\n`));
  }

  copyDir(tplDir, target);
  seedConnectorFolder(target);

  const dbtSibling = mode.kind === 'dbt' ? mode.dbtDir : null;
  // Store dbt path as relative-to-project — keeps dql.config.json portable.
  const dbtRel = dbtSibling ? (relative(target, dbtSibling) || '.') : '../my-dbt-project';
  const vars = {
    PROJECT_NAME: projectName,
    YEAR: String(new Date().getFullYear()),
    DBT_PROJECT_DIR: dbtRel,
    DBT_DETECTED: dbtSibling ? 'true' : 'false',
  };
  for (const f of walk(target)) substitute(f, vars);

  let connection = null;
  if (mode.kind === 'warehouse') {
    connection = warehouseConnection(target, mode.driver, mode.databasePath);
    applyWarehouseMode(target, mode.driver, connection);
    console.log(c.dim(`  database only (no dbt): ${mode.driver} connection "default" in dql.config.json`));
    console.log(c.dim('  modeling: manifest v3, warehouse-first'));
    console.log('');
  } else if (mode.source === 'detected') {
    console.log(c.dim(`  detected sibling dbt project at ${dbtSibling}`));
    console.log(c.dim(`  wired into dql.config.json — run the generated 'sync' npm script to import\n`));
  } else if (dbtSibling) {
    console.log(c.dim(`  using dbt project at ${dbtSibling}`));
    console.log(c.dim(`  wired into dql.config.json — run the generated 'sync' npm script to import\n`));
  } else {
    console.log(c.dim('  no dbt project found: dql.config.json points at ../my-dbt-project — edit it,'));
    console.log(c.dim('  or re-run with --dbt <path>, or --warehouse <driver> for a database-only workspace'));
    console.log('');
  }

  // Best-effort: `git init` for a clean first commit — but never nest a
  // repo inside an existing one (e.g. scaffolding ./dql inside a dbt repo).
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target });
  if (inRepo.status !== 0) {
    const gitResult = spawnSync('git', ['init', '-q'], { cwd: target });
    if (gitResult.status === 0) {
      // Honor a configured init.defaultBranch; otherwise start on `main`, like
      // the workbench's Initialize Git. Git's own fallback is still `master` on
      // many machines, and a first send then lands beside GitHub's `main`.
      const defaultBranch = spawnSync('git', ['config', '--get', 'init.defaultBranch'], { cwd: target, encoding: 'utf-8' });
      if (defaultBranch.status !== 0 || !String(defaultBranch.stdout ?? '').trim()) {
        spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: target });
      }
      console.log(c.dim('  initialized git repo'));
    }
  }

  const pm = detectPackageManager();
  const installCmd = pm === 'npm' ? 'npm install' : `${pm} install`;
  const runCmd = pm === 'npm' ? 'npm run notebook' : `${pm} notebook`;
  const syncCmd = pm === 'npm' ? 'npm run sync' : `${pm} sync`;

  let steps;
  if (mode.kind === 'warehouse') {
    const pkg = DRIVER_PACKAGES[mode.driver];
    steps = [
      c.bold(`cd ${args.dir}`),
      c.bold(installCmd),
      ...(pkg ? [c.bold(connectorInstall(pkg))] : []),
      c.dim(FILE_DRIVERS.has(mode.driver)
        ? `# Check the "default" connection's filepath in dql.config.json (${connection.filepath})`
        : '# Fill the "default" connection in dql.config.json (set its ${ENV_VAR}s, or use Settings → Database)'),
      `${c.bold('npx zlens sync warehouse --schemas <schema>')}   ${c.dim(`# first time; then ${syncCmd}`)}`,
      c.bold('npx zlens model discover --validate'),
      `${c.bold(runCmd)}   ${c.dim('# review and certify in Modeling, then Ask')}`,
    ].join('\n  ');
  } else {
    const connectorTip = [
      c.dim('# Optional database driver install before running queries:'),
      c.dim(`#   DuckDB/local files: ${connectorInstall('duckdb')}`),
      c.dim(`#   Snowflake:       ${connectorInstall('snowflake-sdk')}`),
      c.dim('#   Databricks:      no extra package'),
    ].join('\n  ');
    const dbtTip = dbtSibling
      ? `\n\n${c.dim('Tip:')} run ${c.bold('dbt parse')} inside ${c.dim(dbtSibling)}\n     first, then ${c.bold(syncCmd)} to import the dbt DAG.`
      : '';
    steps = `${c.bold(`cd ${args.dir}`)}
  ${c.bold(installCmd)}
  ${connectorTip}
  ${c.bold(runCmd)}${dbtTip}`;
  }

  console.log(`
${c.green('✓ Ready.')} Next steps:

  ${steps}

Your notebook will open at ${c.cyan('http://127.0.0.1:3474')}.

Docs:   ${c.cyan('https://duckcode-ai-labs.github.io/zlens/')}
Source: ${c.cyan('https://github.com/duckcode-ai-labs/zlens')}
Issues: ${c.cyan('https://github.com/duckcode-ai-labs/zlens/issues')}
`);
}

main().catch((e) => {
  console.error(c.red(`\n✗ ${e.message}`));
  process.exit(1);
});
