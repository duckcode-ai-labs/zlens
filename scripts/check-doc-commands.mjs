#!/usr/bin/env node
// Verify that every `zlens …`, `npx create-zlens-app …` and starter
// `npm run …` command shown in the published docs is real.
//
// For each command found in a shell code block (bash, sh, shell, console or
// no language) or an inline code span, it checks, against the CLI source:
//   - the top-level command is dispatched by apps/cli/src/index.ts;
//   - a subcommand (for commands that take one) is one the command handles;
//   - every --flag is read by that command: either args.ts maps it to a
//     `flags.<name>` property that the command's source uses, or the
//     command's source reads the literal flag itself.
// `create-zlens-app` flags are checked against its bin script, and
// `npm run <script>` against the starter template's package.json.
//
// Design records (rfcs/, specs/, performance/, prototypes/) and the
// unpublished contribute/ folder are not user docs and are skipped.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
// Optional argument: a docs folder to check instead of docs/ (used by tests).
const DOCS = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'docs');
const CLI_SRC = join(ROOT, 'apps/cli/src');
const COMMANDS_DIR = join(CLI_SRC, 'commands');
const SKIP_DIRS = new Set(['rfcs', 'specs', 'performance', 'prototypes', 'contribute', 'media']);

const read = (p) => readFileSync(p, 'utf-8');

// ---------------------------------------------------------------- CLI model

const indexSource = read(join(CLI_SRC, 'index.ts'));
const COMMANDS = new Set([...indexSource.matchAll(/^\s+case "([a-z-]+)":$/gm)].map((m) => m[1]));

// args.ts: '--flag' -> flags.<prop>. Unknown flags are left for the command.
const argsSource = read(join(CLI_SRC, 'args.ts'));
const FLAG_PROPS = new Map();
{
  let pending = [];
  for (const line of argsSource.split('\n')) {
    const names = [...line.matchAll(/arg === '(--[a-z0-9-]+)'/g)].map((m) => m[1]);
    if (names.length) {
      pending = names;
      for (const name of names) FLAG_PROPS.set(name, []);
    }
    for (const m of line.matchAll(/flags\.([A-Za-z]+)\s*=[^=]/g)) {
      for (const name of pending) FLAG_PROPS.get(name).push(m[1]);
    }
  }
}
// Flags every command honours.
const UNIVERSAL_FLAGS = new Set(['--help', '--version', '--verbose', '--format']);

const commandFilesCache = new Map();
function commandSource(command) {
  if (commandFilesCache.has(command)) return commandFilesCache.get(command);
  const files = readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => f === `${command}.ts` || f.startsWith(`${command}-`));
  const source = files.map((f) => read(join(COMMANDS_DIR, f))).join('\n');
  commandFilesCache.set(command, source);
  return source;
}

// Commands whose next word is a subcommand (or a fixed target). Each word is
// itself checked against the command's source below, so this list cannot
// drift from the code silently. `optional` means a path or name may come
// instead of a subcommand.
const SUBCOMMANDS = {
  agent: { words: ['ask', 'threads', 'trace', 'reindex', 'feedback', 'eval'] },
  'agent trace': { words: ['list', 'show', 'export', 'validate', 'replay', 'compare'] },
  'agent feedback': { words: ['up', 'down'] },
  app: { words: ['new', 'generate', 'ls', 'show', 'build', 'reindex', 'verify', 'key', 'diff', 'check'] },
  connect: { words: ['codex', 'claude-code', 'claude-desktop', 'cursor', 'all'] },
  sync: { words: ['dbt', 'warehouse'] },
  model: { words: ['list', 'validate', 'discover', 'apply-discovery', 'import', 'explain', 'validate-relationship', 'reject-discovery'] },
  schedule: { words: ['list', 'run', 'start', 'stop', 'status'] },
  promote: { words: ['notebook', 'app', 'dashboard'] },
  semantic: { words: ['list', 'validate', 'query', 'pull', 'import', 'sync', 'drafts', 'approve', 'discard'] },
  import: { words: ['sql'] },
  slack: { words: ['serve'] },
  new: { words: ['block', 'semantic-block', 'business-view', 'term', 'domain', 'dashboard', 'workbook'], optional: true },
  doctor: { words: ['scale', 'git-hygiene'], optional: true },
  mcp: { words: ['test'], optional: true },
  lineage: { words: ['cross-domain'], optional: true },
  migrate: { words: ['assess', 'compare', 'looker', 'tableau', 'powerbi', 'dbt', 'metabase', 'raw-sql', 'format', 'layout', 'parameters', 'datalex', 'modeling'] },
};

const problems = [];

// The subcommand table must match the code.
for (const [key, spec] of Object.entries(SUBCOMMANDS)) {
  const top = key.split(' ')[0];
  if (!COMMANDS.has(top)) problems.push(`check-doc-commands: "${top}" is no longer a CLI command; update SUBCOMMANDS`);
  const src = commandSource(top);
  for (const word of spec.words) {
    if (!src.includes(`'${word}'`) && !src.includes(`"${word}"`)) {
      problems.push(`check-doc-commands: "zlens ${key} ${word}" is not handled in apps/cli/src/commands/${top}*.ts; update SUBCOMMANDS`);
    }
  }
}

function flagIsRead(command, flag) {
  if (UNIVERSAL_FLAGS.has(flag)) return true;
  const src = commandSource(command);
  if (src.includes(`'${flag}'`) || src.includes(`"${flag}"`)) return true;
  const props = FLAG_PROPS.get(flag) ?? [];
  return props.some((prop) => new RegExp(`flags\\??\\.${prop}\\b|\\)\\.${prop}\\b|\\b${prop}\\b\\s*[,}]`).test(src));
}

// ------------------------------------------------------------ other tools

const scaffolder = read(join(ROOT, 'packages/create-dql-app/bin/create-zlens-app.mjs'));
const SCAFFOLDER_FLAGS = new Set([...scaffolder.matchAll(/a === '(--?[a-z-]+)'/g)].map((m) => m[1]));
const starterScripts = JSON.parse(read(join(ROOT, 'packages/create-dql-app/templates/starter/package.json'))).scripts ?? {};

// ------------------------------------------------------------- extraction

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) && dir === DOCS) continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'console', 'zsh']);

/** Yield [lineNumber, text] for shell lines and inline code spans. */
function* candidates(src) {
  const lines = src.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = line.match(/^\s*(```|~~~)\s*([A-Za-z0-9_-]*)/);
    if (open) {
      if (fence === null) fence = { marker: open[1], lang: open[2].toLowerCase() };
      else if (line.trim().startsWith(fence.marker)) fence = null;
      continue;
    }
    if (fence) {
      if (SHELL_LANGS.has(fence.lang)) yield [i + 1, line];
      continue;
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      if (/^(npx |npm (exec|run) |zlens )/.test(m[1].trim())) yield [i + 1, m[1]];
    }
  }
}

function tokenize(text) {
  // Stop at comments and shell operators; keep quoted strings as one token.
  const cut = text.split(/\s#|\|\||&&|;|\||>|`/)[0];
  return [...cut.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0]);
}

const isPlaceholder = (t) => /^[<[{]|\.\.\.|…/.test(t) || /^["']/.test(t);

function checkZlens(tokens, where) {
  const [command, ...rest] = tokens;
  if (!command || command.startsWith('--')) {
    for (const flag of rest.concat(command ? [command] : []).filter((t) => t.startsWith('--'))) {
      if (!UNIVERSAL_FLAGS.has(flag)) problems.push(`${where}: unknown top-level flag ${flag}`);
    }
    return;
  }
  if (isPlaceholder(command)) return;
  if (!COMMANDS.has(command)) {
    problems.push(`${where}: "zlens ${command}" is not a CLI command`);
    return;
  }
  let key = command;
  let position = 0;
  while (SUBCOMMANDS[key] && position < rest.length) {
    const word = rest[position];
    if (word.startsWith('-') || isPlaceholder(word)) break;
    const spec = SUBCOMMANDS[key];
    if (!spec.words.includes(word)) {
      if (!spec.optional) problems.push(`${where}: "zlens ${key} ${word}" is not a known subcommand (${spec.words.join(', ')})`);
      break;
    }
    key = `${key} ${word}`;
    position++;
  }
  for (const token of rest) {
    if (!token.startsWith('--')) continue;
    const flag = token.split('=')[0];
    if (!flagIsRead(command, flag)) problems.push(`${where}: "zlens ${command}" does not read ${flag}`);
  }
}

let checked = 0;
for (const file of walk(DOCS)) {
  const src = read(file);
  const rel = relative(ROOT, file);
  for (const [lineNo, text] of candidates(src)) {
    const where = `${rel}:${lineNo}`;
    const tokens = tokenize(text.replace(/^\s*\$\s+/, '').replace(/\\\|/g, '|'));
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      // npx create-zlens-app[@version] <dir> [--flags]
      if (/^create-zlens-app(@[\w.-]+)?$/.test(t) && tokens[i - 1] === 'npx') {
        checked++;
        for (const flag of tokens.slice(i + 1).filter((x) => x.startsWith('-'))) {
          if (!SCAFFOLDER_FLAGS.has(flag)) problems.push(`${where}: create-zlens-app has no ${flag} flag`);
        }
        break;
      }
      // npm run <script> (starter scripts only)
      if (t === 'npm' && tokens[i + 1] === 'run' && tokens[i + 2] && !isPlaceholder(tokens[i + 2])) {
        checked++;
        if (!(tokens[i + 2] in starterScripts)) problems.push(`${where}: the starter project has no "npm run ${tokens[i + 2]}" script`);
        break;
      }
      if (t === 'zlens' && (i === 0 || ['npx', '--', 'exec', 'sudo'].includes(tokens[i - 1]) || /^@zlens\/cli/.test(tokens[i - 1] ?? ''))) {
        // Ignore prose such as "which -a zlens" or "npm ls -g @zlens/cli".
        if (i > 0 && !['npx', '--'].includes(tokens[i - 1]) && !/^@zlens\/cli/.test(tokens[i - 1] ?? '')) break;
        checked++;
        checkZlens(tokens.slice(i + 1), where);
        break;
      }
    }
  }
}

if (problems.length) {
  console.error(`Found ${problems.length} docs command problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`Checked ${checked} documented commands — all are real CLI commands and flags.`);
