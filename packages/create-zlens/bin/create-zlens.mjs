#!/usr/bin/env node
// `npm create zlens@latest [folder]`: create a ZLens project and open the
// workbench, in one command. It runs `zlens notebook <folder> --yes`, which
// creates the project when the folder has none (a dbt project, a DuckDB or
// SQLite file, or a folder of CSV, Parquet or JSON files is picked up) and
// opens it. With no folder, it uses the current folder when that already
// holds a project or data, else asks for a new folder's name.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const DEFAULT_FOLDER = 'my-analytics';

const HELP = `
  npm create zlens@latest [folder] [-- <zlens notebook options>]

  Creates a ZLens project in <folder> and opens the workbench.
  The folder can be a dbt project, hold a DuckDB or SQLite file, or a folder of
  CSV, Parquet or JSON files; ZLens picks up what it finds.

  With no folder: the current folder when it holds a project or data,
  else a new folder (asks for its name; ${DEFAULT_FOLDER} by default).

  Examples:
    npm create zlens@latest                  # here, or a new folder
    npm create zlens@latest ./shop           # a folder with shop.duckdb or CSV files
    npm create zlens@latest my-analytics -- --port 4000
`;

/** The folder argument and the options passed through to `zlens notebook`. */
export function parseCreateArgs(argv) {
  // npm passes what follows its own `--` without it; run directly, `--` ends this command's options.
  const separator = argv.indexOf('--');
  const own = separator < 0 ? argv : argv.slice(0, separator);
  const after = separator < 0 ? [] : argv.slice(separator + 1);
  if (own.some((arg) => arg === '--help' || arg === '-h')) return { help: true, folder: null, passThrough: [] };
  // An option's value (`--port 4000`) is not the folder: only a first word counts.
  const folder = own[0] && !own[0].startsWith('-') ? own[0] : null;
  return { help: false, folder, passThrough: [...own.slice(folder ? 1 : 0), ...after] };
}

/** A project or data the CLI would pick up in `dir`, in plain words, or null. */
export async function whatIsHere(dir) {
  if (existsSync(resolve(dir, 'dql.config.json'))) return 'a ZLens project';
  const { detectFolderContents } = await import('@zlens/cli/dist/commands/init.js');
  const { describeFolder } = await import('@zlens/cli/dist/commands/bare-folder.js');
  const found = describeFolder(detectFolderContents(dir));
  return found || null;
}

/** The folder to use when none was given. */
export async function chooseFolder({ cwd, interactive, ask }) {
  const here = await whatIsHere(cwd);
  if (!interactive || !ask) return here ? '.' : DEFAULT_FOLDER;
  const fallback = here ? '.' : DEFAULT_FOLDER;
  const prompt = here
    ? `  Found ${here} here. Project folder (. for here): `
    : `  Project folder (${DEFAULT_FOLDER}): `;
  const answer = (await ask(prompt)).trim();
  return answer || fallback;
}

/**
 * Create the project in `folder` when it has none of its own, so the
 * workbench opens it and not a project in a folder above it. Running
 * `npm create zlens` is the consent; `zlens notebook` alone still asks.
 */
export async function createProjectIn(folder) {
  const target = resolve(folder);
  if (existsSync(join(target, 'dql.config.json'))) return false;
  mkdirSync(target, { recursive: true });
  const { runInit } = await import('@zlens/cli/dist/commands/init.js');
  await runInit(target, { format: 'text', force: false, open: false }, { output: 'summary' });
  return existsSync(join(target, 'dql.config.json'));
}

async function askInTerminal(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function main() {
  const { help, folder: given, passThrough } = parseCreateArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP);
    return;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let folder;
  try {
    folder = given ?? await chooseFolder({ cwd: process.cwd(), interactive, ask: askInTerminal });
  } catch (error) {
    // Ctrl+C or Ctrl+D at the question: stop, having made nothing.
    if (error?.name !== 'AbortError') throw error;
    console.log('\n  Nothing was created.');
    process.exitCode = 130;
    return;
  }
  // Exactly what `zlens notebook <folder> --yes` does, in this process so the
  // terminal (Ctrl+C, the browser prompt) stays the same. A repair message
  // (npm 12 blocking an install script) says to run `npm create zlens` again
  // with these arguments.
  process.env.ZLENS_CREATE_ARGS = JSON.stringify([folder, ...passThrough]);
  await createProjectIn(folder);
  process.argv = [process.argv[0], process.argv[1], 'notebook', folder, '--yes', ...passThrough];
  await import('@zlens/cli/dist/index.js');
}

const invokedDirectly = process.argv[1] && /create-zlens(?:\.mjs)?$/.test(process.argv[1]);
if (invokedDirectly) await main();
