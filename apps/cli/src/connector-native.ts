import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { NATIVE_OPTIONAL_BINARY_PACKAGES, isNativeBindingError } from '@zlens/connectors';

/**
 * Driver packages ZLens installs into `.dql/connectors` whose native binary
 * arrives through their own install script. npm 12 blocks that script unless
 * the folder's package.json lists the package in `allowScripts`, so ZLens
 * writes that entry when it installs one. None today: the DuckDB driver
 * (`@duckdb/node-api`, RFC 0011) has no install script. (Packages with only an
 * optional native speed-up, like ssh2, work without their script and are left
 * alone.)
 */
export const NATIVE_CONNECTOR_PACKAGES: readonly string[] = [];

/** Driver packages whose binary is a per-platform optional dependency (`@duckdb/node-api`). */
const OPTIONAL_BINARY_CONNECTOR_PACKAGES: readonly string[] = NATIVE_OPTIONAL_BINARY_PACKAGES;

export function isNativeConnectorPackage(packageName: string): boolean {
  return NATIVE_CONNECTOR_PACKAGES.includes(packageName) || OPTIONAL_BINARY_CONNECTOR_PACKAGES.includes(packageName);
}

/**
 * Create or update `<installRoot>/package.json` so npm 12 runs the install
 * script of each native driver in `packageNames` (a name-only `true`, which
 * npm 10 and 11 ignore). An explicit `false` someone wrote is kept. Returns
 * whether the file changed.
 */
export function seedConnectorAllowScripts(installRoot: string, packageNames: string[]): boolean {
  mkdirSync(installRoot, { recursive: true });
  const packageJsonPath = join(installRoot, 'package.json');
  let pkg: Record<string, unknown> = {};
  let existed = false;
  if (existsSync(packageJsonPath)) {
    existed = true;
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) pkg = parsed as Record<string, unknown>;
    } catch {
      // A broken file is rewritten below; npm could not read it either.
    }
  } else {
    pkg = { private: true, description: 'Project-local ZLens connector packages' };
  }
  const current = pkg.allowScripts && typeof pkg.allowScripts === 'object' && !Array.isArray(pkg.allowScripts)
    ? { ...(pkg.allowScripts as Record<string, unknown>) }
    : {};
  let changed = !existed;
  for (const name of packageNames.filter((packageName) => NATIVE_CONNECTOR_PACKAGES.includes(packageName))) {
    const covered = Object.keys(current).some((key) => key === name || key.startsWith(`${name}@`));
    if (covered) continue;
    current[name] = true;
    changed = true;
  }
  if (Object.keys(current).length > 0) pkg.allowScripts = current;
  if (changed) writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  return changed;
}

/**
 * The error loading `packageName` from the first of `searchPaths` that has it,
 * when that error is a missing or mismatched native binary; null when it
 * loads, is absent, or fails for another reason.
 */
export function connectorBindingError(searchPaths: string[], packageName: string): { error: unknown; packageDir: string } | null {
  for (const basePath of searchPaths) {
    const req = createRequire(join(basePath, 'package.json'));
    let packageDir: string;
    try {
      packageDir = dirname(req.resolve(`${packageName}/package.json`));
    } catch {
      continue;
    }
    try {
      req(packageName);
      return null;
    } catch (error) {
      return isNativeBindingError(error) ? { error, packageDir } : null;
    }
  }
  return null;
}

/**
 * Repair a native driver in `.dql/connectors` whose binary is missing. A
 * package whose binary is a per-platform optional dependency is reinstalled at
 * the version it has, with optional dependencies included (they were skipped,
 * or the folder came from another platform; nothing is compiled). A package
 * that downloads its binary in an install script gets that script allowed, then
 * `npm rebuild`. Returns true when it loads afterwards. `runNpm` runs one npm
 * command (throws on failure).
 */
export function repairConnectorBinding(
  installRoot: string,
  packageName: string,
  runNpm: (args: string[]) => void,
): boolean {
  if (!isNativeConnectorPackage(packageName)) return false;
  const broken = connectorBindingError([installRoot], packageName);
  if (!broken) return true;
  if (OPTIONAL_BINARY_CONNECTOR_PACKAGES.includes(packageName)) {
    const version = installedVersion(broken.packageDir);
    runNpm(['install', '--prefix', installRoot, '--include=optional', '--no-audit', '--no-fund', version ? `${packageName}@${version}` : packageName]);
  } else {
    seedConnectorAllowScripts(installRoot, [packageName]);
    runNpm(['rebuild', '--prefix', installRoot, packageName]);
  }
  return connectorBindingError([installRoot], packageName) === null;
}

function installedVersion(packageDir: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}
