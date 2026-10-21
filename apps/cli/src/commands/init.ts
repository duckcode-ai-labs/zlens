import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createWelcomeNotebook, serializeNotebook } from '@zlens/notebook';
import { resolveLocalOwner, seedDefaultSkills, seedDomainSkills } from '@zlens/agent';
import { buildManifest } from '@zlens/core';
import type { CLIFlags } from '../args.js';
import { ensureDqlGitignore } from '../git-contract.js';
import { runNotebook } from './notebook.js';

/** What a folder already holds: a dbt project (here or a level up) and a DuckDB file. */
export interface FolderContents {
  isDbt: boolean;
  dbtProjectDir: string | null;
  /** A DuckDB file, relative to the folder (e.g. `jaffle_shop.duckdb` or `../dev.duckdb`). */
  duckdbPath: string | null;
}

/**
 * Detect a dbt project — either *in* this directory, or as a sibling (the
 * canonical `acme/dbt/` + `acme/analytics/` layout) — and a DuckDB file, in the
 * workspace OR the dbt project dir (the .duckdb often lives next to
 * dbt_project.yml, a level up from the ZLens workspace).
 */
export function detectFolderContents(targetDir: string): FolderContents {
  let isDbt = existsSync(join(targetDir, 'dbt_project.yml'));
  let dbtProjectDir: string | null = isDbt ? targetDir : null;
  if (!dbtProjectDir) {
    for (const rel of ['..', '../..', '../dbt', '../../dbt']) {
      const probe = join(targetDir, rel, 'dbt_project.yml');
      if (existsSync(probe)) {
        dbtProjectDir = resolve(targetDir, rel);
        isDbt = true;
        break;
      }
    }
  }
  return { isDbt, dbtProjectDir, duckdbPath: detectDuckDBFile(targetDir, dbtProjectDir) };
}

/**
 * The project type a folder gets: dbt-first with a dbt project, database only
 * (warehouse-first, RFC 0007) with a database file and no dbt, and undecided
 * otherwise — Guided Setup then asks where the data lives.
 */
export function initProjectKind(contents: FolderContents, warehouseFirstFlag = false): 'dbt' | 'database' | 'undecided' {
  if (contents.isDbt) return 'dbt';
  if (warehouseFirstFlag || contents.duckdbPath) return 'database';
  return 'undecided';
}

export async function runInit(
  targetArg: string | null,
  flags: CLIFlags,
  /** `summary`: one line instead of the full report, for `zlens notebook <folder>` creating a project. */
  options: { output?: 'full' | 'summary' } = {},
): Promise<void> {
  const targetDir = resolve(targetArg || '.');
  const projectName = basename(targetDir) || 'dql-project';

  // Create target directory if it doesn't exist
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Refuse to clobber a project that's already been initialized. `--force`
  // lets us patch missing dirs; it still won't overwrite config/notebooks.
  const alreadyInitialized =
    existsSync(join(targetDir, 'dql.config.json')) || existsSync(join(targetDir, 'cdql.yaml'));
  if (alreadyInitialized && !flags.force) {
    console.error('✗ This directory already has a ZLens project (dql.config.json exists).');
    console.error('  Re-run with --force to patch missing dirs without overwriting config.');
    process.exitCode = 1;
    return;
  }

  const contents = detectFolderContents(targetDir);
  const { isDbt, dbtProjectDir, duckdbPath } = contents;
  // A database file and no dbt project is a database-only project: no flag needed.
  const warehouseFirst = initProjectKind(contents, flags.warehouseFirst === true) === 'database';

  // Don't overwrite existing dql.config.json
  const configPath = join(targetDir, 'dql.config.json');
  if (!alreadyInitialized) {
    // Resolve the local OSS owner up front (git user.email → $USER → guest@local)
    // and persist it as identity.owner so drafts are never born "Missing owner".
    const owner = resolveLocalOwner(targetDir, { persist: false });
    const config = buildConfig(projectName, isDbt, duckdbPath, dbtProjectDir, targetDir, owner, warehouseFirst);
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  // Create DQL directories
  // New OSS projects are domain-first and keep shared skills visible at the
  // project root. Legacy folders remain supported by the compiler/migrator.
  const dirs = ['domains', 'skills', 'notebooks', 'apps', 'tests', 'tests/blocks', 'tests/agent-evals'];
  if (!isDbt) {
    dirs.push('semantic-layer', 'semantic-layer/metrics', 'semantic-layer/dimensions');
  }
  for (const dir of dirs) {
    const dirPath = join(targetDir, dir);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  // UI-001, SEC-001, E2E-001: repair the legacy broad `.dql/` ignore while
  // retaining local runtime and credential exclusions. This also applies to
  // `zlens init --force` repairs of existing projects.
  ensureDqlGitignore(targetDir);

  // `--force` on an initialized project is intentionally a directory repair,
  // not an implicit migration. Leave config and every existing or missing
  // content file alone; explicit migration commands own format changes.
  if (alreadyInitialized) {
    if (flags.format === 'json') {
      console.log(JSON.stringify({
        project: projectName,
        path: targetDir,
        created: false,
        patchedDirectories: true,
      }, null, 2));
    } else {
      console.log(`\n  ✓ Patched missing DQL directories: ${projectName}`);
      console.log('    Existing config and authored content files were not changed; Git ignore rules were safely repaired.');
    }
    return;
  }

  const projectConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    manifestVersion?: number;
    modeling?: { mode?: string };
    defaultConnectionName?: string;
    connections?: Record<string, { driver?: string }>;
  };

  // Create welcome notebook with driver-aware SQL
  const notebookPath = join(targetDir, 'notebooks', 'welcome.dqlnb');
  if (!existsSync(notebookPath)) {
    const defaultConnectionName = typeof projectConfig.defaultConnectionName === 'string'
      ? projectConfig.defaultConnectionName
      : 'default';
    const driver = projectConfig.connections?.[defaultConnectionName]?.driver
      ?? projectConfig.connections?.default?.driver;
    const nb = createWelcomeNotebook(isDbt ? 'dbt' : 'default', projectName, driver);
    writeFileSync(notebookPath, serializeNotebook(nb), 'utf-8');
  }

  // Seed the editable starter skills into skills/ (idempotent — never
  // clobbers user edits). For dbt-first projects these skills read dbt-owned
  // semantic metadata through the manifest; init never copies it locally.
  let seededSkills = 0;
  try {
    seededSkills = seedDefaultSkills(targetDir).created.length;
    // W4.5 — also draft one editable reference skill per domain from the manifest.
    try {
      seededSkills += seedDomainSkills(targetDir, buildManifest({ projectRoot: targetDir })).created.length;
    } catch {
      // Domain skills need a compilable manifest; best-effort like the starters.
    }
  } catch {
    // Skill seeding is best-effort; never fail `zlens init` over it.
  }

  // Output
  if (flags.format === 'json') {
    console.log(JSON.stringify({
      project: projectName,
      path: targetDir,
      created: true,
      dbt: isDbt,
      manifestVersion: projectConfig.manifestVersion ?? 2,
      modelingMode: projectConfig.modeling?.mode ?? null,
      duckdb: duckdbPath ?? null,
      seededSkills,
    }, null, 2));
    return;
  }

  if (options.output === 'summary') {
    const kind = isDbt ? 'dbt project' : projectConfig.modeling?.mode === 'warehouse-first' ? 'Database only' : 'no data source yet';
    console.log(`\n  ✓ Created a ZLens project in ${targetDir} (${kind}${duckdbPath ? ` · ${duckdbPath}` : ''}).`);
    return;
  }

  console.log(`\n  ✓ ZLens project initialized: ${projectName}`);
  console.log(`    Path: ${targetDir}`);
  console.log('');
  console.log('  Detected:');
  if (isDbt && dbtProjectDir && dbtProjectDir !== targetDir) {
    console.log(`    dbt project: sibling at ${dbtProjectDir}`);
  } else {
    console.log(`    dbt project: ${isDbt ? 'yes (dbt_project.yml found)' : 'no'}`);
  }
  console.log(`    DuckDB file: ${duckdbPath ?? 'none'}`);
  if (isDbt) {
    if (projectConfig.manifestVersion === 3 && projectConfig.modeling?.mode === 'dbt-first') {
      console.log('    Modeling: manifest v3, dbt-first (dbt artifacts remain read-only)');
    } else {
      console.log(`    Modeling: preserved existing manifest v${projectConfig.manifestVersion ?? 2} configuration`);
    }
  } else if (projectConfig.manifestVersion === 3 && projectConfig.modeling?.mode === 'warehouse-first') {
    console.log('    Project type: Database only (ZLens reads the database\'s tables; no dbt needed)');
  }
  console.log('');
  console.log('  Created:');
  console.log('    dql.config.json');
  console.log('    domains/ (domain-owned modeling, knowledge, governance, and assets)');
  console.log('    skills/ (shared agent guidance)');
  console.log('    tests/');
  console.log('    apps/ (shared products)');
  console.log('    notebooks/welcome.dqlnb (shared research workspace)');
  if (seededSkills > 0) {
    console.log(`    skills/ (${seededSkills} editable starter skill${seededSkills === 1 ? '' : 's'})`);
  }
  console.log('');
  console.log('  Next steps:');
  const step = targetArg && targetArg !== '.' ? 1 : 0;
  if (step === 1) console.log(`    ${step}. cd ${targetArg}`);
  // E2E-005: `npx zlens` works for both project-local and global installs. A
  // bare `zlens` only works after a global install and was misleading for the
  // recommended existing-repo `npm i -D` path.
  console.log(`    ${step + 1}. npx zlens doctor`);
  if (isDbt) {
    console.log(`    ${step + 2}. npx zlens notebook`);
    console.log(`    ${step + 3}. npx zlens compile .`);
    console.log(`    ${step + 4}. npx zlens sync dbt .`);
  } else if (projectConfig.modeling?.mode === 'warehouse-first') {
    console.log(`    ${step + 2}. npx zlens notebook   (Guided Setup: choose the schemas ZLens reads, then Draft my models)`);
  } else {
    // No dbt project and no database file yet: Guided Setup asks where the data lives.
    console.log(`    ${step + 2}. npx zlens notebook   (Guided Setup asks whether you use dbt or a database only)`);
  }
  console.log('');

  if (flags.open) {
    await runNotebook(targetDir, flags);
  }
}

function detectDuckDBFile(workspaceDir: string, dbtProjectDir: string | null): string | null {
  // Common DuckDB file locations in dbt projects
  const candidates = [
    'jaffle_shop.duckdb',
    'dev.duckdb',
    'database.duckdb',
    'analytics.duckdb',
    'target/dev.duckdb',
    'target/jaffle_shop.duckdb',
    'reports/jaffle_shop.duckdb',
  ];
  // 1. The ZLens workspace itself — store a bare relative path.
  for (const candidate of candidates) {
    if (existsSync(join(workspaceDir, candidate))) return candidate;
  }
  const inWorkspace = firstDuckDBIn(workspaceDir);
  if (inWorkspace) return inWorkspace;

  // 2. The dbt project dir (often a level up). Store the path RELATIVE TO THE
  // workspace (e.g. `../jaffle_shop.duckdb`) so the stored connection — which
  // resolves relative filepaths against the workspace — opens the real file.
  if (dbtProjectDir && resolve(dbtProjectDir) !== resolve(workspaceDir)) {
    for (const candidate of candidates) {
      const abs = join(dbtProjectDir, candidate);
      if (existsSync(abs)) return relative(workspaceDir, abs) || candidate;
    }
    const inDbt = firstDuckDBIn(dbtProjectDir);
    if (inDbt) return relative(workspaceDir, join(dbtProjectDir, inDbt)) || inDbt;
  }
  return null;
}

function firstDuckDBIn(dir: string): string | null {
  try {
    return readdirSync(dir).find((entry: string) => entry.endsWith('.duckdb')) ?? null;
  } catch {
    return null;
  }
}

function buildConfig(
  projectName: string,
  isDbt: boolean,
  duckdbPath: string | null,
  dbtProjectDir: string | null,
  projectRoot: string,
  owner?: string,
  warehouseFirst = false,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    project: projectName,
    layout: {
      version: 2,
      mode: 'oss-dbt-workspace',
      skillsPath: 'skills',
    },
  };

  // Field-based Dataset tiles are on by default (APP-007); new projects write
  // the switch explicitly so `apps.datasets: false` is easy to find.
  config.apps = { datasets: true };

  // Persist the resolved local owner so AI-drafted blocks pass the Certifier's
  // owner rule out of the box (humans still certify).
  if (owner && owner.trim()) {
    config.identity = { owner: owner.trim() };
  }

  if (duckdbPath) {
    config.defaultConnectionName = 'default';
    config.connections = {
      default: {
        driver: 'duckdb',
        filepath: duckdbPath,
      },
    };
  }

  if (isDbt) {
    // Normalize dbt path to a repo-relative form if possible — makes
    // dql.config.json portable across machines.
    const projectPath =
      dbtProjectDir && dbtProjectDir !== projectRoot
        ? relativePath(projectRoot, dbtProjectDir)
        : '.';
    config.semanticLayer = {
      provider: 'dbt',
      projectPath,
    };
    config.manifestVersion = 3;
    config.modeling = { mode: 'dbt-first' };
    // Tell `zlens sync dbt` and `zlens compile` where to find target/manifest.json
    // without requiring --dbt-manifest on every invocation.
    config.dbt = {
      projectDir: projectPath,
      manifestPath: 'target/manifest.json',
    };
  } else {
    config.semanticLayer = {
      provider: 'dql',
    };
    if (warehouseFirst) {
      // RFC 0007: model the warehouse's own tables. `zlens sync warehouse`
      // reads their columns and declared keys; entities bind with `relation:`.
      config.manifestVersion = 3;
      config.modeling = { mode: 'warehouse-first' };
    }
  }

  return config;
}

function relativePath(from: string, to: string): string {
  return relative(from, to) || '.';
}
