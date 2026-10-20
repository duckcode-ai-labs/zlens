import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

type ConnectTarget = 'codex' | 'claude-code' | 'claude-desktop' | 'cursor' | 'all';

interface ConnectResult {
  target: Exclude<ConnectTarget, 'all'>;
  path: string;
  changed: boolean;
  message: string;
  nextStep: string;
  extraPaths?: string[];
}

interface McpServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  alwaysLoad?: boolean;
}

const DQL_SERVER_NAME = 'dql';
const CODEX_STARTUP_TIMEOUT_SEC = 60;
const CODEX_TOOL_TIMEOUT_SEC = 600;

export async function runConnect(targetArg: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  const target = normalizeTarget(targetArg);
  if (!target) {
    throw new Error(
      'Usage: zlens connect <codex|claude-code|claude-desktop|cursor|all> [project-path] [--format json]',
    );
  }

  const projectRoot = findProjectRoot(resolve(rest[0] ?? process.cwd()));
  const targets = target === 'all'
    ? ['codex', 'claude-code', 'claude-desktop', 'cursor'] as const
    : [target] as const;
  const results = targets.map((item) => connectTarget(item, projectRoot));

  if (flags.format === 'json') {
    console.log(JSON.stringify({ ok: true, projectRoot, results }, null, 2));
    return;
  }

  console.log('\n  ZLens agent connection setup');
  console.log(`    Project: ${projectRoot}`);
  console.log('');
  for (const result of results) {
    console.log(`  ${result.changed ? '✓' : '•'} ${labelForTarget(result.target)}`);
    console.log(`    ${result.message}`);
    console.log(`    ${result.path}`);
    for (const extraPath of result.extraPaths ?? []) {
      console.log(`    ${extraPath}`);
    }
    console.log(`    Next: ${result.nextStep}`);
  }
  console.log('');
  console.log('  Verify before asking an agent: zlens mcp test');
  console.log('');
}

function connectTarget(target: Exclude<ConnectTarget, 'all'>, projectRoot: string): ConnectResult {
  switch (target) {
    case 'codex':
      return connectCodex(projectRoot);
    case 'claude-code':
      return connectClaudeCode(projectRoot);
    case 'claude-desktop':
      return connectClaudeDesktop(projectRoot);
    case 'cursor':
      return connectCursor(projectRoot);
  }
}

function connectCodex(projectRoot: string): ConnectResult {
  const path = join(projectRoot, '.codex', 'config.toml');
  const guidePath = join(projectRoot, 'AGENTS.md');
  // Codex waits 10 s for a server to start and 60 s for a tool by default.
  // The first `npx` start downloads the CLI, and answer_question waits on a
  // model, so both limits are raised. Every read-only tool is annotated, so
  // Codex runs it without asking; a tool that saves a draft still asks.
  const block = [
    '# BEGIN DQL MCP',
    `[mcp_servers.${DQL_SERVER_NAME}]`,
    'command = "npx"',
    `args = ${tomlStringArray(mcpServerArgs(projectRoot))}`,
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    '# END DQL MCP',
    '',
  ].join('\n');
  const before = readTextIfExists(path);
  const after = replaceTomlMcpBlock(before, block);
  writeTextIfChanged(path, after);
  const guideChanged = upsertAgentGuide(guidePath, 'Codex');
  return {
    target: 'codex',
    path,
    changed: before !== after || guideChanged,
    message: 'Project Codex config and AGENTS.md now point at this ZLens project.',
    nextStep: 'Open this trusted project in Codex, then run zlens mcp test before asking analytics questions.',
    extraPaths: [guidePath],
  };
}

function connectClaudeCode(projectRoot: string): ConnectResult {
  const path = join(projectRoot, '.mcp.json');
  const guidePath = join(projectRoot, 'CLAUDE.md');
  const before = readTextIfExists(path);
  const after = upsertJsonMcpServer(before, {
    ...mcpServerConfig(projectRoot),
    alwaysLoad: true,
  });
  writeTextIfChanged(path, after);
  const guideChanged = upsertAgentGuide(guidePath, 'Claude Code');
  return {
    target: 'claude-code',
    path,
    changed: before !== after || guideChanged,
    message: 'Project .mcp.json and CLAUDE.md now point Claude Code at ZLens.',
    nextStep: 'Open Claude Code from this project and run /mcp to confirm the dql server is loaded.',
    extraPaths: [guidePath],
  };
}

/** Where Claude Desktop reads its config, per platform. */
export function claudeDesktopConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude', 'claude_desktop_config.json');
}

/**
 * Claude Desktop is started from the Dock or Start menu, not a shell, so it
 * does not see the PATH where Node is installed (Homebrew, nvm, Volta): a bare
 * `npx` fails with "spawn npx ENOENT", and `npx` itself needs `node` on PATH.
 * Point at the npx next to the Node running this command and put that folder
 * first on the server's PATH.
 */
export function desktopServerConfig(projectRoot: string, nodePath: string = process.execPath, platform: NodeJS.Platform = process.platform): McpServerConfig {
  const binDir = dirname(nodePath);
  const npx = join(binDir, platform === 'win32' ? 'npx.cmd' : 'npx');
  if (!existsSync(npx)) return mcpServerConfig(projectRoot);
  const separator = platform === 'win32' ? ';' : ':';
  const systemPath = platform === 'win32'
    ? (process.env.PATH ?? '')
    : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return {
    command: npx,
    args: mcpServerArgs(projectRoot),
    env: { PATH: [binDir, systemPath].filter(Boolean).join(separator) },
  };
}

function connectClaudeDesktop(projectRoot: string): ConnectResult {
  const path = claudeDesktopConfigPath();
  const before = readTextIfExists(path);
  const after = upsertJsonMcpServer(before, desktopServerConfig(projectRoot));
  writeTextIfChanged(path, after);
  return {
    target: 'claude-desktop',
    path,
    changed: before !== after,
    message: 'Claude Desktop config includes this ZLens MCP server.',
    nextStep: 'Quit and reopen Claude Desktop, keep the workbench running, then ask a data question; the dql tools appear under the tools (search and tools) menu.',
  };
}

function connectCursor(projectRoot: string): ConnectResult {
  const path = join(projectRoot, '.cursor', 'mcp.json');
  const before = readTextIfExists(path);
  const after = upsertJsonMcpServer(before, mcpServerConfig(projectRoot));
  writeTextIfChanged(path, after);
  return {
    target: 'cursor',
    path,
    changed: before !== after,
    message: 'Project Cursor MCP config includes this ZLens server.',
    nextStep: 'Open Cursor settings, enable MCP, and reload the project if needed.',
  };
}

function mcpServerConfig(projectRoot: string): McpServerConfig {
  return {
    command: 'npx',
    args: mcpServerArgs(projectRoot),
  };
}

function mcpServerArgs(projectRoot: string): string[] {
  return ['-y', '--package=@zlens/cli', 'zlens', 'mcp', projectRoot];
}

function normalizeTarget(value: string | null): ConnectTarget | null {
  const normalized = value?.trim().toLowerCase().replaceAll('_', '-') ?? '';
  if (
    normalized === 'codex' ||
    normalized === 'claude-code' ||
    normalized === 'claude-desktop' ||
    normalized === 'cursor' ||
    normalized === 'all'
  ) {
    return normalized;
  }
  return null;
}

function labelForTarget(target: Exclude<ConnectTarget, 'all'>): string {
  switch (target) {
    case 'codex':
      return 'Codex';
    case 'claude-code':
      return 'Claude Code';
    case 'claude-desktop':
      return 'Claude Desktop';
    case 'cursor':
      return 'Cursor';
  }
}

function readTextIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function writeTextIfChanged(path: string, contents: string): void {
  if (readTextIfExists(path) === contents) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function upsertJsonMcpServer(existing: string, server: McpServerConfig): string {
  let parsed: Record<string, unknown> = {};
  if (existing.trim()) {
    try {
      parsed = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const current = parsed.mcpServers && typeof parsed.mcpServers === 'object'
    ? parsed.mcpServers as Record<string, unknown>
    : {};
  return JSON.stringify({
    ...parsed,
    mcpServers: {
      ...current,
      [DQL_SERVER_NAME]: server,
    },
  }, null, 2) + '\n';
}

function upsertAgentGuide(path: string, clientName: string): boolean {
  const before = readTextIfExists(path);
  const after = replaceMarkedBlock(before, agentGuideBlock(clientName));
  writeTextIfChanged(path, after);
  return before !== after;
}

/**
 * The ZLens section `zlens connect` writes into CLAUDE.md / AGENTS.md. Every
 * tool it names is served by the default MCP profile (a test enforces it), so
 * an agent is never sent to a tool it cannot see.
 */
export function agentGuideBlock(clientName: string): string {
  return [
    '<!-- BEGIN DQL AGENT GUIDE -->',
    '## ZLens Agent Guide',
    '',
    `When using ${clientName} with this project, answer data questions through the ZLens MCP server (\`dql\`), the way ZLens Ask does: certified blocks first, the trust label on every answer.`,
    '',
    '- Start with `inspect_dql_project` (blocks, Apps, semantic layer, catalog).',
    '- Route every data question through `ask_dql` before writing SQL. It returns the route, the trust label and the next tool:',
    '  - `certified`: run the block with `query_via_block` when its grain answers the question exactly. Label the answer **Certified**.',
    '  - `generated_sql`: call `inspect_metadata_context`, then run one read-only `SELECT` or `WITH` with `query_via_metadata`. Label the answer **AI-Generated (review required)** and give the draft path it saved.',
    '  - `conflict`: show both definitions and their owners and ask which one is authoritative.',
    '  - missing context: say what is missing and ask; do not guess.',
    '- `answer_question` answers end to end like Ask when an AI model is set up in ZLens. If it returns `modelUnavailable`, use the steps above.',
    '- Semantic metrics: `query_semantic_model`. Lineage and impact: `lineage_impact`. Joins: `resolve_analytical_path` and `explain_relationship_proof`. Schema: `search_metadata`, `get_table_schema`, `validate_sql`.',
    '- Blocks: `search_blocks` and `get_block`. To save a reusable block, call `build_block_from_prompt` (ZLens drafts it) or write the SQL and save it with `suggest_block`; a request to save a block does not need `ask_dql` first. `certify` checks the rules and changes nothing.',
    '- Apps and notebooks: `list_apps`, `build_dql_app` (starts an App Studio draft), `list_notebooks`. App Datasets: `list_datasets`, `describe_dataset`, `query_dataset`.',
    '- Report trust labels exactly as the tools return them. Never call AI-written SQL, a draft block or a draft App certified: only a person certifies, in Block Studio or with `zlens certify --from-draft`.',
    '- Queries run through the ZLens workbench (`npm run notebook` or `zlens notebook`); keep it running.',
    '<!-- END DQL AGENT GUIDE -->',
    '',
  ].join('\n');
}

function replaceMarkedBlock(existing: string, block: string): string {
  const pattern = /<!-- BEGIN DQL AGENT GUIDE -->[\s\S]*?<!-- END DQL AGENT GUIDE -->\n?/;
  if (pattern.test(existing)) {
    return `${existing.replace(pattern, block).trimEnd()}\n`;
  }
  const next = existing.trimEnd();
  return `${next ? `${next}\n\n` : ''}${block}`;
}

function replaceTomlMcpBlock(existing: string, block: string): string {
  let next = existing
    .replace(/\n?# BEGIN DQL MCP\n[\s\S]*?# END DQL MCP\n?/g, '\n')
    .replace(/\n?\[mcp_servers\.dql\]\n[\s\S]*?(?=\n\[[^\]]+\]|\s*$)/g, '\n');
  next = next.trimEnd();
  return `${next ? `${next}\n\n` : ''}${block}`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}
