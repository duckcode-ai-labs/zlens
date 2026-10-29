import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorBindingError, repairConnectorBinding, seedConnectorAllowScripts } from './connector-native.js';

const temp: string[] = [];
afterEach(() => {
  while (temp.length) rmSync(temp.pop()!, { recursive: true, force: true });
});

function connectorsDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zlens-connectors-')));
  temp.push(dir);
  return join(dir, '.dql', 'connectors');
}

const NO_BINARY = "throw new Error(\"Cannot find module '@duckdb/node-bindings-linux-x64/duckdb.node'\");";

function writeNodeApi(root: string, body: string): void {
  const dir = join(root, 'node_modules', '@duckdb', 'node-api');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@duckdb/node-api', version: '1.5.6-r.2', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), body);
}

function readPkg(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Record<string, unknown>;
}

describe('seedConnectorAllowScripts', () => {
  it('creates .dql/connectors/package.json and allows no install script: no driver ZLens installs has one', () => {
    const root = connectorsDir();
    expect(seedConnectorAllowScripts(root, ['@duckdb/node-api', 'duckdb', 'pg'])).toBe(true);
    expect(readPkg(root)).toEqual({ private: true, description: 'Project-local ZLens connector packages' });
    expect(seedConnectorAllowScripts(root, ['@duckdb/node-api'])).toBe(false);
  });

  it('leaves an existing file and its allowScripts as they are', () => {
    const root = connectorsDir();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { pg: '^8.13.0' }, allowScripts: { duckdb: true } }));
    expect(seedConnectorAllowScripts(root, ['pg', '@duckdb/node-api'])).toBe(false);
    expect(readPkg(root)).toEqual({ dependencies: { pg: '^8.13.0' }, allowScripts: { duckdb: true } });
  });
});

describe('repairConnectorBinding', () => {
  it('reinstalls @duckdb/node-api at its own version, with optional dependencies, when its binary for this computer is missing', () => {
    const root = connectorsDir();
    writeNodeApi(root, NO_BINARY);
    expect(connectorBindingError([root], '@duckdb/node-api')?.packageDir).toBe(join(root, 'node_modules', '@duckdb', 'node-api'));

    const runNpm = vi.fn((args: string[]) => {
      // What the reinstall does: the platform binary package arrives.
      expect(args).toEqual(['install', '--prefix', root, '--include=optional', '--no-audit', '--no-fund', '@duckdb/node-api@1.5.6-r.2']);
      writeNodeApi(root, 'module.exports = { DuckDBInstance: { create: async () => ({}) } };');
    });
    expect(repairConnectorBinding(root, '@duckdb/node-api', runNpm)).toBe(true);
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(connectorBindingError([root], '@duckdb/node-api')).toBeNull();
    // No install-script approval: the package has no script.
    expect(existsSync(join(root, 'package.json'))).toBe(false);
  });

  it('does nothing for a driver that loads, or one without a native binary', () => {
    const root = connectorsDir();
    writeNodeApi(root, 'module.exports = {};');
    const runNpm = vi.fn();
    expect(repairConnectorBinding(root, '@duckdb/node-api', runNpm)).toBe(true);
    expect(repairConnectorBinding(root, 'pg', runNpm)).toBe(false);
    expect(repairConnectorBinding(root, 'duckdb', runNpm)).toBe(false);
    expect(runNpm).not.toHaveBeenCalled();
  });
});
