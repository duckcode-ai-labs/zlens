// Every package ZLens publishes is Apache-2.0 and its npm tarball carries the
// licence text and the NOTICE. Run: node --test scripts/license-files.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_PACKAGE_PATHS, licenseFileFor } from './release-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/duckcode-ai-labs/zlens';
// sha256 of https://www.apache.org/licenses/LICENSE-2.0.txt
const APACHE_2_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';

const readManifest = (relPath) => JSON.parse(readFileSync(path.join(root, relPath, 'package.json'), 'utf-8'));

function workspacePackagePaths() {
  const paths = [];
  for (const workspaceDir of ['apps', 'packages']) {
    for (const entry of readdirSync(path.join(root, workspaceDir))) {
      if (existsSync(path.join(root, workspaceDir, entry, 'package.json'))) paths.push(`${workspaceDir}/${entry}`);
    }
  }
  return paths.sort();
}

// The release list plus anything else that is publishable (not private).
const publishedPaths = [
  ...new Set([
    ...RELEASE_PACKAGE_PATHS,
    ...workspacePackagePaths().filter((relPath) => readManifest(relPath).private !== true),
  ]),
];

function packedFiles(relPath) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: path.join(root, relPath),
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  assert.equal(result.status, 0, `npm pack --dry-run failed in ${relPath}:\n${result.stderr}`);
  // Lifecycle scripts (prepack) print to stdout ahead of the JSON report.
  const start = result.stdout.search(/^\[/m);
  assert.notEqual(start, -1, `no JSON in npm pack output for ${relPath}:\n${result.stdout}`);
  const [report] = JSON.parse(result.stdout.slice(start));
  return report.files.map((file) => file.path);
}

test('root LICENSE is the verbatim Apache License 2.0 text', () => {
  const digest = createHash('sha256').update(readFileSync(path.join(root, 'LICENSE'))).digest('hex');
  assert.equal(digest, APACHE_2_SHA256);
});

test('root NOTICE names ZLens and its copyright holder', () => {
  const notice = readFileSync(path.join(root, 'NOTICE'), 'utf-8');
  assert.match(notice, /^ZLens\nCopyright 2026 DuckCode AI Labs\n/);
  assert.match(notice, /\nZLens is a product of DuckCode AI Labs\n/);
});

test('the VS Code extension LICENSE.txt is the full root LICENSE', () => {
  assert.equal(
    readFileSync(path.join(root, 'apps/vscode-extension/LICENSE.txt'), 'utf-8'),
    readFileSync(path.join(root, 'LICENSE'), 'utf-8'),
  );
});

test('every manifest in the repository declares Apache-2.0', () => {
  for (const relPath of ['.', ...workspacePackagePaths()]) {
    assert.equal(readManifest(relPath).license, 'Apache-2.0', `${relPath}/package.json`);
  }
});

for (const relPath of publishedPaths) {
  test(`${relPath} publishes Apache-2.0 with LICENSE, NOTICE and repository links`, () => {
    const manifest = readManifest(relPath);
    const licenseFile = licenseFileFor(relPath);
    assert.equal(manifest.license, 'Apache-2.0');
    assert.equal(manifest.repository?.url, `${REPO}.git`);
    assert.equal(manifest.repository?.directory, relPath);
    assert.equal(manifest.homepage, REPO);
    assert.equal(manifest.bugs?.url, `${REPO}/issues`);
    assert.ok(manifest.files?.includes(licenseFile), `"files" lists ${licenseFile}`);
    assert.ok(manifest.files?.includes('NOTICE'), '"files" lists NOTICE');
    assert.match(manifest.scripts?.prepack ?? '', /scripts\/package-license-files\.mjs/);

    const files = packedFiles(relPath);
    assert.ok(files.includes(licenseFile), `tarball has ${licenseFile}: ${files.slice(0, 10).join(', ')}`);
    assert.ok(files.includes('NOTICE'), `tarball has NOTICE: ${files.slice(0, 10).join(', ')}`);
    assert.equal(
      readFileSync(path.join(root, relPath, licenseFile), 'utf-8'),
      readFileSync(path.join(root, 'LICENSE'), 'utf-8'),
      `${relPath}/${licenseFile} is the root LICENSE`,
    );
  });
}
