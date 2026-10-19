import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DUCKDB_SOURCE_BUILD_ENV,
  DuckDBNodeUnsupportedError,
  duckdbHasPrebuiltBinary,
  duckdbNoPrebuiltHelp,
  duckdbNoPrebuiltReason,
  duckdbSourceBuildAllowed,
} from './duckdb-node-support.js';
import { ConnectorNativeBindingError, MissingConnectorDependencyError, importConnectorDependency } from './optional-dependency.js';

const NODE_26 = "ZLens's DuckDB driver has no prebuilt binary for Node 26 yet; use Node 24 LTS or 22.";

const realVersions = process.versions;
function runOnNode(version: string): void {
  Object.defineProperty(process, 'versions', { value: { ...realVersions, node: version }, configurable: true, enumerable: true });
}

const temp: string[] = [];
afterEach(() => {
  Object.defineProperty(process, 'versions', { value: realVersions, configurable: true, enumerable: true });
  while (temp.length) rmSync(temp.pop()!, { recursive: true, force: true });
});

function connectorsDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zlens-duckdb-node-')));
  temp.push(dir);
  const connectors = join(dir, '.dql', 'connectors');
  mkdirSync(connectors, { recursive: true });
  return connectors;
}

function writeDuckdb(root: string, body: string): void {
  const dir = join(root, 'node_modules', 'duckdb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'duckdb', version: '1.4.4', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), body);
}

describe('duckdb prebuilt binaries by Node major', () => {
  it('has them for Node 20, 22 and 24 only (duckdb@1.4.4 publishes ABI 115, 127, 137)', () => {
    for (const version of ['20.19.0', '22.18.0', '24.15.0', 'v24.3.0']) expect(duckdbHasPrebuiltBinary(version)).toBe(true);
    for (const version of ['18.20.4', '21.7.3', '23.11.0', '25.2.1', '26.12.0']) expect(duckdbHasPrebuiltBinary(version)).toBe(false);
  });

  it('says plainly which Node to use instead', () => {
    expect(duckdbNoPrebuiltReason('26.12.0')).toBe(NODE_26);
    expect(duckdbNoPrebuiltReason('25.2.1')).toBe("ZLens's DuckDB driver has no prebuilt binary for Node 25 yet; use Node 24 LTS or 22.");
    expect(duckdbNoPrebuiltReason('24.15.0')).toBeNull();
    const help = duckdbNoPrebuiltHelp('26.12.0')!;
    expect(help.split('\n')[0]).toBe(NODE_26);
    expect(help).toContain('This is Node 26.12.0.');
    expect(help).toContain('nvm install 24');
    expect(help).toContain(`${DUCKDB_SOURCE_BUILD_ENV}=1`);
    expect(duckdbNoPrebuiltHelp('22.18.0')).toBeNull();
  });

  it('lets someone opt into the source build', () => {
    expect(duckdbSourceBuildAllowed({})).toBe(false);
    expect(duckdbSourceBuildAllowed({ [DUCKDB_SOURCE_BUILD_ENV]: '1' })).toBe(true);
    expect(duckdbSourceBuildAllowed({ [DUCKDB_SOURCE_BUILD_ENV]: 'true' })).toBe(true);
    expect(duckdbSourceBuildAllowed({ [DUCKDB_SOURCE_BUILD_ENV]: '0' })).toBe(false);
  });
});

describe('importConnectorDependency on a Node without a duckdb prebuilt binary', () => {
  it('says to switch Node, not "connector package missing", when duckdb is absent', async () => {
    runOnNode('26.12.0');
    const load = importConnectorDependency('duckdb', { driver: 'duckdb', moduleSearchPaths: [connectorsDir()] });
    await expect(load).rejects.toBeInstanceOf(DuckDBNodeUnsupportedError);
    await expect(load).rejects.toThrow(NODE_26);
    await expect(load).rejects.not.toThrow('connector package missing');
  });

  it('says to switch Node, not "rebuild it", when a copy from another Node cannot load', async () => {
    runOnNode('26.12.0');
    const connectors = connectorsDir();
    writeDuckdb(connectors, "throw new Error(\"Cannot find module '/x/node_modules/duckdb/lib/binding/duckdb.node'\");");
    const load = importConnectorDependency('duckdb', { driver: 'file', moduleSearchPaths: [connectors] });
    await expect(load).rejects.toBeInstanceOf(DuckDBNodeUnsupportedError);
    await expect(load).rejects.toThrow(NODE_26);
    await expect(load).rejects.not.toThrow('rebuild duckdb');
  });

  it('loads a copy that works (built from source) without complaint', async () => {
    runOnNode('26.12.0');
    const connectors = connectorsDir();
    writeDuckdb(connectors, 'module.exports = { built: "from source" };');
    await expect(importConnectorDependency('duckdb', { driver: 'duckdb', moduleSearchPaths: [connectors] }))
      .resolves.toEqual({ built: 'from source' });
  });

  it('keeps the old messages on Node 24', async () => {
    runOnNode('24.15.0');
    const connectors = connectorsDir();
    await expect(importConnectorDependency('duckdb', { driver: 'duckdb', moduleSearchPaths: [connectors] }))
      .rejects.toBeInstanceOf(MissingConnectorDependencyError);
    writeDuckdb(connectors, "throw new Error(\"Cannot find module '/x/node_modules/duckdb/lib/binding/duckdb.node'\");");
    await expect(importConnectorDependency('duckdb', { driver: 'duckdb', moduleSearchPaths: [connectors] }))
      .rejects.toBeInstanceOf(ConnectorNativeBindingError);
  });

  it('names the Node it was raised on', () => {
    const error = new DuckDBNodeUnsupportedError('25.2.1');
    expect(error.code).toBe('DUCKDB_NODE_UNSUPPORTED');
    expect(error.message.split('\n')[0]).toBe("ZLens's DuckDB driver has no prebuilt binary for Node 25 yet; use Node 24 LTS or 22.");
  });
});
