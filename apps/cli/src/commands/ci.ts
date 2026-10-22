/**
 * `zlens ci init` — write a GitHub Actions workflow that gates pull requests
 * on `zlens eval`.
 *
 * The workflow needs nothing a clean clone lacks: `zlens eval` builds the
 * manifest from source in memory, reads no warehouse and calls no model, so
 * it runs without `dql-manifest.json` (gitignored), `target/`, a `*.duckdb`
 * file, a lockfile, or an API key. The CLI is installed with `npx` at the
 * exact version that wrote the workflow, so the gate does not move when a new
 * release ships; re-run `zlens ci init --force` to upgrade it.
 *
 * Usage:
 *   zlens ci init [path]           Write .github/workflows/zlens-eval.yml at the git root
 *   zlens ci init [path] --force   Overwrite an existing workflow
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CLIFlags } from '../args.js';

export const CI_WORKFLOW_PATH = '.github/workflows/zlens-eval.yml';

const USAGE = 'Usage: zlens ci init [path] [--force]';

export function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf-8'),
    ) as { version?: string };
    return pkg.version ?? 'latest';
  } catch {
    return 'latest';
  }
}

/** The nearest folder at or above `start` holding `.git` (a directory, or a worktree's file). */
export function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The workflow text. `projectDir` is the ZLens project's folder relative to
 * the repository root, `.` when they are the same.
 */
export function renderCiWorkflow(options: { version: string; projectDir: string }): string {
  const projectDir = options.projectDir.split(sep).join('/');
  const defaults = projectDir === '.'
    ? ''
    : `    defaults:
      run:
        # The ZLens project (the folder holding dql.config.json).
        working-directory: ${projectDir}
`;
  return `# Written by \`zlens ci init\` (ZLens ${options.version}).
#
# Gates every pull request on \`zlens eval\`: each certified block's
# examples[].question, plus any eval/*.yaml cases, replayed through the agent
# router. It reads no warehouse and calls no model, so it needs no database
# file, no dbt target/, no dql-manifest.json and no API key.
#
#   --min-route-accuracy 1  every case must take the route it expects
#   --min-refusal 1         every case marked expectRefuse must refuse
#
# A threshold that no case measures is reported as n/a and not applied.
# Upgrade the pinned CLI with \`zlens ci init --force\`.
name: ZLens eval

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  eval:
    name: ZLens eval
    runs-on: ubuntu-latest
    timeout-minutes: 15
${defaults}    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Routing eval
        run: npx -y --package=@zlens/cli@${options.version} zlens eval . --min-route-accuracy 1 --min-refusal 1
`;
}

export async function runCi(subcommand: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  if (subcommand !== 'init') {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const projectRoot = resolve(rest.find((arg) => !arg.startsWith('-')) ?? '.');
  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error(
      'No ZLens project found (missing dql.config.json). Run from a project root or pass a project path.',
    );
    process.exitCode = 1;
    return;
  }

  // GitHub only reads workflows at the repository root; without git yet, the
  // project folder is the best guess for where the repository will start.
  const repoRoot = findGitRoot(projectRoot) ?? projectRoot;
  const target = join(repoRoot, CI_WORKFLOW_PATH);
  if (existsSync(target) && !flags.force) {
    console.log(`${CI_WORKFLOW_PATH} already exists — not overwriting (${target}). Pass --force to replace it.`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderCiWorkflow({
    version: cliVersion(),
    projectDir: relative(repoRoot, projectRoot) || '.',
  }), 'utf-8');
  console.log(`Wrote ${target}`);
  console.log('Commit it: every pull request now runs `zlens eval . --min-route-accuracy 1 --min-refusal 1`.');
  console.log('Run the same command locally first; it must pass before the gate is useful.');
}
