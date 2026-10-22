import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load as loadYaml } from 'js-yaml';
import { CI_WORKFLOW_PATH, cliVersion, renderCiWorkflow, runCi } from './ci.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempRepo(projectDir = '.'): { repoRoot: string; projectRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'zlens-ci-init-'));
  tempDirs.push(repoRoot);
  mkdirSync(join(repoRoot, '.git'));
  const projectRoot = join(repoRoot, projectDir);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'ci_demo' }), 'utf-8');
  return { repoRoot, projectRoot };
}

interface Workflow {
  on: { pull_request: unknown; push: { branches: string[] } };
  permissions: Record<string, string>;
  jobs: { eval: { defaults?: { run: { 'working-directory': string } }; steps: Array<{ uses?: string; run?: string }> } };
}

describe('renderCiWorkflow', () => {
  it('runs zlens eval at strict thresholds with the CLI pinned and no install step', () => {
    const workflow = loadYaml(renderCiWorkflow({ version: '0.2.3', projectDir: '.' })) as Workflow;
    expect(workflow.on.pull_request).toBeNull();
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.eval.defaults).toBeUndefined();

    const runs = workflow.jobs.eval.steps.flatMap((step) => (step.run ? [step.run] : []));
    expect(runs).toEqual([
      'npx -y --package=@zlens/cli@0.2.3 zlens eval . --min-route-accuracy 1 --min-refusal 1',
    ]);
    // No `npm ci` (samples ship no lockfile), no compile/verify of a gitignored
    // manifest, and no dbt or warehouse step.
    expect(runs.join('\n')).not.toMatch(/npm ci|zlens compile|zlens verify|dbt /);
  });

  it('sets the working directory when the project is in a subfolder of the repository', () => {
    const workflow = loadYaml(renderCiWorkflow({ version: '0.2.3', projectDir: 'analytics/zlens' })) as Workflow;
    expect(workflow.jobs.eval.defaults?.run['working-directory']).toBe('analytics/zlens');
  });
});

describe('runCi', () => {
  it('writes the workflow at the git root for a project at the root', async () => {
    const { repoRoot } = tempRepo();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCi('init', [repoRoot], {} as never);

    const text = readFileSync(join(repoRoot, CI_WORKFLOW_PATH), 'utf-8');
    expect(text).toContain(`--package=@zlens/cli@${cliVersion()} zlens eval .`);
    expect(text).not.toContain('working-directory');
    expect(process.exitCode).toBeUndefined();
  });

  it('writes at the git root with a working-directory for a nested project', async () => {
    const { repoRoot, projectRoot } = tempRepo('dql');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCi('init', [projectRoot], {} as never);

    expect(existsSync(join(projectRoot, CI_WORKFLOW_PATH))).toBe(false);
    const workflow = loadYaml(readFileSync(join(repoRoot, CI_WORKFLOW_PATH), 'utf-8')) as Workflow;
    expect(workflow.jobs.eval.defaults?.run['working-directory']).toBe('dql');
  });

  it('keeps an existing workflow unless --force is passed', async () => {
    const { repoRoot } = tempRepo();
    const target = join(repoRoot, CI_WORKFLOW_PATH);
    mkdirSync(join(repoRoot, '.github', 'workflows'), { recursive: true });
    writeFileSync(target, 'name: mine\n', 'utf-8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCi('init', [repoRoot], {} as never);
    expect(readFileSync(target, 'utf-8')).toBe('name: mine\n');
    expect(String(log.mock.calls[0]?.[0])).toContain('already exists');

    await runCi('init', [repoRoot], { force: true } as never);
    expect(readFileSync(target, 'utf-8')).toContain('name: ZLens eval');
  });

  it('refuses a folder that is not a ZLens project, and an unknown subcommand', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'zlens-ci-empty-'));
    tempDirs.push(empty);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCi('init', [empty], {} as never);
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(empty, CI_WORKFLOW_PATH))).toBe(false);

    process.exitCode = undefined;
    await runCi('setup', [], {} as never);
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toBe('Usage: zlens ci init [path] [--force]');
  });
});
