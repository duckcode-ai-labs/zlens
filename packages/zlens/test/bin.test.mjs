// `npx zlens` runs this package's one command: it must be exactly @zlens/cli's `zlens`.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'zlens.mjs');
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const cliEntry = createRequire(import.meta.url).resolve('@zlens/cli/dist/index.js');
const env = { ...process.env, ZLENS_DISABLE_VERSION_CHECK: '1' };

const run = (entry, args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env });

test('has exactly one command, so npx can run it', () => {
  assert.deepEqual(Object.keys(manifest.bin), ['zlens']);
});

test('prints the same version and help as @zlens/cli', () => {
  const wrapped = run(bin, ['--version']);
  const direct = run(cliEntry, ['--version']);
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.match(wrapped.stdout, /^zlens \d+\.\d+\.\d+/);
  assert.equal(wrapped.stdout, direct.stdout);
  assert.equal(wrapped.stderr, '');
  assert.equal(run(bin, ['--help']).stdout, run(cliEntry, ['--help']).stdout);
});

test('keeps the exit code of an unknown command', () => {
  assert.equal(run(bin, ['no-such-command']).status, 1);
});
