#!/usr/bin/env node
// Fails when ZLens's code runs an external program that the app image does not have.
//
// V14: the copy of the project to the customer's backup stage ran tar, gzip and sync. The distroless app image
// (#331) has none of them, so the copy failed in every install while every test passed on machines that have tar.
//
//   node check-programs.mjs [--strict] <folder>...
//
// It reads the JavaScript (or TypeScript) ZLens ships under each folder. It skips tests, browser bundles
// (assets/) and third-party packages: of node_modules, only @zlens/* is read. These count as running a program:
//   - a call that names it: execFileSync("tar", ...), spawn("git", ...), this.run("sync", []), run("git rev-parse");
//   - execSync(...), exec(...) and { shell: true }, which run /bin/sh.
// A program the image has (on PATH, where this runs) is fine. One it lacks is allowed only where LAPTOP_ONLY lists
// it, at most that many times: laptop features that say so, or carry on, when the program is missing. --strict treats
// every program as missing, for a check outside the image (the unit test runs it that way over the sources).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

/** Programs ZLens code might run. The app image has none of them (it has Node only, at /nodejs/bin/node). */
const PROGRAMS = new Set([
  'tar', 'gzip', 'gunzip', 'zcat', 'bzip2', 'xz', 'zip', 'unzip', 'sync', 'sh', 'bash', 'zsh', 'dash',
  'git', 'gh', 'dbt', 'mf', 'rg', 'grep', 'find', 'sed', 'awk', 'cp', 'mv', 'rm', 'ls', 'cat', 'chmod', 'chown',
  'mkdir', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'python', 'python3', 'pip', 'pip3', 'npm', 'npx', 'pnpm', 'yarn',
  'node', 'docker', 'open', 'xdg-open', 'kill', 'ps', 'which', 'sudo', 'su',
]);

/**
 * Where a program the image lacks may still be run, by module (file name without extension), and how many times.
 * Each is a laptop or Enterprise feature that handles the program being missing. Nothing here may be needed by the
 * app for Snowflake: never add tar, gzip or sync (backups), and add nothing without saying why.
 */
const LAPTOP_ONLY = {
  git: {
    'certification-receipt': 3, // the branch and git user.name/config for a receipt: try/catch, undefined without git
    identity: 1, // git user.email for "Recorded as": try/catch; the Snowflake app names the Snowflake user
    'repo-resolver': 5, // a semantic layer read from a git repository: not offered in the Snowflake app
    'app-diff': 1, // `zlens app diff`, a terminal command
    doctor: 2, // `zlens doctor`, a terminal command
    'local-runtime': 4, // Source control (execGit reports git missing) and readGitMetadata (try/catch)
    digest: 1, // the commit of a block for a digest: try/catch
  },
  sh: {
    'local-runtime': 1, // readGitMetadata runs git through execSync: try/catch
    digest: 1, // resolveGitSha runs git through execSync: try/catch
  },
  gh: { 'local-runtime': 1 }, // Source control pull requests: laptop only, says gh is missing
  dbt: { 'local-runtime': 1 }, // dbt parse for a dbt project: no dbt project in the Snowflake app
  rg: { 'answer-loop-tools': 1 }, // project text search: falls back to a search in Node when rg is missing
};

const NAMED_CALL = /(?<![\w$])(execFileSync|execFile|spawnSync|spawn|execSync|run|runGit|runCommand)\s*\(\s*(['"`])([A-Za-z0-9_./-]+)/g;
// exec(...) runs a shell; x.exec(...) is almost always a regular expression, unless x is child_process.
const SHELL_CALL = /(?<![\w$])execSync\s*\(|(?<![\w$.])exec\s*\(|\b(?:child_process|childProcess|cp)\.exec\s*\(|\bshell\s*:\s*true\b/g;
const SOURCE = /\.(?:[cm]?js|ts)$/;
const SKIPPED_FILE = /(?:\.d\.ts|\.map|\.(?:test|spec)\.[cm]?[jt]s)$/;
const SKIPPED_DIR = new Set(['assets', 'test', 'tests', '__tests__', 'fixtures', '.cache']);

/** Every source file ZLens ships under `root`. */
function sourceFiles(root) {
  const files = [];
  const seen = new Set();
  // A deployed package can link to itself from its own node_modules (pnpm deploy): read it once.
  let own;
  try { own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name; } catch { own = undefined; }
  const walk = (dir, inNodeModules) => {
    let real;
    try { real = realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let info;
      try { info = statSync(path); } catch { continue; }
      if (info.isDirectory()) {
        if (SKIPPED_DIR.has(name) || name === '.pnpm') continue;
        if (name === 'node_modules') {
          const scoped = join(path, '@zlens');
          if (existsSync(scoped)) for (const pkg of readdirSync(scoped)) if (`@zlens/${pkg}` !== own) walk(join(scoped, pkg), true);
          continue;
        }
        walk(path, inNodeModules);
      } else if (SOURCE.test(name) && !SKIPPED_FILE.test(name)) {
        files.push(path);
      }
    }
  };
  walk(root, false);
  return files;
}

/** The programs one file runs: [program, count]. */
export function programsIn(text) {
  const found = new Map();
  const add = (program) => found.set(program, (found.get(program) ?? 0) + 1);
  for (const match of text.matchAll(NAMED_CALL)) {
    const program = match[3].split('/').pop();
    if (PROGRAMS.has(program)) add(program);
  }
  for (const match of text.matchAll(SHELL_CALL)) add('sh');
  return found;
}

function onPath(program) {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => existsSync(join(dir, program)));
}

/** Every program the code under `roots` runs that the image lacks, beyond what LAPTOP_ONLY allows. */
export function check(roots, { strict = false } = {}) {
  const used = new Map(); // program -> module -> count
  let files = 0;
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      files += 1;
      const module = basename(file).replace(/\.(?:[cm]?js|ts)$/, '');
      for (const [program, count] of programsIn(readFileSync(file, 'utf8'))) {
        const byModule = used.get(program) ?? new Map();
        byModule.set(module, (byModule.get(module) ?? 0) + count);
        used.set(program, byModule);
      }
    }
  }
  const problems = [];
  for (const [program, byModule] of used) {
    if (!strict && onPath(program)) continue;
    for (const [module, count] of byModule) {
      const allowed = LAPTOP_ONLY[program]?.[module] ?? 0;
      if (count > allowed) problems.push(`${module} runs ${program} ${count === 1 ? 'once' : `${count} times`}${allowed ? ` (${allowed} allowed)` : ''}, and the app image has no ${program}.`);
    }
  }
  return { files, problems, used };
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const roots = args.filter((arg) => arg !== '--strict');
  if (!roots.length) {
    console.error('usage: check-programs.mjs [--strict] <folder>...');
    process.exit(2);
  }
  const { files, problems } = check(roots, { strict });
  if (!files) {
    console.error(`No source files under ${roots.join(', ')}.`);
    process.exit(2);
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error('Do it inside Node instead (see apps/cli/src/project-archive.ts), or, for a laptop-only feature that handles the program being missing, list it in LAPTOP_ONLY with the reason.');
    process.exit(1);
  }
  console.log(`${files} files: every program they run is in the image, or is laptop-only and listed.`);
}
