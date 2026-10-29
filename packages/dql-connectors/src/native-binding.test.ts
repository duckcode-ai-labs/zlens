import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isNativeBindingError,
  isNodeAbiMismatch,
  nativeBindingHelp,
  nativeInstallContextFor,
  packageManagerFromUserAgent,
} from './native-binding.js';
import { ConnectorNativeBindingError, MissingConnectorDependencyError, importConnectorDependency } from './optional-dependency.js';

const BINDINGS_ERROR = new Error([
  'Could not locate the bindings file. Tried:',
  ' → /work/app/node_modules/better-sqlite3/build/better_sqlite3.node',
  ' → /work/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
].join('\n'));
const DUCKDB_ERROR = new Error("Cannot find module '/work/app/.dql/connectors/node_modules/duckdb/lib/binding/duckdb.node'");
const ABI_ERROR = new Error("The module '/x/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 137.");

const temp: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zlens-native-')));
  temp.push(dir);
  return dir;
}
beforeEach(() => {
  // The package manager running the tests must not pick the message.
  vi.stubEnv('npm_config_user_agent', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (temp.length) rmSync(temp.pop()!, { recursive: true, force: true });
});

describe('isNativeBindingError', () => {
  it('recognises a missing better-sqlite3 or duckdb binary and an ABI mismatch', () => {
    expect(isNativeBindingError(BINDINGS_ERROR)).toBe(true);
    expect(isNativeBindingError(new Error(`Failed to compile project: ${BINDINGS_ERROR.message}`))).toBe(true);
    expect(isNativeBindingError(DUCKDB_ERROR)).toBe(true);
    expect(isNativeBindingError(ABI_ERROR)).toBe(true);
    expect(isNodeAbiMismatch(ABI_ERROR)).toBe(true);
    expect(isNodeAbiMismatch(BINDINGS_ERROR)).toBe(false);
  });

  it('leaves other errors alone', () => {
    expect(isNativeBindingError(new Error("Cannot find module 'duckdb'"))).toBe(false);
    expect(isNativeBindingError(new Error('SQLITE_BUSY: database is locked'))).toBe(false);
    expect(isNativeBindingError(undefined)).toBe(false);
  });
});

describe('nativeInstallContextFor', () => {
  it('tells a project install, the connector folder, a global install and the npx cache apart', () => {
    const project = tempDir();
    writeFileSync(join(project, 'package.json'), '{}');
    expect(nativeInstallContextFor(join(project, 'node_modules', 'better-sqlite3'))).toEqual({ kind: 'project', dir: project });
    expect(nativeInstallContextFor(join(project, 'node_modules', '@zlens', 'cli', 'node_modules', 'better-sqlite3'))).toEqual({ kind: 'project', dir: project });

    const connectors = join(project, '.dql', 'connectors');
    expect(nativeInstallContextFor(join(connectors, 'node_modules', 'duckdb'))).toEqual({ kind: 'connectors', dir: connectors });

    const globalLib = join(tempDir(), 'lib');
    mkdirSync(globalLib, { recursive: true });
    expect(nativeInstallContextFor(join(globalLib, 'node_modules', '@zlens', 'cli', 'node_modules', 'better-sqlite3'))).toEqual({ kind: 'global' });

    expect(nativeInstallContextFor('/Users/a/.npm/_npx/713c2588/node_modules/better-sqlite3')).toEqual({ kind: 'npx' });
  });
});

describe('packageManagerFromUserAgent', () => {
  it('reads npm and pnpm majors', () => {
    expect(packageManagerFromUserAgent('npm/12.2.0 node/v24.22.0 darwin arm64 workspaces/false')).toEqual({ name: 'npm', major: 12 });
    expect(packageManagerFromUserAgent('pnpm/10.4.1 npm/? node/v22.18.0 darwin arm64')).toEqual({ name: 'pnpm', major: 10 });
    expect(packageManagerFromUserAgent('')).toEqual({ name: 'unknown' });
  });
});

describe('nativeBindingHelp', () => {
  const role = 'the SQLite library ZLens keeps its local index and run history in';

  it('explains the npm 12 block and gives the two commands plus the allowScripts field for a project', () => {
    const text = nativeBindingHelp({ packageName: 'better-sqlite3', role, error: BINDINGS_ERROR, context: { kind: 'project', dir: '/work/app' }, userAgent: 'npm/12.2.0 node/v24.22.0' });
    expect(text).toContain('ZLens could not load better-sqlite3');
    expect(text).toContain('npm 12 and newer block');
    expect(text).toContain('Fix it in /work/app:');
    expect(text).toContain('  npm install-scripts approve better-sqlite3\n  npm rebuild better-sqlite3');
    expect(text).toContain('"allowScripts": { "better-sqlite3": true }');
    expect(text).toMatch(/Underlying error: Could not locate the bindings file\.$/);
    expect(text).not.toContain(' → ');
  });

  it('uses --prefix for the connector folder', () => {
    const text = nativeBindingHelp({ packageName: 'duckdb', role: 'the DuckDB driver', error: DUCKDB_ERROR, context: { kind: 'connectors', dir: '/work/my app/.dql/connectors' } });
    expect(text).toContain('npm --prefix "/work/my app/.dql/connectors" install-scripts approve duckdb');
    expect(text).toContain('npm --prefix "/work/my app/.dql/connectors" rebuild duckdb');
    expect(text).toContain('/work/my app/.dql/connectors/package.json');
  });

  it('gives the --allow-scripts flag for a global install', () => {
    const text = nativeBindingHelp({ packageName: 'better-sqlite3', role, error: BINDINGS_ERROR, context: { kind: 'global' } });
    expect(text).toContain('npm install -g @zlens/cli --allow-scripts=better-sqlite3');
    expect(text).not.toContain('install-scripts approve');
  });

  it('asks only for a rebuild when the binary was built for another Node, or on npm 10', () => {
    const abi = nativeBindingHelp({ packageName: 'better-sqlite3', role, error: ABI_ERROR, context: { kind: 'project', dir: '/work/app' } });
    expect(abi).toContain('built for a different Node.js version');
    expect(abi).toContain('  npm rebuild better-sqlite3');
    const npm10 = nativeBindingHelp({ packageName: 'better-sqlite3', role, error: BINDINGS_ERROR, context: { kind: 'project', dir: '/work/app' }, userAgent: 'npm/10.9.3 node/v22.18.0' });
    expect(npm10).toContain('  npm rebuild better-sqlite3');
    expect(npm10).not.toContain('install-scripts approve');
    expect(npm10).not.toContain('npm 12 and newer block');
  });

  it('gives pnpm its own commands', () => {
    const text = nativeBindingHelp({ packageName: 'better-sqlite3', role, error: BINDINGS_ERROR, context: { kind: 'project', dir: '/work/app' }, userAgent: 'pnpm/10.4.1 node/v22.18.0' });
    expect(text).toContain('pnpm approve-builds');
    expect(text).toContain('pnpm rebuild better-sqlite3');
  });
});

describe('importConnectorDependency', () => {
  // `duckdb` here stands for any driver that downloads its binary in an
  // install script; the DuckDB driver ZLens installs today has none (below).
  const realVersions = process.versions;
  beforeEach(() => {
    Object.defineProperty(process, 'versions', { value: { ...realVersions, node: '24.15.0' }, configurable: true, enumerable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'versions', { value: realVersions, configurable: true, enumerable: true });
  });

  function connectorPackage(root: string, name: string, body: string): void {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), body);
  }

  it('says how to repair a driver whose native binary npm 12 never downloaded', async () => {
    const connectors = join(tempDir(), '.dql', 'connectors');
    connectorPackage(connectors, 'duckdb', `throw new Error(${JSON.stringify(DUCKDB_ERROR.message)});`);
    const load = importConnectorDependency('duckdb', { driver: 'duckdb', moduleSearchPaths: [connectors] });
    await expect(load).rejects.toBeInstanceOf(ConnectorNativeBindingError);
    await expect(load).rejects.toThrow(`npm --prefix ${connectors} install-scripts approve duckdb`);
  });

  it('says to reinstall @duckdb/node-api with optional dependencies when its platform binary is missing', async () => {
    const connectors = join(tempDir(), '.dql', 'connectors');
    connectorPackage(connectors, '@duckdb/node-api', `throw new Error("Cannot find module '@duckdb/node-bindings-linux-x64/duckdb.node'");`);
    const load = importConnectorDependency('@duckdb/node-api', { driver: 'duckdb', moduleSearchPaths: [connectors] });
    await expect(load).rejects.toBeInstanceOf(ConnectorNativeBindingError);
    await expect(load).rejects.toThrow(`npm --prefix ${connectors} install @duckdb/node-api --include=optional`);
    await expect(load).rejects.not.toThrow('install-scripts');
  });

  it('still says "install it" when the package is absent', async () => {
    const connectors = join(tempDir(), '.dql', 'connectors');
    mkdirSync(connectors, { recursive: true });
    await expect(importConnectorDependency('zlens-absent-driver', { driver: 'duckdb', moduleSearchPaths: [connectors] }))
      .rejects.toBeInstanceOf(MissingConnectorDependencyError);
  });

  it('loads a working package', async () => {
    const connectors = join(tempDir(), '.dql', 'connectors');
    connectorPackage(connectors, 'zlens-fake-driver', 'module.exports = { ok: true };');
    await expect(importConnectorDependency('zlens-fake-driver', { driver: 'duckdb', moduleSearchPaths: [connectors] })).resolves.toEqual({ ok: true });
  });
});
