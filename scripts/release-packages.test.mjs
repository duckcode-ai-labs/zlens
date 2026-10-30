import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_PACKAGE_PATHS,
  assertExpectedReleaseVersion,
  assertReleaseTagCompatibility,
  assertSynchronizedReleaseVersions,
  exactPackageSpec,
  parseReleaseArguments,
  publishCommandArgs,
  readReleasePackageManifests,
} from './release-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('release arguments require exactly one operation and an explicit npm dist-tag', () => {
  assert.throws(
    () => parseReleaseArguments(['--dry-run']),
    /Release tag is required/,
  );
  assert.throws(
    () => parseReleaseArguments(['--dry-run', '--publish', '--tag', 'next']),
    /exactly one/,
  );
  assert.throws(
    () => parseReleaseArguments(['--publish', '--tag', 'preview']),
    /Release tag is required/,
  );
  assert.throws(
    () => parseReleaseArguments(['--dry-run', '--tag', 'next']),
    /Expected version is required/,
  );
  assert.throws(
    () => parseReleaseArguments(['--dry-run', '--tag', 'next', '--expected-version', 'not-a-version']),
    /not a valid stable or prerelease SemVer version/,
  );

  assert.deepEqual(
    parseReleaseArguments(['--dry-run', '--tag=next', '--expected-version=1.14.3-rc.1']),
    {
      dryRun: true,
      publish: false,
      tag: 'next',
      expectedVersion: '1.14.3-rc.1',
      otp: undefined,
    },
  );
});

test('stable and prerelease versions cannot use the wrong npm dist-tag', () => {
  assert.equal(assertReleaseTagCompatibility('1.14.3', 'latest'), 'latest');
  assert.equal(assertReleaseTagCompatibility('1.14.3-rc.1', 'next'), 'next');
  assert.throws(
    () => assertReleaseTagCompatibility('1.14.3-rc.1', 'latest'),
    /must use --tag next/,
  );
  assert.throws(
    () => assertReleaseTagCompatibility('1.14.3', 'next'),
    /must use --tag latest/,
  );
});

test('the trusted expected version must exactly equal synchronized manifests before release work begins', () => {
  assert.equal(assertExpectedReleaseVersion('1.14.3-rc.1', '1.14.3-rc.1'), '1.14.3-rc.1');
  assert.throws(
    () => assertExpectedReleaseVersion('1.14.3-rc.1', '1.14.3'),
    /manifests declare 1\.14\.3-rc\.1, expected 1\.14\.3/,
  );
  assert.throws(
    () => assertExpectedReleaseVersion('1.14.3', '1.14.3-rc.1'),
    /manifests declare 1\.14\.3, expected 1\.14\.3-rc\.1/,
  );
});

test('every publish command carries its explicit npm dist-tag and preserves otp redaction shape', () => {
  assert.deepEqual(
    publishCommandArgs({ tag: 'next', otp: '123456' }),
    ['publish', '--access', 'public', '--no-git-checks', '--tag', 'next', '--otp', '123456'],
  );
  assert.deepEqual(
    publishCommandArgs({ tag: 'latest', otp: undefined }),
    ['publish', '--access', 'public', '--no-git-checks', '--tag', 'latest'],
  );
  assert.equal(
    exactPackageSpec('@zlens/cli', '1.14.3-rc.1'),
    '@zlens/cli@1.14.3-rc.1',
  );
});

test('release package manifests must share one valid SemVer version', () => {
  const releaseManifests = [
    { relPath: 'packages/dql-core', manifest: { version: '1.14.3-rc.1' } },
    { relPath: 'apps/cli', manifest: { version: '1.14.3-rc.1' } },
  ];
  assert.equal(assertSynchronizedReleaseVersions(releaseManifests), '1.14.3-rc.1');
  assert.throws(
    () => assertSynchronizedReleaseVersions([
      ...releaseManifests,
      { relPath: 'packages/dql-agent', manifest: { version: '1.14.2' } },
    ]),
    /must be synchronized/,
  );
});

test('the release inventory has exactly the intended public packages and excludes private app versions', () => {
  const expectedPaths = [
    'packages/dql-telemetry',
    'packages/dql-openlineage',
    'packages/dql-plugin-api',
    'packages/dql-ui',
    'packages/dql-core',
    'packages/dql-compiler',
    'packages/dql-runtime',
    'packages/dql-charts',
    'packages/dql-project',
    'packages/dql-governance',
    'packages/dql-connectors',
    'packages/dql-notebook',
    'packages/dql-agent',
    'packages/dql-mcp',
    'packages/dql-slack',
    'packages/dql-lsp',
    'apps/cli',
    'packages/create-dql-app',
    'packages/zlens',
    'packages/create-zlens',
  ];
  assert.deepEqual(RELEASE_PACKAGE_PATHS, expectedPaths);

  const releaseManifests = readReleasePackageManifests(root);
  assert.equal(releaseManifests.length, 20);
  // Version-agnostic: every release bumps the workspace in lockstep, so the
  // CLI's own version is the one the whole inventory must share.
  const releaseVersion = JSON.parse(readFileSync(path.join(root, 'apps/cli/package.json'), 'utf8')).version;
  assert.equal(assertSynchronizedReleaseVersions(releaseManifests), releaseVersion);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, 'packages/create-dql-app/templates/starter/package.json'), 'utf8'))
      .devDependencies['@zlens/cli'],
    `^${releaseVersion}`,
  );
  assert.deepEqual(
    [
      ['apps/dql-notebook/package.json', '1.6.34'],
      ['apps/desktop/package.json', '1.6.1'],
      ['packages/datalex-lsp/package.json', '0.2.0'],
    ].map(([relativePath, expectedVersion]) => [
      relativePath,
      JSON.parse(readFileSync(path.join(root, relativePath), 'utf8')).version,
      expectedVersion,
    ]),
    [
      ['apps/dql-notebook/package.json', '1.6.34', '1.6.34'],
      ['apps/desktop/package.json', '1.6.1', '1.6.1'],
      ['packages/datalex-lsp/package.json', '0.2.0', '0.2.0'],
    ],
  );
});

test('the release workflow passes its trusted Git tag version to the release script', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /- 'zlens-v\*\.\*\.\*'/);
  assert.doesNotMatch(workflow, /- 'v\*\.\*\.\*'/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/zlens-v'\)/);
  assert.match(workflow, /release_version="\$\{GITHUB_REF_NAME#zlens-v\}"/);
  assert.match(
    workflow,
    /node scripts\/release-packages\.mjs --publish --tag "\$\{\{ steps\.npm_dist_tag\.outputs\.tag \}\}" --expected-version "\$\{GITHUB_REF_NAME#zlens-v\}"/,
  );
});
