import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { freePort, nodeSatisfies, parseGateArguments, rangeAllows } from './launch-gate.mjs';
import { buildPackument, startLocalRegistry } from './launch-gate/local-registry.mjs';

test('a caret range below 1.0 never crosses a minor version (the samples pin ^0.1.0)', () => {
  assert.equal(rangeAllows('^0.1.0', '0.1.0'), true);
  assert.equal(rangeAllows('^0.1.0', '0.1.4'), true);
  assert.equal(rangeAllows('^0.1.0', '0.2.0'), false);
  assert.equal(rangeAllows('^0.2.0', '0.2.0'), true);
  assert.equal(rangeAllows('^1.2.0', '1.9.0'), true);
  assert.equal(rangeAllows('^1.2.0', '2.0.0'), false);
  assert.equal(rangeAllows('~0.2.0', '0.2.5'), true);
  assert.equal(rangeAllows('0.2.0', '0.2.0'), true);
  assert.equal(rangeAllows('^0.2.0', '0.2.0-rc.1'), false);
  assert.equal(rangeAllows('latest', '0.2.0'), false);
});

test('gate arguments', () => {
  const options = parseGateArguments(['--only', 'dbt,create', '--port', '3630', '--python', 'python3.13'], new Date('2026-10-16T12:00:00Z'));
  assert.deepEqual([...options.only], ['dbt', 'create']);
  assert.equal(options.port, 3630);
  assert.equal(options.python, 'python3.13');
  assert.match(options.out, /gate-20261016-120000$/);
  assert.throws(() => parseGateArguments(['--only', 'docs']), /Unknown --only/);
  assert.throws(() => parseGateArguments(['--port', '80']), /port/);
});

test('the gate runs the system npm and npm 12 by default', () => {
  const defaults = parseGateArguments([]);
  assert.deepEqual(defaults.npm, ['system', '12']);
  assert.equal(defaults.node, null);
  const options = parseGateArguments(['--npm', '12,system,12', '--node', '/opt/node24/bin']);
  assert.deepEqual(options.npm, ['12', 'system']);
  assert.equal(options.node, '/opt/node24/bin');
  assert.deepEqual(parseGateArguments(['--npm', 'system']).npm, ['system']);
  assert.throws(() => parseGateArguments(['--npm', 'latest']), /Unknown --npm lane/);
  // A Node line of its own (Node 26 LTS), with the npm that Node ships with.
  assert.deepEqual(parseGateArguments(['--npm', 'system,12,bundled:/opt/node26/bin']).npm, ['system', '12', 'bundled:/opt/node26/bin']);
  assert.throws(() => parseGateArguments(['--npm', 'bundled:']), /Unknown --npm lane/);
});

test("npm 12's engines range: ^22.22.2 || ^24.15.0 || >=26", () => {
  const engines = '^22.22.2 || ^24.15.0 || >=26';
  assert.equal(nodeSatisfies(engines, 'v22.18.0'), false);
  assert.equal(nodeSatisfies(engines, 'v22.22.2'), true);
  assert.equal(nodeSatisfies(engines, 'v23.7.0'), false);
  assert.equal(nodeSatisfies(engines, 'v24.14.9'), false);
  assert.equal(nodeSatisfies(engines, 'v24.22.0'), true);
  assert.equal(nodeSatisfies(engines, 'v26.12.0'), true);
  assert.equal(nodeSatisfies('>=18.17.0 <19', 'v18.20.1'), true);
  assert.equal(nodeSatisfies('>=18.17.0 <19', 'v20.0.0'), false);
  assert.equal(nodeSatisfies('20', 'v20.18.1'), true);
});

test('the packed version is added to the public packument as latest; older versions stay', () => {
  const local = {
    version: '0.2.0',
    manifest: { name: '@zlens/cli', version: '0.2.0', bin: { zlens: 'dist/index.js' }, scripts: { build: 'x' }, devDependencies: { a: '1' } },
    fileName: 'zlens-cli-0.2.0.tgz',
    integrity: 'sha512-abc',
    shasum: 'def',
  };
  const upstream = { name: '@zlens/cli', versions: { '0.1.0': { version: '0.1.0' } }, 'dist-tags': { latest: '0.1.0' }, time: {} };
  const doc = buildPackument(local, upstream, 'http://127.0.0.1:3620');
  assert.deepEqual(Object.keys(doc.versions).sort(), ['0.1.0', '0.2.0']);
  assert.equal(doc['dist-tags'].latest, '0.2.0');
  assert.equal(doc.versions['0.2.0'].dist.tarball, 'http://127.0.0.1:3620/-/gate/zlens-cli-0.2.0.tgz');
  assert.equal(doc.versions['0.2.0'].scripts, undefined);
  assert.equal(upstream['dist-tags'].latest, '0.1.0', 'the upstream document is not modified');
  const fresh = buildPackument(local, null, 'http://127.0.0.1:3620');
  assert.deepEqual(Object.keys(fresh.versions), ['0.2.0']);
});

test('the local registry serves a packed tarball and its packument', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zlens-gate-registry-'));
  try {
    const pkgDir = path.join(dir, 'src', 'package');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'zlens-gate-selftest-pkg', version: '9.9.9' }));
    const tarballs = path.join(dir, 'tarballs');
    mkdirSync(tarballs);
    const tar = spawnSync('tar', ['-czf', path.join(tarballs, 'zlens-gate-selftest-pkg-9.9.9.tgz'), '-C', path.join(dir, 'src'), 'package']);
    assert.equal(tar.status, 0);
    const registry = await startLocalRegistry({ tarballDir: tarballs, port: await freePort(3690) });
    try {
      const doc = await fetch(`${registry.url}zlens-gate-selftest-pkg`).then((response) => response.json());
      assert.equal(doc['dist-tags'].latest, '9.9.9');
      const tarball = await fetch(doc.versions['9.9.9'].dist.tarball);
      assert.equal(tarball.status, 200);
      assert.ok((await tarball.arrayBuffer()).byteLength > 0);
    } finally {
      await registry.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
