import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * V14: the copy to the backup stage ran tar, gzip and sync, which the app image (distroless, #331) does not have.
 * deploy/snowflake-app/check-programs.mjs fails when ZLens code runs a program the image lacks; scan-image.sh runs
 * it inside the image, and this runs it over the sources (strict: as if no program were there).
 */
const REPO = join(__dirname, '..', '..', '..');
const CHECK = join(REPO, 'deploy', 'snowflake-app', 'check-programs.mjs');
/** The CLI and the workspace packages it ships with (pnpm deploy --prod --filter @zlens/cli). */
const SHIPPED = ['apps/cli/src', ...['dql-agent', 'dql-connectors', 'dql-core', 'dql-compiler', 'dql-governance', 'dql-mcp', 'dql-notebook', 'dql-project', 'dql-slack'].map((name) => `packages/${name}/src`)];

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-programs-'));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

function check(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [CHECK, ...args], { cwd: REPO, encoding: 'utf8', env });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('every program the app code runs is in the image', () => {
  it('holds for the code ZLens ships: no tar, gzip, sync or shell, and only listed laptop uses of git, gh, dbt and rg', () => {
    const result = check(['--strict', ...SHIPPED]);
    expect(result.out).toMatch(/files: every program they run is in the image/);
    expect(result.status).toBe(0);
  });

  it('fails on the V13 backup code, which ran tar and sync', () => {
    const root = tree({
      'dist/snowflake-app-backups.js': [
        "this.run = options.run ?? ((command, args) => { execFileSync(command, args, { stdio: 'ignore' }); });",
        "try { this.run('sync', []); } catch { }",
        "this.run('tar', ['-czf', file, '-C', workspace, '.']);",
        "this.run('tar', ['-xzf', archive, '-C', staging, '-m']);",
      ].join('\n'),
    });
    const result = check(['--strict', root]);
    expect(result.status).toBe(1);
    expect(result.out).toContain('snowflake-app-backups runs tar 2 times, and the app image has no tar.');
    expect(result.out).toContain('snowflake-app-backups runs sync once, and the app image has no sync.');
  });

  it('counts each way of running a program, and the shell', () => {
    const root = tree({
      'dist/a.js': "spawn('gzip', ['-c']); spawnSync(\"bash\", ['-c', 'x']); execFileSync(\n  'git',\n  ['status']);",
      'dist/b.mjs': "execSync('ls -la'); const out = cp.exec(command); x.exec('not a program'); spawn(cmd, args, { shell: true });",
    });
    const result = check(['--strict', root]);
    expect(result.status).toBe(1);
    for (const line of ['a runs gzip once', 'a runs bash once', 'a runs git once', 'b runs ls once', 'b runs sh 3 times']) expect(result.out).toContain(line);
    // A regular expression's exec is not a program.
    expect(result.out).not.toContain('not a program');
  });

  it('allows a listed laptop use up to its count, and no more', () => {
    expect(check(['--strict', tree({ 'dist/identity.js': "execFileSync('git', ['config', 'user.email']);" })]).status).toBe(0);
    const twice = check(['--strict', tree({ 'dist/identity.js': "execFileSync('git', ['config', 'user.email']); execFileSync('git', ['log']);" })]);
    expect(twice.status).toBe(1);
    expect(twice.out).toContain('identity runs git 2 times (1 allowed)');
  });

  it('reads @zlens packages and skips tests, browser bundles and other packages', () => {
    const root = tree({
      'package.json': '{"name":"@zlens/cli"}',
      'dist/index.js': 'export {};',
      'dist/index.test.js': "spawn('tar');",
      'dist/assets/app.js': "n.run(\"git\")",
      'node_modules/@zlens/core/dist/zip.js': "spawn('unzip', [file]);",
      'node_modules/@zlens/cli/dist/self.js': "spawn('tar');",
      'node_modules/other/index.js': "spawn('tar');",
    });
    const result = check(['--strict', root]);
    expect(result.status).toBe(1);
    expect(result.out).toContain('zip runs unzip once');
    expect(result.out).not.toMatch(/tar|git/);
  });

  it('inside an image that has the program, it is fine', () => {
    const bin = tree({ 'tar': '#!/bin/sh\n' });
    chmodSync(join(bin, 'tar'), 0o755);
    const root = tree({ 'dist/x.js': "spawn('tar', ['-xzf', file]);" });
    expect(check([root], { ...process.env, PATH: bin }).status).toBe(0);
    expect(check([root], { ...process.env, PATH: tree({}) }).status).toBe(1);
  });

  it('says how to use it when it is given nothing to read', () => {
    expect(check([]).status).toBe(2);
    expect(check([tree({ 'README.md': 'no code' })]).status).toBe(2);
  });
});
