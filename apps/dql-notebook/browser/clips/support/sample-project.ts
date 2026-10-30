import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliEntry, installDuckdbConnector, run } from '../../support/server';

/**
 * The project every feature clip runs against: the Jaffle Shop sample a new
 * user is pointed at by the README and the quickstart
 * (github.com/duckcode-ai/jaffle-shop-duckdb, MIT), pinned to one commit so
 * a re-record shows the same data.
 *
 * Preparation follows the sample's own ./setup.sh for the dbt half (Python
 * venv, dbt-duckdb, `dbt seed` + `dbt build` + `dbt docs generate`) and uses
 * the ZLens CLI built from this repo for the rest. Everything is cached under
 * the clips work dir, so only the first run needs the network.
 */

export const SAMPLE_REPO = 'https://github.com/duckcode-ai/jaffle-shop-duckdb.git';
export const SAMPLE_COMMIT = 'a9ec27779995708d961a6cfcad9ee5c049573e6e';

const COPY_EXCLUDES = new Set(['.git', '.venv', 'dbt_packages', 'logs', 'node_modules', '.dql', 'dql-manifest.json']);

function capture(command: string, args: string[], cwd?: string): string | undefined {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** A Python the sample supports (3.9–3.13), the same preference order as its setup.sh. */
function findPython(): string {
  const candidates = [process.env.PYTHON, 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const version = capture(candidate, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
    if (!version) continue;
    const [major, minor] = version.split('.').map(Number);
    if (major === 3 && minor >= 9 && minor <= 13) return candidate;
  }
  throw new Error('The Jaffle Shop sample needs Python 3.9–3.13 for dbt-duckdb. Install one, or set PYTHON=/path/to/python3.x.');
}

/** Clone + dbt-build the sample once; later runs reuse it. Returns the clone dir. */
function ensureSampleBuilt(cacheDir: string): string {
  const cloneDir = join(cacheDir, 'jaffle-shop-duckdb');
  const stamp = join(cloneDir, '.zlens-clips-built');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === SAMPLE_COMMIT) return cloneDir;

  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(join(cloneDir, '.git'))) run('git', ['clone', '--quiet', SAMPLE_REPO, cloneDir]);
  if (capture('git', ['rev-parse', 'HEAD'], cloneDir) !== SAMPLE_COMMIT) {
    run('git', ['fetch', '--quiet', 'origin'], { cwd: cloneDir });
    run('git', ['checkout', '--quiet', '--force', SAMPLE_COMMIT], { cwd: cloneDir });
  }

  if (!existsSync(join(cloneDir, '.venv', 'bin', 'dbt'))) {
    if (!existsSync(join(cloneDir, '.venv', 'bin', 'python'))) run(findPython(), ['-m', 'venv', '.venv'], { cwd: cloneDir });
    run(join(cloneDir, '.venv', 'bin', 'python'), ['-m', 'pip', 'install', '--quiet', '-r', 'requirements.txt'], { cwd: cloneDir });
  }
  const dbt = join(cloneDir, '.venv', 'bin', 'dbt');
  const env = { ...process.env, DBT_SEND_ANONYMOUS_USAGE_STATS: 'false' };
  run(dbt, ['deps', '--profiles-dir', '.'], { cwd: cloneDir, env });
  run(dbt, ['seed', '--full-refresh', '--profiles-dir', '.'], { cwd: cloneDir, env });
  run(dbt, ['build', '--profiles-dir', '.', '--exclude', 'resource_type:seed'], { cwd: cloneDir, env });
  run(dbt, ['docs', 'generate', '--profiles-dir', '.'], { cwd: cloneDir, env });
  writeFileSync(stamp, `${SAMPLE_COMMIT}\n`);
  return cloneDir;
}

/** The DuckDB driver range for the template (the same range the sample's setup.sh installs). */
export const SAMPLE_DUCKDB_RANGE = '^1.5.6-r.1';

/** The DuckDB connector, installed once and copied into each project. */
function ensureConnectors(cacheDir: string): string {
  const holder = join(cacheDir, 'connector-holder');
  const connectors = join(holder, '.dql', 'connectors');
  const stamp = join(holder, '.range');
  const current = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
  if (current !== SAMPLE_DUCKDB_RANGE || !existsSync(join(connectors, 'node_modules', '@duckdb', 'node-api'))) {
    rmSync(holder, { recursive: true, force: true });
    installDuckdbConnector(holder, SAMPLE_DUCKDB_RANGE);
    writeFileSync(stamp, `${SAMPLE_DUCKDB_RANGE}\n`);
  }
  return connectors;
}

export interface PreparedSample {
  /** The dbt-built clone of the sample (read-only; copy before use). */
  cloneDir: string;
  /** A ready-to-serve copy: connector installed, manifest compiled. */
  templateDir: string;
  /** The DuckDB connector directory to copy into other projects. */
  connectorsDir: string;
}

/**
 * Build the template project the clips copy from: a copy of the dbt-built
 * sample with the DuckDB connector installed and the ZLens manifest compiled.
 * The sample is used as it is: its `jaffle_shop_dev` connection already points
 * at its own jaffle_shop.duckdb and its certified blocks run on DuckDB.
 */
export function prepareSample(cacheDir: string): PreparedSample {
  const cloneDir = ensureSampleBuilt(cacheDir);
  const connectorsDir = ensureConnectors(cacheDir);
  const templateDir = join(cacheDir, 'template');
  rmSync(templateDir, { recursive: true, force: true });
  cpSync(cloneDir, templateDir, {
    recursive: true,
    filter: (source) => !COPY_EXCLUDES.has(source.slice(cloneDir.length + 1).split('/')[0] ?? ''),
  });
  rmSync(join(templateDir, '.zlens-clips-built'), { force: true });
  cpSync(connectorsDir, join(templateDir, '.dql', 'connectors'), { recursive: true });

  run('node', [cliEntry, 'compile', '.'], { cwd: templateDir });
  return { cloneDir, templateDir, connectorsDir };
}
