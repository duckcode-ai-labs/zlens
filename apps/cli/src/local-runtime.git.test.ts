import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@zlens/connectors';
import {
  friendlyGitRemoteError,
  isZLensSampleRemote,
  resolveBlockHistoryPath,
  startLocalServer,
  validateGitRemoteName,
  validateGitRemoteUrl,
} from './local-runtime.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'dql.config.json'), '{}\n');
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=DQL Test',
    '-c', 'user.email=dql-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function withServer<T>(projectRoot: string, run: (base: string) => Promise<T>): Promise<T> {
  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolveClose) => server ? server.close(() => resolveClose()) : resolveClose());
  }
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/**
 * `git init` plus a repository-local identity. Commits made by the server
 * (`/api/git/commit`) read it; without one they depend on the machine's global
 * git config, and a CI runner that has none answers 400 ("Author identity
 * unknown").
 */
function initRepo(dir: string): void {
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'DQL Test']);
  git(dir, ['config', 'user.email', 'dql-test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function committedProject(prefix: string): string {
  const dir = tempProject(prefix);
  initRepo(dir);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'first']);
  return dir;
}

describe('discarding never destroys work git cannot return', () => {
  it('reverts a tracked file, recovers an untracked one, and leaves ignored paths alone', async () => {
    const project = committedProject('dql-git-discard-');
    writeFileSync(join(project, 'dql.config.json'), '{"project":"edited"}\n');
    mkdirSync(join(project, 'notebooks'), { recursive: true });
    writeFileSync(join(project, 'notebooks', 'scratch.dqlnb'), '{"cells":[]}\n');
    writeFileSync(join(project, '.gitignore'), 'ignored.txt\n');
    git(project, ['add', '.gitignore']);
    git(project, ['commit', '-m', 'ignore']);
    writeFileSync(join(project, 'ignored.txt'), 'local only\n');

    await withServer(project, async (base) => {
      const res = await postJson(`${base}/api/git/discard`, {
        paths: ['dql.config.json', 'notebooks/scratch.dqlnb', 'ignored.txt'],
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        reverted?: string[];
        recovered?: { trashPath: string; files: string[] };
        skipped?: string[];
      };

      expect(body.ok).toBe(true);
      // Tracked edit goes back to the committed content.
      expect(body.reverted).toEqual(['dql.config.json']);
      expect(readFileSync(join(project, 'dql.config.json'), 'utf-8')).toBe('{}\n');
      // The never-committed notebook leaves the worktree but stays recoverable.
      expect(body.recovered?.files).toEqual(['notebooks/scratch.dqlnb']);
      expect(existsSync(join(project, 'notebooks', 'scratch.dqlnb'))).toBe(false);
      const recoveredFile = join(project, body.recovered!.trashPath, 'files', 'notebooks', 'scratch.dqlnb');
      expect(readFileSync(recoveredFile, 'utf-8')).toBe('{"cells":[]}\n');
      expect(existsSync(join(project, body.recovered!.trashPath, 'recovery.json'))).toBe(true);
      // An ignored path is local state: say so instead of reporting success.
      expect(body.skipped).toEqual(['ignored.txt']);
      expect(existsSync(join(project, 'ignored.txt'))).toBe(true);
    });
  });
});

describe('a commit keeps only what was chosen', () => {
  it('commits the named paths and refuses when nothing is selected', async () => {
    const project = committedProject('dql-git-commit-');
    writeFileSync(join(project, 'wanted.dql'), 'block wanted {}\n');
    writeFileSync(join(project, 'unwanted.dql'), 'block unwanted {}\n');

    await withServer(project, async (base) => {
      const chosen = await postJson(`${base}/api/git/commit`, { message: 'keep one', paths: ['wanted.dql'] });
      expect(chosen.status).toBe(200);
      expect(git(project, ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('wanted.dql');

      const empty = await postJson(`${base}/api/git/commit`, { message: 'nothing chosen' });
      expect(empty.status).toBe(400);
      expect((await empty.json() as { error?: string }).error).toContain('Nothing is selected');
      // The unrelated file is still waiting, not swept into a commit.
      expect(git(project, ['status', '--porcelain', 'unwanted.dql'])).toContain('unwanted.dql');
    });
  });
});

describe('a project inside a bigger repository reviews only itself', () => {
  it('scopes status and stage-all to the project folder', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dql-git-nested-'));
    tempDirs.push(repo);
    initRepo(repo);
    writeFileSync(join(repo, 'README.md'), '# parent repo\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'parent']);
    const project = join(repo, 'analytics');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'dql.config.json'), '{}\n');
    // A change in the surrounding repo that this project must not touch.
    writeFileSync(join(repo, 'unrelated.py'), 'print("theirs")\n');

    await withServer(project, async (base) => {
      const status = await (await fetch(`${base}/api/git/status`)).json() as {
        projectPrefix?: string;
        changes: Array<{ path: string }>;
      };
      expect(status.projectPrefix).toBe('analytics');
      // Everything offered belongs to this project — the surrounding
      // repository's own change is filtered out. (Starting the server also
      // writes the project's .gitignore, so more than one file is listed.)
      const listed = status.changes.map((change) => change.path);
      expect(listed).toContain('analytics/dql.config.json');
      expect(listed.every((path) => path.startsWith('analytics/'))).toBe(true);
      expect(listed).not.toContain('unrelated.py');

      const committed = await postJson(`${base}/api/git/commit`, { message: 'project only', stageAll: true });
      expect(committed.status).toBe(200);
      const files = git(repo, ['show', '--name-only', '--format=', 'HEAD']);
      expect(files).toContain('analytics/dql.config.json');
      expect(files).not.toContain('unrelated.py');
    });
  });
});

describe('block history path boundary', () => {
  it('rejects shell metacharacters and paths outside the project', () => {
    const root = '/projects/acme';
    for (const bad of [
      'blocks/a.dql"; touch /tmp/pwned; echo "',
      'blocks/$(id).dql',
      'blocks/`id`.dql',
      'blocks/a.dql | cat',
      'blocks/a.dql\nrm',
      '../outside.dql',
      'blocks/../../outside.dql',
      '/etc/passwd',
      '--output=/tmp/x',
      ':(glob)**',
      '',
    ]) {
      expect(resolveBlockHistoryPath(root, bad).ok, bad).toBe(false);
    }
    expect(resolveBlockHistoryPath(root, 'blocks/revenue by region.dql')).toEqual({ ok: true, relativePath: 'blocks/revenue by region.dql' });
    expect(resolveBlockHistoryPath(root, '/projects/acme/blocks/revenue.dql')).toEqual({ ok: true, relativePath: 'blocks/revenue.dql' });
  });
});

describe('git remote input validation', () => {
  it('accepts https, ssh, and local path remotes', () => {
    for (const good of [
      'https://github.com/acme/analytics.git',
      'https://git@github.com/acme/analytics.git',
      'ssh://git@github.com/acme/analytics.git',
      'git@github.com:acme/analytics.git',
      '/srv/git/analytics.git',
      './shared/analytics.git',
      '../analytics.git',
      'file:///srv/git/analytics.git',
      'C:\\repos\\analytics.git',
    ]) {
      expect(validateGitRemoteUrl(good), good).toEqual({ ok: true, url: good });
    }
  });

  it('rejects transports that execute commands, option injection, embedded secrets, and junk', () => {
    for (const bad of [
      '',
      'ext::sh -c touch% /tmp/pwned',
      'ext::ssh',
      'fd::17',
      '--upload-pack=touch /tmp/pwned',
      '-oProxyCommand=evil',
      'http://github.com/acme/analytics.git',
      'https://user:ghp_secret@github.com/acme/analytics.git',
      'https://github.com',
      'github.com/acme/analytics',
      'git@github.com:acme/analytics.git; rm -rf /',
      'not a url',
    ]) {
      expect(validateGitRemoteUrl(bad).ok, bad).toBe(false);
    }
    expect(validateGitRemoteName(undefined)).toEqual({ ok: true, name: 'origin' });
    expect(validateGitRemoteName('upstream')).toEqual({ ok: true, name: 'upstream' });
    expect(validateGitRemoteName('--mirror').ok).toBe(false);
    expect(validateGitRemoteName('a b').ok).toBe(false);
  });

  it('maps common git network failures to a plain sentence', () => {
    expect(friendlyGitRemoteError("fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository."))
      .toMatch(/could not find a repository at the remote URL/);
    expect(friendlyGitRemoteError('fatal: could not read Username for \'https://github.com\': terminal prompts disabled'))
      .toMatch(/could not sign in/);
    expect(friendlyGitRemoteError('git@github.com: Permission denied (publickey).')).toMatch(/could not sign in/);
    expect(friendlyGitRemoteError(' ! [rejected]        main -> main (fetch first)')).toMatch(/Get updates first/);
    expect(friendlyGitRemoteError('fatal: unable to access \'https://x.invalid/\': Could not resolve host: x.invalid')).toMatch(/could not connect/);
    expect(friendlyGitRemoteError('something unexpected')).toBe('something unexpected');
  });
});

describe('source-control connection API (git history, init, remote)', () => {
  it('never runs a shell for the block history path and refuses paths outside the project', async () => {
    const projectRoot = tempProject('dql-git-history-injection-');
    const sentinel = join(projectRoot, 'pwned');
    await withServer(projectRoot, async (base) => {
      const injected = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent(`blocks/a.dql"; touch "${sentinel}"; echo "`)}`);
      expect(injected.status).toBe(400);
      await expect(injected.json()).resolves.toMatchObject({ entries: [], status: 'error' });
      expect(existsSync(sentinel)).toBe(false);

      const outside = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent('../../etc/passwd')}`);
      expect(outside.status).toBe(400);
      await expect(outside.json()).resolves.toMatchObject({ status: 'error', message: expect.stringContaining('inside the project') });

      const missing = await fetch(`${base}/api/blocks/history`);
      expect(missing.status).toBe(400);
    });
  });

  it('reports not_a_repo for block history outside Git, then real entries once committed', async () => {
    const projectRoot = tempProject('dql-git-history-status-');
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks', 'revenue.dql'), 'block "Revenue" {}\n');
    await withServer(projectRoot, async (base) => {
      const before = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent('blocks/revenue.dql')}`);
      expect(before.status).toBe(200);
      await expect(before.json()).resolves.toMatchObject({ entries: [], status: 'not_a_repo' });

      git(projectRoot, ['init']);
      const emptyRepo = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent('blocks/revenue.dql')}`);
      await expect(emptyRepo.json()).resolves.toMatchObject({ entries: [], status: 'ok' });

      git(projectRoot, ['add', 'blocks/revenue.dql']);
      git(projectRoot, ['commit', '-m', 'Add revenue block | with ||| separators']);
      const after = await fetch(`${base}/api/blocks/history?path=${encodeURIComponent('blocks/revenue.dql')}`);
      const body = await after.json() as { status: string; entries: Array<{ hash: string; date: string; author: string; message: string }> };
      expect(body.status).toBe('ok');
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]).toMatchObject({ author: 'DQL Test', message: 'Add revenue block | with ||| separators' });
      expect(body.entries[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isNaN(new Date(body.entries[0]!.date).getTime())).toBe(false);
    });
  });

  it('initializes Git only for a project that is not already inside a repository', async () => {
    const projectRoot = tempProject('dql-git-init-');
    await withServer(projectRoot, async (base) => {
      const statusBefore = await fetch(`${base}/api/git/status`).then((r) => r.json()) as { inRepo: boolean };
      expect(statusBefore.inRepo).toBe(false);

      const init = await postJson(`${base}/api/git/init`, {});
      expect(init.status).toBe(201);
      await expect(init.json()).resolves.toMatchObject({ ok: true, status: { inRepo: true } });
      expect(existsSync(join(projectRoot, '.git'))).toBe(true);

      const again = await postJson(`${base}/api/git/init`, {});
      expect(again.status).toBe(409);
      await expect(again.json()).resolves.toMatchObject({ ok: false, code: 'already_a_repo' });
    });

    const parent = tempProject('dql-git-init-nested-');
    git(parent, ['init']);
    const nested = join(parent, 'analytics');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'dql.config.json'), '{}\n');
    await withServer(nested, async (base) => {
      const refused = await postJson(`${base}/api/git/init`, {});
      expect(refused.status).toBe(409);
      expect(existsSync(join(nested, '.git'))).toBe(false);
    });
  });

  it('saves a validated remote without contacting it, and push without a remote says so plainly', async () => {
    const projectRoot = tempProject('dql-git-remote-');
    await withServer(projectRoot, async (base) => {
      const notRepo = await postJson(`${base}/api/git/remote`, { url: 'https://github.com/acme/analytics.git' });
      expect(notRepo.status).toBe(400);
      await expect(notRepo.json()).resolves.toMatchObject({ ok: false, code: 'not_a_repo' });

      await postJson(`${base}/api/git/init`, {});
      writeFileSync(join(projectRoot, 'README.md'), '# analytics\n');
      git(projectRoot, ['add', 'README.md']);
      git(projectRoot, ['commit', '-m', 'init']);

      const pushWithoutRemote = await postJson(`${base}/api/git/push`, {});
      expect(pushWithoutRemote.status).toBe(400);
      await expect(pushWithoutRemote.json()).resolves.toMatchObject({ ok: false, code: 'no_remote', error: expect.stringContaining('no Git remote') });

      for (const url of ['ext::sh -c touch% /tmp/dql-pwned', '--upload-pack=touch', 'https://me:token@github.com/acme/a.git', 'nope']) {
        const rejected = await postJson(`${base}/api/git/remote`, { url });
        expect(rejected.status, url).toBe(400);
        await expect(rejected.json()).resolves.toMatchObject({ ok: false, code: 'invalid_url' });
      }
      expect(git(projectRoot, ['remote']).trim()).toBe('');

      // A path that does not exist and a host that can never resolve: saving
      // either succeeds only because nothing is fetched or contacted.
      const localMissing = join(projectRoot, 'does-not-exist', 'shared.git');
      const added = await postJson(`${base}/api/git/remote`, { url: localMissing });
      expect(added.status).toBe(200);
      await expect(added.json()).resolves.toMatchObject({ ok: true, name: 'origin', url: localMissing, replaced: false });
      expect(git(projectRoot, ['config', '--get', 'remote.origin.url']).trim()).toBe(localMissing);
      expect(existsSync(join(projectRoot, '.git', 'refs', 'remotes', 'origin'))).toBe(false);

      const duplicate = await postJson(`${base}/api/git/remote`, { url: 'https://git.example.invalid/acme/analytics.git' });
      expect(duplicate.status).toBe(409);
      await expect(duplicate.json()).resolves.toMatchObject({ ok: false, code: 'remote_exists' });

      const replaced = await postJson(`${base}/api/git/remote`, { url: 'https://git.example.invalid/acme/analytics.git', replace: true });
      expect(replaced.status).toBe(200);
      await expect(replaced.json()).resolves.toMatchObject({ ok: true, replaced: true, url: 'https://git.example.invalid/acme/analytics.git' });

      const remote = await fetch(`${base}/api/git/remote`).then((r) => r.json());
      expect(remote).toEqual({ inRepo: true, name: 'origin', url: 'https://git.example.invalid/acme/analytics.git' });
    });
  });
});

/** A bare repository standing in for the Git host, created with `defaultBranch` and the given files. */
function hostRepo(prefix: string, defaultBranch: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  const bare = join(root, 'host.git');
  git(root, ['init', '--bare', '-b', defaultBranch, bare]);
  if (Object.keys(files).length > 0) {
    const seed = join(root, 'seed');
    git(root, ['clone', bare, seed]);
    git(seed, ['checkout', '-B', defaultBranch]);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(seed, name, '..'), { recursive: true });
      writeFileSync(join(seed, name), content);
    }
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-m', 'Initial commit']);
    git(seed, ['push', 'origin', defaultBranch]);
  }
  return bare;
}

function projectOnMain(prefix: string): string {
  const dir = tempProject(prefix);
  writeFileSync(join(dir, 'README.md'), '# project\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  initRepo(dir);
  git(dir, ['checkout', '-B', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'first']);
  return dir;
}

describe('connecting a project to a repository the host already created', () => {
  it('sends on top of the host\'s README, LICENSE and .gitignore instead of looping between send and get updates', async () => {
    const bare = hostRepo('dql-git-host-readme-', 'main', { 'README.md': '# from host\n', LICENSE: 'MIT\n', '.gitignore': '.DS_Store\nnode_modules/\n' });
    const project = projectOnMain('dql-git-readme-');
    await withServer(project, async (base) => {
      expect((await postJson(`${base}/api/git/remote`, { url: bare })).status).toBe(200);
      const sent = await (await postJson(`${base}/api/git/push`, {})).json() as { ok: boolean; error?: string };
      expect(sent).toMatchObject({ ok: true });
    });
    const hostFiles = git(project, ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean);
    expect(hostFiles).toEqual(expect.arrayContaining(['LICENSE', 'README.md', 'dql.config.json', '.gitignore']));
    expect(git(project, ['--git-dir', bare, 'show', 'main:README.md'])).toBe('# project\n');
    expect(git(project, ['--git-dir', bare, 'show', 'main:.gitignore'])).toContain('.DS_Store');
    expect(git(project, ['rev-parse', '--abbrev-ref', '@{u}']).trim()).toBe('origin/main');
  });

  it('links the branch on get updates first, then sends', async () => {
    const bare = hostRepo('dql-git-host-pullfirst-', 'main', { 'README.md': '# from host\n' });
    const project = projectOnMain('dql-git-pullfirst-');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/git/remote`, { url: bare });
      const updated = await (await postJson(`${base}/api/git/pull`, {})).json() as { ok: boolean; output?: string };
      expect(updated.ok).toBe(true);
      expect(updated.output).toContain('Linked main to origin/main');
      expect(await (await postJson(`${base}/api/git/push`, {})).json()).toMatchObject({ ok: true });
    });
  });

  it('never merges a host branch that holds real work: it links and asks for get updates', async () => {
    const bare = hostRepo('dql-git-host-work-', 'main', { 'README.md': '# shop\n', 'models/orders.sql': 'select 1\n' });
    const project = projectOnMain('dql-git-work-');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/git/remote`, { url: bare });
      const sent = await (await postJson(`${base}/api/git/push`, {})).json() as { ok: boolean; code?: string; error?: string };
      expect(sent).toMatchObject({ ok: false, code: 'unrelated' });
    });
    expect(git(project, ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean)).toEqual(['README.md', 'models/orders.sql']);
    expect(git(project, ['log', '--format=%s']).trim()).toBe('first');
    expect(git(project, ['rev-parse', '--abbrev-ref', '@{u}']).trim()).toBe('origin/main');
  });

  it('still makes a normal first send to an empty repository', async () => {
    const bare = hostRepo('dql-git-host-empty-', 'main', {});
    const project = projectOnMain('dql-git-empty-');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/git/remote`, { url: bare });
      expect(await (await postJson(`${base}/api/git/push`, {})).json()).toMatchObject({ ok: true });
    });
    expect(git(project, ['--git-dir', bare, 'branch', '--format=%(refname:short)']).trim()).toBe('main');
  });
});

describe('reviews merge into the repository\'s default branch', () => {
  it('uses the default of a cloned repository (master) from a feature branch', async () => {
    const bare = hostRepo('dql-git-host-master-', 'master', { 'README.md': '# m\n' });
    const root = mkdtempSync(join(tmpdir(), 'dql-git-master-clone-'));
    tempDirs.push(root);
    const clone = join(root, 'clone');
    git(root, ['clone', bare, clone]);
    initRepoIdentity(clone);
    writeFileSync(join(clone, 'dql.config.json'), '{}\n');
    git(clone, ['checkout', '-b', 'feature/x']);
    await withServer(clone, async (base) => {
      const status = await (await fetch(`${base}/api/git/status`)).json() as { baseBranch?: string };
      expect(status.baseBranch).toBe('master');
      const review = await (await postJson(`${base}/api/git/review`, { paths: ['dql.config.json'], title: 'Feature work' })).json() as { ok: boolean; base?: string };
      expect(review).toMatchObject({ ok: true, base: 'master' });
    });
  });

  it('asks the remote when it was added after the project was created (develop), and remembers it after a send', async () => {
    const bare = hostRepo('dql-git-host-develop-', 'develop', { 'README.md': '# d\n' });
    const project = projectOnMain('dql-git-develop-');
    git(project, ['checkout', '-b', 'feature/y']);
    await withServer(project, async (base) => {
      await postJson(`${base}/api/git/remote`, { url: bare });
      writeFileSync(join(project, 'block.dql'), 'block "x" {}\n');
      const review = await (await postJson(`${base}/api/git/review`, { paths: ['block.dql'], title: 'Develop work' })).json() as { ok: boolean; base?: string };
      expect(review).toMatchObject({ ok: true, base: 'develop' });
      const status = await (await fetch(`${base}/api/git/status`)).json() as { baseBranch?: string };
      expect(status.baseBranch).toBe('develop');
    });
  });
});

function initRepoIdentity(dir: string): void {
  git(dir, ['config', 'user.name', 'DQL Test']);
  git(dir, ['config', 'user.email', 'dql-test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

/** A teammate's clone of `bare` that commits `file` to `branch` and pushes it. */
function teammatePushes(bare: string, branch: string, file: string): void {
  const root = mkdtempSync(join(tmpdir(), 'dql-git-mate-'));
  tempDirs.push(root);
  const clone = join(root, 'mate');
  git(root, ['clone', bare, clone]);
  git(clone, ['checkout', branch]);
  writeFileSync(join(clone, file), `${file}\n`);
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-m', `teammate: ${file}`]);
  git(clone, ['push', 'origin', branch]);
}

function clonedProject(bare: string, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  const clone = join(root, 'clone');
  git(root, ['clone', bare, clone]);
  initRepoIdentity(clone);
  return clone;
}

async function status(base: string): Promise<{ ahead: number; behind: number; baseBranch?: string; baseOnRemote?: boolean; upstream?: string | null; sampleRemote?: boolean; branch: string | null }> {
  return await (await fetch(`${base}/api/git/status`)).json() as never;
}

describe('the Git page knows what is on the remote before you send (D3)', () => {
  it('a background fetch reports new remote changes without touching your branch', async () => {
    const bare = hostRepo('dql-git-host-fetch-', 'main', { 'dql.config.json': '{}\n' });
    const project = clonedProject(bare, 'dql-git-fetch-');
    const before = git(project, ['rev-parse', 'HEAD']).trim();
    teammatePushes(bare, 'main', 'orders.dql');
    await withServer(project, async (base) => {
      expect((await status(base)).behind).toBe(0);
      expect(await (await postJson(`${base}/api/git/fetch`, {})).json()).toEqual({ ok: true });
      expect(await status(base)).toMatchObject({ behind: 1, ahead: 0, upstream: 'origin/main', baseOnRemote: true });
    });
    expect(git(project, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(existsSync(join(project, 'orders.dql'))).toBe(false);
  });

  it('says plainly when the remote cannot be reached', async () => {
    const project = projectOnMain('dql-git-fetch-unreachable-');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/git/remote`, { url: join(project, 'no-such-remote.git') });
      const res = await (await postJson(`${base}/api/git/fetch`, {})).json() as { ok: boolean; code?: string; error?: string };
      expect(res).toMatchObject({ ok: false, code: 'unreachable' });
      expect(res.error).toBeTruthy();
      expect(await (await postJson(`${base}/api/git/fetch`, {})).json()).toMatchObject({ ok: false, code: 'unreachable' });
    });
  });

  it('counts commits on a branch the remote has never seen as not sent yet', async () => {
    const bare = hostRepo('dql-git-host-unsent-', 'main', { 'dql.config.json': '{}\n' });
    const project = clonedProject(bare, 'dql-git-unsent-');
    git(project, ['checkout', '-b', 'feature/new']);
    writeFileSync(join(project, 'a.dql'), 'a\n');
    git(project, ['add', '-A']);
    git(project, ['commit', '-m', 'a']);
    await withServer(project, async (base) => {
      expect(await status(base)).toMatchObject({ ahead: 1, behind: 0, upstream: null });
    });
  });
});

describe('send from the base branch goes to a new branch (D4)', () => {
  it('moves your unsent commits to a new branch, sends it, and leaves main as the remote has it', async () => {
    const bare = hostRepo('dql-git-host-sab-', 'main', { 'dql.config.json': '{}\n' });
    const project = clonedProject(bare, 'dql-git-sab-');
    const remoteMain = git(project, ['rev-parse', 'origin/main']).trim();
    writeFileSync(join(project, 'revenue.dql'), 'block "Revenue" {}\n');
    git(project, ['add', '-A']);
    git(project, ['commit', '-m', 'Add revenue block']);
    writeFileSync(join(project, 'draft.dql'), 'unsaved\n');
    await withServer(project, async (base) => {
      const res = await (await postJson(`${base}/api/git/send-as-branch`, {})).json() as { ok: boolean; branch?: string; base?: string; sent?: number; subject?: string };
      expect(res).toMatchObject({ ok: true, branch: 'zlens/add-revenue-block', base: 'main', sent: 1, subject: 'Add revenue block' });
    });
    expect(git(project, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('zlens/add-revenue-block');
    expect(git(project, ['rev-parse', 'main']).trim()).toBe(remoteMain);
    expect(git(project, ['--git-dir', bare, 'rev-parse', 'main']).trim()).toBe(remoteMain);
    expect(git(project, ['--git-dir', bare, 'log', '-1', '--format=%s', 'zlens/add-revenue-block']).trim()).toBe('Add revenue block');
    expect(readFileSync(join(project, 'draft.dql'), 'utf-8')).toBe('unsaved\n');
  });

  it('picks a free name when the branch exists, and refuses when there is nothing to send', async () => {
    const bare = hostRepo('dql-git-host-sab2-', 'main', { 'dql.config.json': '{}\n' });
    const project = clonedProject(bare, 'dql-git-sab2-');
    git(project, ['branch', 'zlens/tweak']);
    await withServer(project, async (base) => {
      expect(await (await postJson(`${base}/api/git/send-as-branch`, {})).json()).toMatchObject({ ok: false, code: 'nothing_to_send' });
      writeFileSync(join(project, 't.dql'), 't\n');
      git(project, ['add', '-A']);
      git(project, ['commit', '-m', 'Tweak']);
      expect(await (await postJson(`${base}/api/git/send-as-branch`, {})).json()).toMatchObject({ ok: true, branch: 'zlens/tweak-2' });
    });
  });
});

describe('the ZLens sample is never a place to send (D5)', () => {
  it('recognises the sample repositories in every address form', () => {
    for (const url of [
      'https://github.com/duckcode-ai/jaffle-shop-duckdb.git',
      'https://github.com/duckcode-ai/jaffle-shop-duckdb',
      'git@github.com:duckcode-ai/jaffle-shop-warehouse.git',
      'ssh://git@github.com/zlens-app/jaffle-shop-duckdb.git',
    ]) expect(isZLensSampleRemote(url), url).toBe(true);
    for (const url of [
      'https://github.com/acme/jaffle-shop-duckdb.git',
      'https://github.com/duckcode-ai/jaffle-shop-duckdb-fork.git',
      '/srv/git/jaffle-shop-duckdb.git',
    ]) expect(isZLensSampleRemote(url), url).toBe(false);
  });

  it('refuses to send to the sample, then connects your repository and sends there', async () => {
    const own = hostRepo('dql-git-host-own-', 'main', {});
    const project = projectOnMain('dql-git-sample-');
    git(project, ['remote', 'add', 'origin', 'https://github.com/duckcode-ai/jaffle-shop-duckdb.git']);
    git(project, ['config', 'branch.main.remote', 'origin']);
    git(project, ['config', 'branch.main.merge', 'refs/heads/main']);
    await withServer(project, async (base) => {
      expect((await status(base)).sampleRemote).toBe(true);
      expect(await (await postJson(`${base}/api/git/push`, {})).json()).toMatchObject({ ok: false, code: 'sample_remote' });
      expect(await (await postJson(`${base}/api/git/send-as-branch`, {})).json()).toMatchObject({ ok: false, code: 'sample_remote' });
      expect(await (await postJson(`${base}/api/git/remote/connect-own`, { url: 'git@github.com:duckcode-ai/jaffle-shop-duckdb.git' })).json())
        .toMatchObject({ ok: false, code: 'sample_remote' });
      expect(await (await postJson(`${base}/api/git/remote/connect-own`, { url: own })).json()).toMatchObject({ ok: true, previous: 'upstream' });
      expect((await status(base)).sampleRemote).toBe(false);
      expect(await (await postJson(`${base}/api/git/push`, {})).json()).toMatchObject({ ok: true });
    });
    expect(git(project, ['remote', 'get-url', 'upstream']).trim()).toBe('https://github.com/duckcode-ai/jaffle-shop-duckdb.git');
    expect(git(project, ['rev-parse', '--abbrev-ref', '@{u}']).trim()).toBe('origin/main');
    expect(git(project, ['--git-dir', own, 'log', '-1', '--format=%s', 'main']).trim()).toBe('first');
  });
});

/** A teammate's clone of `bare` that writes `files` on `branch` and pushes them. */
function teammateCommits(bare: string, branch: string, files: Record<string, string>, message = 'teammate change'): void {
  const root = mkdtempSync(join(tmpdir(), 'dql-git-mate2-'));
  tempDirs.push(root);
  const clone = join(root, 'mate');
  git(root, ['clone', bare, clone]);
  git(clone, ['checkout', branch]);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(clone, name), content);
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-m', message]);
  git(clone, ['push', 'origin', branch]);
}

function commitFiles(dir: string, files: Record<string, string>, message: string): void {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', message]);
}

type UpdateResult = { ok: boolean; code?: string; output?: string; undoAvailable?: boolean; files?: string[]; state?: { inProgress: boolean; operation?: string; unresolved: string[]; conflicts: Array<{ path: string; mine: boolean; theirs: boolean }> } };
const update = async (base: string): Promise<UpdateResult> => await (await postJson(`${base}/api/git/pull`, {})).json() as UpdateResult;
const updateStep = async (base: string, step: string, body: unknown = {}): Promise<UpdateResult> => await (await postJson(`${base}/api/git/update/${step}`, body)).json() as UpdateResult;

describe('get updates when you and the remote both changed (D1)', () => {
  it('replays your unsent commit on top of the remote, and Undo puts it back', async () => {
    const bare = hostRepo('dql-git-d1-host-', 'main', { 'dql.config.json': '{}\n', 'a.dql': 'a\n' });
    const project = clonedProject(bare, 'dql-git-d1-');
    commitFiles(project, { 'mine.dql': 'mine\n' }, 'My change');
    const before = git(project, ['rev-parse', 'HEAD']).trim();
    teammateCommits(bare, 'main', { 'theirs.dql': 'theirs\n' }, 'Their change');
    writeFileSync(join(project, 'draft.dql'), 'unsaved\n');
    await withServer(project, async (base) => {
      const res = await update(base);
      expect(res).toMatchObject({ ok: true, undoAvailable: true });
      expect(res.output).toContain('your 1 unsent change is now on top');
      expect(git(project, ['log', '--format=%s', '-3']).trim().split('\n')).toEqual(['My change', 'Their change', 'Initial commit']);
      expect(readFileSync(join(project, 'draft.dql'), 'utf-8')).toBe('unsaved\n');
      expect((await (await fetch(`${base}/api/git/update/state`)).json() as { undoAvailable: boolean }).undoAvailable).toBe(true);
      expect(await updateStep(base, 'undo')).toMatchObject({ ok: true });
      expect(git(project, ['rev-parse', 'HEAD']).trim()).toBe(before);
      expect(readFileSync(join(project, 'draft.dql'), 'utf-8')).toBe('unsaved\n');
      expect(await updateStep(base, 'undo')).toMatchObject({ ok: false, code: 'nothing_to_undo' });
    });
  });

  it('stops on a conflict, compares both versions, keeps mine, and continues', async () => {
    const bare = hostRepo('dql-git-d1c-host-', 'main', { 'dql.config.json': '{}\n', 'revenue.dql': 'v1\n' });
    const project = clonedProject(bare, 'dql-git-d1c-');
    commitFiles(project, { 'revenue.dql': 'mine\n' }, 'My revenue');
    teammateCommits(bare, 'main', { 'revenue.dql': 'theirs\n' }, 'Their revenue');
    await withServer(project, async (base) => {
      const res = await update(base);
      expect(res).toMatchObject({ ok: false, code: 'conflicts' });
      expect(res.state).toMatchObject({ inProgress: true, operation: 'rebase', unresolved: ['revenue.dql'] });
      const versions = await (await fetch(`${base}/api/git/update/versions?path=revenue.dql`)).json() as { mine: string; theirs: string };
      expect(versions).toMatchObject({ mine: 'mine\n', theirs: 'theirs\n' });
      expect(await updateStep(base, 'continue')).toMatchObject({ ok: false, code: 'conflicts' });
      expect((await updateStep(base, 'resolve', { path: 'revenue.dql', keep: 'mine' })).state?.unresolved).toEqual([]);
      expect(await updateStep(base, 'continue')).toMatchObject({ ok: true, undoAvailable: true });
    });
    expect(readFileSync(join(project, 'revenue.dql'), 'utf-8')).toBe('mine\n');
    expect(git(project, ['log', '--format=%s', '-2']).trim().split('\n')).toEqual(['My revenue', 'Their revenue']);
  });

  it('keeps theirs when asked', async () => {
    const bare = hostRepo('dql-git-d1t-host-', 'main', { 'dql.config.json': '{}\n', 'revenue.dql': 'v1\n' });
    const project = clonedProject(bare, 'dql-git-d1t-');
    commitFiles(project, { 'revenue.dql': 'mine\n', 'other.dql': 'other\n' }, 'My revenue');
    teammateCommits(bare, 'main', { 'revenue.dql': 'theirs\n' }, 'Their revenue');
    await withServer(project, async (base) => {
      await update(base);
      await updateStep(base, 'resolve', { path: 'revenue.dql', keep: 'theirs' });
      expect(await updateStep(base, 'continue')).toMatchObject({ ok: true });
    });
    expect(readFileSync(join(project, 'revenue.dql'), 'utf-8')).toBe('theirs\n');
    expect(readFileSync(join(project, 'other.dql'), 'utf-8')).toBe('other\n');
  });

  it('cancel puts everything back exactly as it was', async () => {
    const bare = hostRepo('dql-git-d1x-host-', 'main', { 'dql.config.json': '{}\n', 'revenue.dql': 'v1\n' });
    const project = clonedProject(bare, 'dql-git-d1x-');
    commitFiles(project, { 'revenue.dql': 'mine\n' }, 'My revenue');
    const before = git(project, ['rev-parse', 'HEAD']).trim();
    teammateCommits(bare, 'main', { 'revenue.dql': 'theirs\n' }, 'Their revenue');
    writeFileSync(join(project, 'draft.dql'), 'unsaved\n');
    await withServer(project, async (base) => {
      expect((await update(base)).code).toBe('conflicts');
      expect(await updateStep(base, 'cancel')).toMatchObject({ ok: true });
      expect((await (await fetch(`${base}/api/git/update/state`)).json() as { inProgress: boolean }).inProgress).toBe(false);
    });
    expect(git(project, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(readFileSync(join(project, 'revenue.dql'), 'utf-8')).toBe('mine\n');
    expect(readFileSync(join(project, 'draft.dql'), 'utf-8')).toBe('unsaved\n');
  });

  it('asks you to keep or discard unsaved edits to files the remote also changed', async () => {
    const bare = hostRepo('dql-git-d1u-host-', 'main', { 'dql.config.json': '{}\n', 'revenue.dql': 'v1\n' });
    const project = clonedProject(bare, 'dql-git-d1u-');
    teammateCommits(bare, 'main', { 'revenue.dql': 'theirs\n' }, 'Their revenue');
    writeFileSync(join(project, 'revenue.dql'), 'unsaved mine\n');
    const before = git(project, ['rev-parse', 'HEAD']).trim();
    await withServer(project, async (base) => {
      const res = await update(base);
      expect(res).toMatchObject({ ok: false, code: 'unsaved_overlap', files: ['revenue.dql'] });
    });
    expect(git(project, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(readFileSync(join(project, 'revenue.dql'), 'utf-8')).toBe('unsaved mine\n');
  });
});

describe('unsaved edits to other files ride along (D1)', () => {
  it('carries a tracked file with unsaved edits across the update and leaves no stash behind', async () => {
    const bare = hostRepo('dql-git-d1s-host-', 'main', { 'dql.config.json': '{}\n', 'notes.dql': 'v1\n' });
    const project = clonedProject(bare, 'dql-git-d1s-');
    commitFiles(project, { 'mine.dql': 'mine\n' }, 'My change');
    teammateCommits(bare, 'main', { 'theirs.dql': 'theirs\n' }, 'Their change');
    writeFileSync(join(project, 'notes.dql'), 'unsaved edit\n');
    await withServer(project, async (base) => {
      expect((await update(base)).ok).toBe(true);
    });
    expect(readFileSync(join(project, 'notes.dql'), 'utf-8')).toBe('unsaved edit\n');
    expect(git(project, ['stash', 'list']).trim()).toBe('');
    expect(existsSync(join(project, 'theirs.dql'))).toBe(true);
  });
});

describe('review branches bring in the main branch (D2)', () => {
  it('merges main into a branch that was already sent, never rewriting it', async () => {
    const bare = hostRepo('dql-git-d2s-host-', 'main', { 'dql.config.json': '{}\n' });
    const project = clonedProject(bare, 'dql-git-d2s-');
    git(project, ['checkout', '-b', 'zlens/revenue']);
    commitFiles(project, { 'revenue.dql': 'r\n' }, 'Revenue block');
    git(project, ['push', '-u', 'origin', 'zlens/revenue']);
    const sent = git(project, ['rev-parse', 'HEAD']).trim();
    teammateCommits(bare, 'main', { 'orders.dql': 'o\n' }, 'Orders on main');
    await withServer(project, async (base) => {
      const res = await update(base);
      expect(res.ok).toBe(true);
      expect(res.output).toContain('from origin/main');
    });
    expect(git(project, ['merge-base', '--is-ancestor', sent, 'HEAD']).trim()).toBe('');
    expect(git(project, ['rev-list', '--parents', '-1', 'HEAD']).trim().split(' ')).toHaveLength(3);
    expect(existsSync(join(project, 'orders.dql'))).toBe(true);
  });

  it('rebases a branch that was never sent onto main', async () => {
    const bare = hostRepo('dql-git-d2u-host-', 'main', { 'dql.config.json': '{}\n' });
    const project = clonedProject(bare, 'dql-git-d2u-');
    git(project, ['checkout', '-b', 'zlens/local-only']);
    commitFiles(project, { 'local.dql': 'l\n' }, 'Local block');
    teammateCommits(bare, 'main', { 'orders.dql': 'o\n' }, 'Orders on main');
    await withServer(project, async (base) => {
      expect((await update(base)).ok).toBe(true);
    });
    expect(git(project, ['log', '--format=%s', '-3']).trim().split('\n')).toEqual(['Local block', 'Orders on main', 'Initial commit']);
  });
});

describe('a remote holding unrelated work is never combined (D6)', () => {
  it('refuses to send or update, and says how to add ZLens to that repository', async () => {
    const bare = hostRepo('dql-git-d6-host-', 'main', { 'README.md': '# shop\n', 'models/orders.sql': 'select 1\n' });
    const project = projectOnMain('dql-git-d6-');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/git/remote`, { url: bare });
      const sent = await (await postJson(`${base}/api/git/push`, {})).json() as { ok: boolean; code?: string; error?: string };
      expect(sent).toMatchObject({ ok: false, code: 'unrelated' });
      expect(sent.error).toContain('create-zlens-app');
      expect(await update(base)).toMatchObject({ ok: false, code: 'unrelated' });
    });
    expect(git(project, ['log', '--format=%s']).trim()).toBe('first');
  });
});
