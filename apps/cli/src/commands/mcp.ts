import { DQLContext, runStdio, runLoopbackHTTP } from '@zlens/mcp';
import {
  defaultKgPath,
  dqlToolNamesForSurface,
  ensureMetadataCatalogFresh,
  reindexProject,
} from '@zlens/agent';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, readDqlRuntimeVersion } from '../local-runtime.js';
import { backUpOnVersionChange } from '../upgrade-backups.js';
import { readEnv } from '@zlens/core';

interface McpFlags extends CLIFlags {
  http?: boolean;
}

export async function runMcp(arg: string | null, rest: string[], flags: McpFlags): Promise<void> {
  if (arg === 'test') {
    return runMcpTest(rest[0] ?? null, flags);
  }

  const projectRoot = findProjectRoot(arg ?? process.cwd());
  // An AI client may start ZLens's MCP server before the notebook after an upgrade: back up first here too,
  // before any store opens (upgrade-backups.ts). Its one line goes to stderr, never into the stdio protocol.
  backUpOnVersionChange(projectRoot, readDqlRuntimeVersion());

  if (flags.http) {
    const handle = await runLoopbackHTTP({ projectRoot, port: flags.port ?? 0, version: readDqlRuntimeVersion() });
    process.stderr.write(`dql-mcp listening on ${handle.url}\n`);
    process.stderr.write(`  Authorization: Bearer ${handle.token}\n`);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => void handle.close().then(() => process.exit(0)));
    }
    return;
  }

  await runStdio({ projectRoot, version: readDqlRuntimeVersion() });
}

/** One readiness check. Every check is required: "Ready" means an agent can actually answer. */
export interface McpTestCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do when the check fails. */
  fix?: string;
}

/** The command that starts the runtime the MCP tools call (the workbench), for this project. */
export function workbenchStartHint(projectRoot: string): string {
  return `start the ZLens workbench and keep it running: \`zlens notebook ${quoteShellArg(projectRoot)}\` (\`npm run notebook\` in a create-zlens-app project). If it runs on another address, set ZLENS_RUNTIME_URL`;
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

export interface McpTestReport {
  ok: boolean;
  projectRoot: string;
  checks: McpTestCheck[];
  failed: string[];
}

export function summarizeMcpTest(projectRoot: string, checks: McpTestCheck[]): McpTestReport {
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return { ok: failed.length === 0, projectRoot, checks, failed };
}

export function formatMcpTestReport(report: McpTestReport): string {
  const lines = ['', '  ZLens MCP Test', `    Project: ${report.projectRoot}`, ''];
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? '✓' : '✗'} ${check.name}`);
    lines.push(`    ${check.detail}`);
    if (!check.ok && check.fix) lines.push(`    Fix: ${check.fix}`);
  }
  lines.push('');
  lines.push(report.ok
    ? '  Ready: point Claude Code, Codex, Cursor, or Claude Desktop at this project with `zlens connect`.'
    : `  Not ready: ${report.failed.length} check${report.failed.length === 1 ? '' : 's'} failed (${report.failed.join(', ')}). Fix ${report.failed.length === 1 ? 'it' : 'them'} as shown above, then rerun \`zlens mcp test\`.`);
  lines.push('');
  return lines.join('\n');
}

export async function collectMcpTestChecks(projectRoot: string, options: { runtimeBase?: string; fetchImpl?: typeof fetch } = {}): Promise<McpTestCheck[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const checks: McpTestCheck[] = [];
  const hasConfig = existsSync(join(projectRoot, 'dql.config.json'));
  checks.push({
    name: 'ZLens project',
    ok: hasConfig,
    detail: hasConfig ? projectRoot : `dql.config.json not found in ${projectRoot}`,
    fix: 'run this from your ZLens project folder, or pass its path: `zlens mcp test <path>`. To start one, run `npx create-zlens-app`',
  });

  try {
    const ctx = new DQLContext({ projectRoot });
    const manifest = ctx.manifest;
    checks.push({
      name: 'Manifest context',
      ok: true,
      detail: `${Object.keys(manifest.blocks ?? {}).length} block(s), ${Object.keys(manifest.apps ?? {}).length} app(s)`,
    });
  } catch (error) {
    checks.push({
      name: 'Manifest context',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: 'run `zlens compile` (`npm run compile`) in the project and fix the errors it reports',
    });
  }

  try {
    const result = await ensureMetadataCatalogFresh(projectRoot);
    checks.push({
      name: 'Metadata catalog',
      ok: true,
      detail: `${result.objectCount} object(s), ${result.edgeCount} edge(s) at ${result.path}`,
    });
  } catch (error) {
    checks.push({
      name: 'Metadata catalog',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: 'run `zlens sync dbt` (`npm run sync`) for a dbt project, or `zlens compile`, then rerun',
    });
  }

  try {
    const result = await reindexProject(projectRoot, { kgPath: defaultKgPath(projectRoot) });
    checks.push({
      name: 'Agent index',
      ok: true,
      detail: `${result.nodes} node(s), ${result.edges} edge(s), ${result.skills} skill(s); KG ${result.kgRebuilt ? 'rebuilt' : 'fresh'}, metadata ${result.metadataRefreshed ? 'refreshed' : 'fresh'}`,
    });
  } catch (error) {
    checks.push({
      name: 'Agent index',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: 'run `zlens sync dbt` (`npm run sync`) for a dbt project, or `zlens compile`, then rerun',
    });
  }

  const fullProfile = ['full', 'expert', 'admin'].includes(readEnv('ZLENS_MCP_TOOL_PROFILE')?.trim().toLowerCase() ?? '');
  const servedTools = dqlToolNamesForSurface(fullProfile ? 'mcp' : 'mcp_agentic');
  checks.push({
    name: 'MCP tool surface',
    ok: true,
    detail: `${servedTools.length} tools (${fullProfile ? 'full' : 'default'} profile): ${servedTools.join(', ')}`,
  });

  // answer_question, build_block_from_prompt, the query tools and the typed
  // Dataset tools all call the ZLens runtime: the workbench `zlens notebook`
  // starts. An agent connected without it gets "could not reach" on every
  // question, so the project is not ready for one until it is up.
  const runtimeBase = (options.runtimeBase ?? readEnv('ZLENS_RUNTIME_URL') ?? 'http://127.0.0.1:3474').replace(/\/$/, '');
  const startHint = workbenchStartHint(projectRoot);
  let runtimeOk = false;
  let runtimeDetail = `not reachable at ${runtimeBase}; answer_question, build_block_from_prompt and the query tools need it`;
  try {
    const resp = await fetchImpl(`${runtimeBase}/api/schema`, { signal: AbortSignal.timeout(1500) });
    // Any HTTP response (even 404) means something is listening there.
    runtimeOk = resp.status < 500;
    runtimeDetail = runtimeOk ? `reachable at ${runtimeBase}` : `${runtimeBase} answered ${resp.status}`;
  } catch {
    // not reachable — keep the detail above
  }
  checks.push({
    name: 'ZLens runtime (governed generation + execution)',
    ok: runtimeOk,
    detail: runtimeDetail,
    fix: startHint,
  });

  // Dataset MCP calls must reach the dedicated typed Dataset endpoint, not
  // merely any process speaking HTTP on the configured runtime port. The
  // endpoint itself owns current catalog, source, proof and target validation.
  let datasetRuntimeOk = false;
  let datasetRuntimeDetail = runtimeOk
    ? `not reachable at ${runtimeBase}/api/app-datasets`
    : `not checked: no runtime at ${runtimeBase}; typed Dataset tools need it`;
  let datasetFix = startHint;
  if (runtimeOk) {
    try {
      const response = await fetchImpl(`${runtimeBase}/api/app-datasets`, { signal: AbortSignal.timeout(1500) });
      datasetRuntimeOk = response.status >= 200 && response.status < 300;
      datasetRuntimeDetail = datasetRuntimeOk
        ? `typed Dataset runtime available at ${runtimeBase}/api/app-datasets`
        : `typed Dataset runtime returned ${response.status} at ${runtimeBase}/api/app-datasets`;
    } catch {
      // Retain the unavailable detail above.
    }
    if (!datasetRuntimeOk) {
      datasetFix = `the server at ${runtimeBase} is not this project's ZLens workbench; ${startHint}`;
    }
  }
  checks.push({
    name: 'Dataset MCP runtime capability',
    ok: datasetRuntimeOk,
    detail: datasetRuntimeDetail,
    fix: datasetFix,
  });
  return checks;
}

async function runMcpTest(targetPath: string | null, flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(resolve(targetPath ?? process.cwd()));
  const report = summarizeMcpTest(projectRoot, await collectMcpTestChecks(projectRoot));
  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMcpTestReport(report));
  }
  // Scripts and CI read the exit code: a failed check is never "ready".
  if (!report.ok) process.exitCode = 1;
}
