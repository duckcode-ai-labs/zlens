import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import type { DqlHostHooks } from '../host/request-context.js';
import type { CLIFlags } from '../args.js';
import type { AskAgentRuntimeMode, ProjectConfig } from '../local-runtime.js';
import {
  findProjectRoot,
  loadProjectConfig,
  normalizeProjectConnection,
  resolveAskAgentRuntimeMode,
  startLocalServer,
  syncRuntimeSchema,
} from '../local-runtime.js';
import { maybeOpenBrowser } from '../open-browser.js';
import { createRuntimePageRunner } from '../schedule/app-page-run.js';
import { findRunningNotebook, localRuntimeUrl, writeNotebookDescriptor } from '../schedule/notebook-runtime.js';
import { readEnv } from '@zlens/core';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
// Bundled assets are always at dist/assets/ relative to the CLI dist root
const REACT_APP_DIR = resolve(COMMAND_DIR, '../assets/dql-notebook');
const LEGACY_APP_DIR = resolve(COMMAND_DIR, '../assets/notebook-browser');
const NOTEBOOK_APP_DIR = existsSync(join(REACT_APP_DIR, 'index.html')) ? REACT_APP_DIR : LEGACY_APP_DIR;

export function resolveNotebookConnection(config: ProjectConfig, projectRoot: string) {
  return config.defaultConnection
    ? normalizeProjectConnection(config.defaultConnection, projectRoot)
    : null;
}

export interface ProjectRuntimeHandle {
  port: number;
  url: string;
  /** Private per-runtime capability used only by the short-lived CLI Ask client. */
  askTraceCapability: string;
  /** Random per start; `/api/health` echoes it (see `schedule/notebook-runtime.ts`). */
  instanceId: string;
  /**
   * RFC 0010: refresh the schema snapshot (table and column names) from the
   * runtime's own connection, e.g. for a host that applies column policies.
   */
  syncSchema: () => Promise<{ relations: number; columns: number }>;
  /**
   * RFC 0010: one read-only metadata statement (SELECT, WITH, SHOW, DESCRIBE)
   * through the runtime's own connection, e.g. a host reading warehouse tags.
   * It runs as the runtime, not as a person; use it for metadata only.
   */
  metadataQuery: (sql: string) => Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }>;
  /**
   * Stop the HTTP listener and disconnect the warehouse, so the process can
   * exit and a DuckDB file is free for the next process (no-op if closed).
   */
  close: () => Promise<void>;
}

/**
 * Start the local notebook/runtime HTTP server for a project and return a handle.
 * Shared by `zlens notebook` (long-running) and `zlens agent ask` (which starts an
 * ephemeral runtime on a free port — `preferredPort: 0` — and closes it after).
 */
export async function startProjectRuntime(
  projectRoot: string,
  opts: {
    preferredPort?: number;
    host?: string;
    askAgentRuntimeMode?: AskAgentRuntimeMode;
    /** RFC 0010: run as a hosted runtime (see `@zlens/cli/host`). */
    hostHooks?: DqlHostHooks;
    /** RFC 0010 rule 1: how long ZLens waits for a host hook (default 10 s). */
    hostHookTimeoutMs?: number;
    /** Exact browser origins for a runtime behind a host's front door. */
    allowedOrigins?: string[];
    /** Replaces `defaultConnection` from dql.config.json, e.g. a host-managed connection. */
    connection?: ConnectionConfig | null;
  } = {},
): Promise<ProjectRuntimeHandle> {
  const config = loadProjectConfig(projectRoot);
  const executor = new QueryExecutor();
  const connection = opts.connection !== undefined ? opts.connection : resolveNotebookConnection(config, projectRoot);
  const host = opts.host ?? readEnv('ZLENS_HOST') ?? '127.0.0.1';
  const askTraceCapability = randomUUID();
  const instanceId = randomUUID();
  let server: Server | undefined;
  const port = await startLocalServer({
    rootDir: NOTEBOOK_APP_DIR,
    projectRoot,
    executor,
    connection,
    preferredPort: opts.preferredPort ?? 0,
    host,
    askAgentRuntimeMode: opts.askAgentRuntimeMode,
    ...(opts.hostHooks ? { hostHooks: opts.hostHooks } : {}),
    ...(opts.hostHookTimeoutMs !== undefined ? { hostHookTimeoutMs: opts.hostHookTimeoutMs } : {}),
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    trustedCliTraceToken: askTraceCapability,
    instanceId,
    captureServer: (created) => { server = created; },
  });
  const printHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  let closed: Promise<void> | undefined;
  return {
    port,
    url: `http://${printHost}:${port}`,
    askTraceCapability,
    instanceId,
    syncSchema: async () => {
      if (!connection) throw new Error('This project has no connection, so there is no schema to read.');
      return syncRuntimeSchema(projectRoot, executor, connection);
    },
    metadataQuery: async (sql: string) => {
      if (!connection) throw new Error('This project has no connection, so there is no metadata to read.');
      const statement = sql.trim().replace(/;\s*$/, '');
      if (!/^(select|with|show|describe|desc)\b/i.test(statement) || statement.includes(';')) throw new Error('A metadata query is one read-only statement.');
      const result = await executor.executeQuery(statement, [], {}, connection, { purpose: 'metadata' });
      return { columns: result.columns.map((column) => column.name), rows: result.rows as Array<Record<string, unknown>> };
    },
    close: () => (closed ??= new Promise<void>((resolveClose) => {
      if (!server) return resolveClose();
      server.close(() => resolveClose());
      // Open event streams (operations, file watch) would hold close() forever while a browser has DQL open.
      server.closeAllConnections?.();
    }).then(() => executor.disconnect().catch(() => undefined))),
  };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** The token as a URL fragment: the browser keeps it and never sends it to the server. */
export const withAccessToken = (url: string, token: string | undefined) =>
  (token ? `${url.replace(/\/$/, '')}/#dql_token=${encodeURIComponent(token)}` : url);

/**
 * The links another device opens to reach a server bound beyond loopback: one
 * per network address when bound on every interface, each carrying the access
 * token a shared server requires.
 */
export function networkAccessUrls(input: {
  host: string;
  port: number;
  token?: string;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}): string[] {
  if (LOOPBACK_HOSTS.has(input.host)) return [];
  const hosts = input.host === '0.0.0.0' || input.host === '::'
    ? Object.values(input.interfaces ?? networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => address.address)
    : [input.host];
  return [...new Set(hosts)].map((host) => withAccessToken(`http://${host}:${input.port}`, input.token));
}

/**
 * A folder with no ZLens project (design D7): ask to create one in a terminal,
 * create it with `--yes`, otherwise explain with the single command to run.
 * Returns the project root to open, or throws with that explanation.
 */
export async function ensureNotebookProject(
  baseDir: string,
  flags: CLIFlags,
  io: { interactive?: boolean; ask?: (question: string) => Promise<string> } = {},
): Promise<string> {
  const projectRoot = findProjectRoot(baseDir);
  if (existsSync(join(projectRoot, 'dql.config.json'))) return projectRoot;
  if (!existsSync(baseDir)) {
    throw new Error(`There is no folder at "${baseDir}". Pass the folder that holds your database file or dbt project.`);
  }
  const [{ detectFolderContents, runInit }, bare] = await Promise.all([import('./init.js'), import('./bare-folder.js')]);
  const interactive = io.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const decision = await bare.decideBareFolder({
    folder: baseDir,
    contents: detectFolderContents(baseDir),
    yes: flags.yes === true,
    interactive,
    ask: io.ask ?? bare.askInTerminal,
  });
  if (decision.action !== 'create') {
    throw Object.assign(new Error(decision.message), { code: decision.action === 'declined' ? 'NOTEBOOK_PROJECT_DECLINED' : 'NOTEBOOK_PROJECT_MISSING' });
  }
  await runInit(baseDir, { ...flags, open: false, format: 'text', force: false }, { output: 'summary' });
  if (!existsSync(join(baseDir, 'dql.config.json'))) throw new Error(`ZLens could not create a project in "${baseDir}".`);
  return baseDir;
}

export async function runNotebook(targetArg: string | null, flags: CLIFlags): Promise<void> {
  const baseDir = resolve(targetArg ?? '.');
  const projectRoot = await ensureNotebookProject(baseDir, flags);
  const config = loadProjectConfig(projectRoot);
  const host = flags.host ?? readEnv('ZLENS_HOST') ?? '127.0.0.1';
  // Validate the flag here so a typo fails before a server starts, but pass it
  // through UNRESOLVED: resolving an absent flag to the default would outrank
  // the project's own `agent.askRuntimeMode` and make the config key dead.
  if (flags.askRuntimeMode !== undefined) resolveAskAgentRuntimeMode(flags.askRuntimeMode);
  const runtime = await startProjectRuntime(projectRoot, {
    preferredPort: flags.port ?? config.preview?.port ?? 3474,
    host,
    askAgentRuntimeMode: flags.askRuntimeMode as AskAgentRuntimeMode | undefined,
  });
  const { port, url } = runtime;
  const schedules = await startNotebookAppSchedules(projectRoot, runtime, host, flags.schedules !== false);

  // Auto-open only on loopback. In a container or on a remote host, opening
  // the host's browser is either useless or wrong.
  const shouldOpen = (flags.open ?? config.preview?.open ?? true) && host === '127.0.0.1';
  maybeOpenBrowser(url, shouldOpen);

  // A server bound beyond loopback answers only a browser holding its token,
  // this machine's included: print links that carry it.
  const token = LOOPBACK_HOSTS.has(host) ? undefined : readEnv('ZLENS_SERVER_TOKEN');
  console.log(`\n  ✓ Notebook ready: ${withAccessToken(url, token)}`);
  const networkUrls = networkAccessUrls({ host, port, ...(token ? { token } : {}) });
  if (networkUrls.length > 0) {
    const allowed = new Set((readEnv('ZLENS_ALLOWED_ORIGINS') ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean));
    console.log(`    Bound on ${host}:${port}. From another device, open the full link (it carries the access token):`);
    for (const link of networkUrls) {
      const origin = new URL(link).origin;
      console.log(`      ${link}${allowed.has(origin) ? '' : `  (add ${origin} to ZLENS_ALLOWED_ORIGINS, or browsers there are refused)`}`);
    }
    console.log('    A new browser tab needs the full link again, or the token pasted when the page asks for it.');
  } else if (host !== '127.0.0.1') {
    console.log(`    Bound on ${host}:${port} — open the URL above from your host.`);
  }
  if (schedules.message) console.log(`    ${schedules.message}`);
  console.log('    Press Ctrl+C to stop.');
  console.log('');
}

/**
 * The notebook announces itself in `.dql/local/notebook.json` and runs the
 * project's App schedules on its own runtime. `zlens schedule run|start` read
 * the file and run through this server instead of opening the project's
 * database a second time, which DuckDB does not allow. Block (.dql)
 * schedules stay with `zlens schedule start`.
 */
async function startNotebookAppSchedules(
  projectRoot: string,
  runtime: ProjectRuntimeHandle,
  host: string,
  enabled: boolean,
): Promise<{ message?: string }> {
  const other = await findRunningNotebook(projectRoot);
  if (other && other.descriptor.pid !== process.pid) {
    return { message: `Another zlens notebook (pid ${other.descriptor.pid}) serves this project; it runs the App schedules.` };
  }
  const selfUrl = localRuntimeUrl(host, runtime.port);
  const loopback = LOOPBACK_HOSTS.has(host);
  const removeDescriptor = writeNotebookDescriptor(projectRoot, {
    version: 1,
    pid: process.pid,
    host,
    port: runtime.port,
    url: selfUrl,
    instanceId: runtime.instanceId,
    startedAt: new Date().toISOString(),
    appSchedules: enabled,
  });

  let scheduler: { stop: () => void; apps: unknown[] } | undefined;
  if (enabled) {
    const [{ startAppScheduler, runScheduledApp }, nodeCron] = await Promise.all([
      import('../schedule/service.js'),
      import('node-cron' as string) as Promise<typeof import('node-cron')>,
    ]);
    const config = loadProjectConfig(projectRoot);
    const connection = normalizeProjectConnection(config.defaultConnection ?? { driver: 'duckdb' }, projectRoot);
    // Pages run through this server's own page-run endpoint, exactly as a
    // reader's full run; beyond loopback that endpoint needs the token.
    const pageRunner = createRuntimePageRunner(selfUrl, fetch, loopback ? undefined : readEnv('ZLENS_SERVER_TOKEN'));
    const executor = new QueryExecutor();
    scheduler = startAppScheduler({
      projectRoot,
      cron: nodeCron,
      run: (schedule) => runScheduledApp(schedule, { projectRoot, executor, connection, pageRunner }),
    });
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    scheduler?.stop();
    removeDescriptor();
  };
  // The descriptor must not outlive the notebook. Exit right away on a
  // signal: closing the server would wait on browsers' open event streams,
  // and the process exiting releases the database anyway.
  process.once('exit', stop);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.once(signal, () => {
      stop();
      process.exit(code);
    });
  }

  if (!enabled) return { message: 'App schedules are off in this notebook (--no-schedules); zlens schedule runs them through it.' };
  const count = scheduler?.apps.length ?? 0;
  return count > 0
    ? { message: `Running ${count} App schedule${count === 1 ? '' : 's'} while this notebook is open.` }
    : {};
}
