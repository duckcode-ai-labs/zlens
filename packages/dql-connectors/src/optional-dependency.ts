import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ConnectionConfig } from './connector.js';
import { isNativeBindingError, nativeBindingHelp, nativeInstallContextFor } from './native-binding.js';
import { DuckDBNodeUnsupportedError, duckdbHasPrebuiltBinary } from './duckdb-node-support.js';

export class MissingConnectorDependencyError extends Error {
  constructor(
    readonly packageName: string,
    readonly driver: string,
    readonly installHint: string,
  ) {
    super(`DQL connector package missing for ${driver}: install ${packageName}. ${installHint}`);
    this.name = 'MissingConnectorDependencyError';
  }
}

/**
 * The driver package is installed but cannot load: its native binary is
 * missing (npm 12 / pnpm 10 blocked the install script) or was built for a
 * different Node. Reinstalling the package does not help; the message says
 * what does.
 */
export class ConnectorNativeBindingError extends Error {
  constructor(
    readonly packageName: string,
    readonly driver: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorNativeBindingError';
  }
}

const DRIVER_ROLES: Record<string, string> = {
  duckdb: 'the DuckDB driver ZLens queries DuckDB and local files with',
  'better-sqlite3': 'the SQLite driver',
};

function packageDirOf(req: NodeRequire, packageName: string): string | undefined {
  try {
    return dirname(req.resolve(`${packageName}/package.json`));
  } catch {
    return undefined;
  }
}

export async function importConnectorDependency(
  packageName: string,
  config: ConnectionConfig,
): Promise<unknown> {
  const searchPaths = config.moduleSearchPaths ?? [];
  const driver = config.driver === 'file' ? 'duckdb' : config.driver;
  for (const basePath of searchPaths) {
    const req = createRequire(join(basePath, 'package.json'));
    try {
      return req(packageName);
    } catch (error) {
      // Present here but unloadable: say why instead of "install it" again.
      const packageDir = packageDirOf(req, packageName);
      if (packageDir && isNativeBindingError(error)) {
        // A rebuild here is a DuckDB source build: say to switch Node instead.
        if (packageName === 'duckdb' && !duckdbHasPrebuiltBinary()) throw new DuckDBNodeUnsupportedError();
        throw new ConnectorNativeBindingError(packageName, driver, nativeBindingHelp({
          packageName,
          role: DRIVER_ROLES[packageName] ?? `the ${driver} driver`,
          error,
          context: nativeInstallContextFor(packageDir),
        }));
      }
      // Try the next configured project-local connector location.
    }
  }

  try {
    const dependencyName = packageName;
    return await import(dependencyName);
  } catch (error) {
    // Absent or unloadable, duckdb on a Node it has no prebuilt binary for cannot
    // be fixed by installing it: the install compiles DuckDB from source.
    if (packageName === 'duckdb' && !duckdbHasPrebuiltBinary()) throw new DuckDBNodeUnsupportedError();
    if (isNativeBindingError(error)) {
      const packageDir = packageDirOf(createRequire(import.meta.url), packageName);
      throw new ConnectorNativeBindingError(packageName, driver, nativeBindingHelp({
        packageName,
        role: DRIVER_ROLES[packageName] ?? `the ${driver} driver`,
        error,
        context: packageDir ? nativeInstallContextFor(packageDir) : { kind: 'project', dir: process.cwd() },
      }));
    }
    const installRoot = searchPaths[0] ?? '.dql/connectors';
    throw new MissingConnectorDependencyError(
      packageName,
      driver,
      `Use the Connections page install button, or run "npm install --prefix ${installRoot} ${packageName}".`,
    );
  }
}
