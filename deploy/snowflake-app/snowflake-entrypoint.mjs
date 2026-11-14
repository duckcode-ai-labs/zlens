// Start-up for ZLens inside Snowflake (Snowpark Container Services), in plain Node: the app's image is a
// minimal one with no shell (Snowflake's security review asks for minimal base images). The general image's
// scripts/docker-entrypoint.sh hands the Snowflake path to this file too, so there is one implementation.
//
//   node snowflake-entrypoint.mjs zlens notebook --host 0.0.0.0 --no-open
//
// Inside Snowflake (ZLENS_SNOWFLAKE_APP=1, or a token at /snowflake/session/token with SNOWFLAKE_HOST set) the
// project lives on the mounted volume, is created on the first start with one Snowflake connection, and the
// container reaches nothing on the internet. Each default below can be overridden by setting it.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI = process.env.ZLENS_CLI_ENTRY || '/opt/dql/dist/index.js';
const env = process.env;

function log(message) {
  process.stdout.write(`[zlens-docker] ${message}\n`);
}

// ZLENS_* first, then the old DQL_* names.
const workspace = env.ZLENS_PROJECT_ROOT || env.DQL_PROJECT_ROOT || env.ZLENS_WORKSPACE || env.DQL_WORKSPACE || '/workspace';
const tokenFile = env.ZLENS_SNOWFLAKE_TOKEN_FILE || '/snowflake/session/token';

export function isSnowflakeApp(vars = env, tokenExists = existsSync(tokenFile)) {
  if (vars.ZLENS_SNOWFLAKE_APP === '1') return true;
  return Boolean(vars.SNOWFLAKE_HOST) && tokenExists;
}

/**
 * The connection, written once into dql.config.json. Account and host stay ${...} references, read from the
 * environment at run time, so the project on the volume names no account. Inside Snowflake it signs in with the
 * service's token file; elsewhere (a local test) with a key pair.
 */
export function snowflakeConnection(vars, tokenPath, tokenExists) {
  // Snowflake sets SNOWFLAKE_DATABASE and SNOWFLAKE_SCHEMA in every container to where the service lives,
  // which is not data: the database and schema come only from ZLENS_SNOWFLAKE_*.
  const pick = (name) => vars[`ZLENS_SNOWFLAKE_${name}`]
    || (name === 'DATABASE' || name === 'SCHEMA' ? undefined : vars[`SNOWFLAKE_${name}`]) || undefined;
  const connection = { driver: 'snowflake', account: '${SNOWFLAKE_ACCOUNT}' };
  if (vars.SNOWFLAKE_HOST) connection.host = '${SNOWFLAKE_HOST}';
  for (const [key, name] of [['warehouse', 'WAREHOUSE'], ['database', 'DATABASE'], ['schema', 'SCHEMA'], ['role', 'ROLE']]) {
    const value = pick(name);
    if (value) connection[key] = value;
  }
  if (tokenExists) return { ...connection, authMethod: 'oauth', tokenFilePath: tokenPath };
  if (vars.ZLENS_SNOWFLAKE_PRIVATE_KEY_PATH) {
    return { ...connection, authMethod: 'key_pair', username: vars.ZLENS_SNOWFLAKE_USER || '', privateKeyPath: vars.ZLENS_SNOWFLAKE_PRIVATE_KEY_PATH };
  }
  return undefined;
}

function prepareSnowflakeApp() {
  env.ZLENS_NO_EGRESS ??= '1';
  env.ZLENS_LOCK_CONNECTIONS ??= '1';
  // No model unless the app package chooses one: ZLENS_MODEL_PROVIDERS=cortex gives it Claude through
  // Snowflake Cortex, signed in with the service's token.
  env.ZLENS_MODEL_PROVIDERS ??= 'none';
  // Inside Snowflake its ingress signs people in and names them (Sf-Context-Current-User): ZLens trusts that
  // header there, and only there (the server checks for Snowflake's token file too).
  const tokenExists = existsSync(tokenFile);
  if (tokenExists) env.ZLENS_SNOWFLAKE_INGRESS ??= '1';
  mkdirSync(workspace, { recursive: true });
  process.chdir(workspace);
  // The app image runs as an unprivileged user (uid 1000). A volume first used by an image that ran as root
  // holds files this user cannot change: say so plainly instead of failing later.
  for (const path of ['.', 'dql.config.json', '.dql']) {
    if (!existsSync(path)) continue;
    try {
      accessSync(path, constants.W_OK);
    } catch {
      const uid = process.getuid?.();
      log(`Cannot write ${join(workspace, path)} as uid ${uid}: the volume was probably created by an image that ran as root.`);
      log(`Give it to this user once (chown -R ${uid}:${process.getgid?.()} ${workspace}) or run the image as root.`);
      process.exit(1);
    }
  }
  if (!existsSync('dql.config.json')) {
    log(`First start: creating a warehouse-first project in ${workspace}.`);
    const init = spawnSync(process.execPath, [CLI, 'init', '--warehouse-first', '--yes'], { stdio: ['ignore', 'ignore', 'inherit'], env });
    if (init.status !== 0) process.exit(init.status ?? 1);
    const connection = snowflakeConnection(env, tokenFile, tokenExists);
    if (!connection) {
      process.stderr.write(`[zlens-docker] No Snowflake sign-in: no token file at ${tokenFile} and no ZLENS_SNOWFLAKE_PRIVATE_KEY_PATH.\n`);
      process.exit(1);
    }
    const config = JSON.parse(readFileSync('dql.config.json', 'utf8'));
    config.connections = { snowflake: connection };
    config.defaultConnectionName = 'snowflake';
    writeFileSync('dql.config.json', `${JSON.stringify(config, null, 2)}\n`);
    log('Project ready with its Snowflake connection.');
  }
}

async function run(argv) {
  const [command, ...rest] = argv.length ? argv : ['zlens', 'notebook', '--host', '0.0.0.0', '--no-open'];
  if (command !== 'zlens' && command !== 'dql') {
    // Anything else runs as given (there is no shell in the app's image); `node` is this Node.
    const program = command === 'node' ? process.execPath : command;
    const child = spawnSync(program, rest, { stdio: 'inherit', env });
    process.exit(child.status ?? 1);
  }
  if (isSnowflakeApp()) prepareSnowflakeApp();
  else if (existsSync(workspace)) process.chdir(workspace);
  // Run the CLI in this process, as `zlens` would (its server handles SIGTERM itself).
  process.argv = [process.execPath, CLI, ...rest];
  await import(CLI);
}

if (import.meta.url === `file://${process.argv[1]}`) await run(process.argv.slice(2));
