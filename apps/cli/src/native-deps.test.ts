import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { betterSqlite3Help, commandNeedsSqlite, explainNativeDependencyError, npxRerunCommand, probeBetterSqlite3, sqlitePreflightMessage } from './native-deps.js';
import { checkSqliteNativeBinding } from './commands/doctor.js';

const BINDINGS_ERROR = new Error([
  'Could not locate the bindings file. Tried:',
  ' → /work/app/node_modules/better-sqlite3/build/better_sqlite3.node',
  ' → /work/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
].join('\n'));

const temp: string[] = [];
beforeEach(() => {
  vi.stubEnv('npm_config_user_agent', 'npm/12.2.0 node/v24.22.0 darwin arm64 workspaces/false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (temp.length) rmSync(temp.pop()!, { recursive: true, force: true });
});

/** A project whose better-sqlite3 installed without its binary, as npm 12 leaves it. */
function projectWithBlockedSqlite(): { dir: string; req: NodeRequire } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zlens-npm12-')));
  temp.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true }));
  const pkgDir = join(dir, 'node_modules', 'better-sqlite3');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.11.1', main: 'index.js' }));
  // Like the real package: loading the JS works; opening a database needs the binary.
  writeFileSync(join(pkgDir, 'index.js'), `module.exports = function Database() { throw new Error(${JSON.stringify(BINDINGS_ERROR.message)}); };`);
  return { dir, req: createRequire(join(dir, 'package.json')) };
}

describe('better-sqlite3 preflight (npm 12 blocked install script)', () => {
  it('probes the real module as loadable in this checkout', () => {
    expect(probeBetterSqlite3().ok).toBe(true);
  });

  it('turns a missing binary into the two npm commands and the allowScripts field, naming the project folder', () => {
    const { dir, req } = projectWithBlockedSqlite();
    const message = sqlitePreflightMessage('sync', () => probeBetterSqlite3(req));
    expect(message).not.toBeNull();
    expect(message).toContain('ZLens could not load better-sqlite3');
    expect(message).toContain('npm 12 and newer block');
    expect(message).toContain(`Fix it in ${dir}:`);
    expect(message).toContain('  npm install-scripts approve better-sqlite3\n  npm rebuild better-sqlite3');
    expect(message).toContain('"allowScripts": { "better-sqlite3": true }');
    expect(message).toContain('Underlying error: Could not locate the bindings file.');
  });

  it('runs commands that need SQLite only when it loads, and never blocks doctor or init', () => {
    const { req } = projectWithBlockedSqlite();
    const probe = vi.fn(() => probeBetterSqlite3(req));
    for (const command of ['doctor', 'init', 'new', 'parse', 'fmt']) {
      expect(commandNeedsSqlite(command)).toBe(false);
      expect(sqlitePreflightMessage(command, probe)).toBeNull();
    }
    expect(probe).not.toHaveBeenCalled();
    for (const command of ['notebook', 'sync', 'compile', 'validate', 'mcp']) expect(commandNeedsSqlite(command)).toBe(true);
    expect(sqlitePreflightMessage('notebook', () => ({ ok: true }))).toBeNull();
  });

  it('from the npx cache, says the exact command to run again with the script allowed', () => {
    const message = betterSqlite3Help(BINDINGS_ERROR, '/Users/a/.npm/_npx/713c2588/node_modules/better-sqlite3');
    // npx reuses the copy it installed: the message clears it before running again (npm 12 here, see beforeEach).
    expect(message).toContain('npx installed ZLens without running the script, and keeps that copy. Clear it, then run it again with the script allowed:');
    expect(message).toMatch(/\n {2}npm cache npx rm 713c2588\n {2}npx --allow-scripts=better-sqlite3 zlens/);
    // npm 10 has no `npm cache npx`: delete the cached copy's folder.
    vi.stubEnv('npm_config_user_agent', 'npm/10.9.3 node/v22.18.0 darwin arm64 workspaces/false');
    expect(betterSqlite3Help(BINDINGS_ERROR, '/Users/a/.npm/_npx/713c2588/node_modules/better-sqlite3')).toContain('  rm -rf /Users/a/.npm/_npx/713c2588\n');
    expect(npxRerunCommand(['node', '/x/_npx/1/node_modules/.bin/zlens', 'notebook', 'my data', '--yes'], {})).toBe("npx --allow-scripts=better-sqlite3 zlens notebook 'my data' --yes");
    // npm create zlens: its folder first, then its options after --.
    expect(npxRerunCommand([], { ZLENS_CREATE_ARGS: JSON.stringify(['./shop', '--port', '4000']) })).toBe('npm create zlens@latest --allow-scripts=better-sqlite3 ./shop -- --port 4000');
    expect(npxRerunCommand([], { ZLENS_CREATE_ARGS: JSON.stringify(['.']) })).toBe('npm create zlens@latest --allow-scripts=better-sqlite3 .');
  });

  it('does not claim npm 12 for an unrelated load failure', () => {
    expect(sqlitePreflightMessage('sync', () => ({ ok: false, error: new Error('EACCES: permission denied') }))).toBeNull();
  });

  it('explains a wrapped binding error from the last-resort handler', () => {
    const wrapped = new Error(`Failed to compile project: ${BINDINGS_ERROR.message}`);
    expect(explainNativeDependencyError(wrapped)).toContain('npm install-scripts approve better-sqlite3');
    expect(explainNativeDependencyError(new Error('Unknown connection "x"'))).toBeNull();
    const connector = Object.assign(new Error('ZLens could not load duckdb, …'), { name: 'ConnectorNativeBindingError' });
    expect(explainNativeDependencyError(connector)).toBe(connector.message);
  });
});

describe('zlens doctor: SQLite native module check', () => {
  it('passes when better-sqlite3 loads', () => {
    expect(checkSqliteNativeBinding(() => ({ ok: true }))).toMatchObject({ ok: true, detail: 'loads' });
  });

  it('fails with the repair commands when npm 12 blocked the binary', () => {
    const { req } = projectWithBlockedSqlite();
    const check = checkSqliteNativeBinding(() => probeBetterSqlite3(req));
    expect(check.ok).toBe(false);
    expect(check.name).toBe('SQLite native module (better-sqlite3)');
    expect(check.detail).toContain('npm install-scripts approve better-sqlite3');
    expect(check.detail).toContain('npm rebuild better-sqlite3');
  });
});
