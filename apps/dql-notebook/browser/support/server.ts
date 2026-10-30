import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared plumbing for the browser journeys (../global-setup.ts) and the docs
 * feature clips (../clips): run a command, find a free port, start the BUILT
 * `zlens notebook` CLI against a project and wait until it is healthy.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../../..');
export const cliEntry = join(repoRoot, 'apps/cli/dist/index.js');
export const DUCKDB_VERSION = '^1.5.6-r.1';

export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const result = spawnSync(command, args, { cwd: options.cwd ?? repoRoot, stdio: 'inherit', env: options.env ?? process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'none'}`);
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolvePort(port) : reject(new Error('no free port'))));
    });
  });
}

/** Build the CLI (it bundles the notebook app) unless E2E_SKIP_BUILD=1. */
export function buildCli(): void {
  if (process.env.E2E_SKIP_BUILD !== '1') {
    run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@zlens/cli...']);
  }
  if (!existsSync(cliEntry)) throw new Error(`Built CLI not found at ${cliEntry}; build it first.`);
}

/**
 * DuckDB is an optional connector dependency. Install it where the runtime
 * looks first (<project>/.dql/connectors), the same way the Connections page does.
 */
export function installDuckdbConnector(projectDir: string, version: string = DUCKDB_VERSION): string {
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  mkdirSync(connectorRoot, { recursive: true });
  writeFileSync(join(connectorRoot, 'package.json'), '{"private":true}\n');
  run('npm', ['--prefix', connectorRoot, 'install', '--no-save', '--no-package-lock', '--workspaces=false', `@duckdb/node-api@${version}`]);
  return connectorRoot;
}

async function waitForHealth(baseUrl: string, server: ChildProcess, logPath: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(no server log)';
  throw new Error(`zlens notebook did not become healthy at ${baseUrl}/api/health:\n${log}`);
}

export interface NotebookServer {
  baseUrl: string;
  logPath: string;
  stop: () => Promise<void>;
}

/**
 * Start `node apps/cli/dist/index.js notebook <projectDir>` on a free port and
 * wait for /api/health. A fresh project opens the full-screen Guided Setup
 * review once per CLI version; acknowledge it the way finishing that review
 * does, so callers land in the product rather than behind the setup dialog.
 */
export async function startNotebookServer(input: {
  projectDir: string;
  workDir: string;
  env?: NodeJS.ProcessEnv;
  /** false leaves the first-run Guided Setup open, for journeys that walk it. */
  acknowledgeSetup?: boolean;
  /** More `zlens notebook` arguments, e.g. `--yes` to create a project in a bare folder. */
  args?: string[];
}): Promise<NotebookServer> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  mkdirSync(input.workDir, { recursive: true });
  const logPath = join(input.workDir, 'server.log');
  const logFd = openSync(logPath, 'w');
  const server = spawn('node', [cliEntry, 'notebook', input.projectDir, '--port', String(port), '--no-open', ...(input.args ?? [])], {
    cwd: input.workDir,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      // Native semantic engine only, so a developer's own `mf` cannot change the run.
      ZLENS_METRICFLOW_BIN: join(input.workDir, 'no-metricflow', 'mf'),
      ...input.env,
    },
  });
  closeSync(logFd); // the child keeps its own copy of the descriptor

  const stop = async (): Promise<void> => {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise<void>((done) => {
        const timer = setTimeout(() => { server.kill('SIGKILL'); done(); }, 5_000);
        server.once('exit', () => { clearTimeout(timer); done(); });
      });
    }
  };

  try {
    await waitForHealth(baseUrl, server, logPath);
    if (input.acknowledgeSetup !== false) {
      const ack = await fetch(`${baseUrl}/api/onboarding/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!ack.ok) throw new Error(`Acknowledging Guided Setup failed: HTTP ${ack.status} ${await ack.text()}`);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { baseUrl, logPath, stop };
}
