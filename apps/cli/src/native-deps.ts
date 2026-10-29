import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
  isNativeBindingError,
  nativeBindingHelp,
  nativeInstallContextFor,
  type NativeInstallContext,
} from '@zlens/connectors';

/**
 * ZLens keeps its local index, run history, memory and caches in SQLite
 * through better-sqlite3, whose native binary is downloaded by the package's
 * install script. npm 12 blocks that script unless package.json allows it
 * (`"allowScripts": { "better-sqlite3": true }`), and pnpm 10 skips it until
 * the build is approved. The JavaScript still installs, so the failure only
 * shows when a store opens: "Could not locate the bindings file", often
 * wrapped in another message ("Failed to compile project: …"). This module
 * checks once, up front, and turns that into the commands that fix it.
 */

const BETTER_SQLITE3_ROLE = 'the SQLite library ZLens keeps its local index and run history in';

type DatabaseConstructor = new (filename: string) => { close(): void };

export interface BetterSqlite3Probe {
  ok: boolean;
  error?: unknown;
  /** The folder better-sqlite3 resolved from, when it resolved. */
  packageDir?: string;
}

const cliRequire = createRequire(import.meta.url);

/** Open and close an in-memory database: the cheapest load of the native binary. */
export function probeBetterSqlite3(req: NodeRequire = cliRequire): BetterSqlite3Probe {
  let packageDir: string | undefined;
  try {
    packageDir = dirname(req.resolve('better-sqlite3/package.json'));
  } catch {
    // Reported by the load below.
  }
  try {
    const loaded = req('better-sqlite3') as DatabaseConstructor | { default: DatabaseConstructor };
    const Database = (typeof loaded === 'function' ? loaded : loaded.default) as DatabaseConstructor;
    new Database(':memory:').close();
    return { ok: true, packageDir };
  } catch (error) {
    return { ok: false, error, packageDir };
  }
}

function contextFor(packageDir: string | undefined): NativeInstallContext {
  return packageDir ? nativeInstallContextFor(packageDir) : { kind: 'project', dir: process.cwd() };
}

/** The repair message for a better-sqlite3 that cannot load. */
export function betterSqlite3Help(error: unknown, packageDir?: string, userAgent?: string): string {
  return nativeBindingHelp({
    packageName: 'better-sqlite3',
    role: BETTER_SQLITE3_ROLE,
    error,
    context: contextFor(packageDir),
    userAgent,
  });
}

/**
 * Commands that never open a SQLite store and so must keep working on a
 * broken install (`doctor` reports the problem as a check instead).
 */
const COMMANDS_WITHOUT_SQLITE = new Set(['doctor', 'init', 'new', 'parse', 'fmt']);

export function commandNeedsSqlite(command: string): boolean {
  return !COMMANDS_WITHOUT_SQLITE.has(command);
}

/**
 * Before a command that opens SQLite: when better-sqlite3 cannot load because
 * of its native binary, the repair message (else null, and the command runs).
 */
export function sqlitePreflightMessage(command: string, probe: () => BetterSqlite3Probe = probeBetterSqlite3): string | null {
  if (!commandNeedsSqlite(command)) return null;
  const result = probe();
  if (result.ok || !isNativeBindingError(result.error)) return null;
  return betterSqlite3Help(result.error, result.packageDir);
}

/**
 * For the CLI's last-resort error handler: an error (or a message that wraps
 * one) caused by a native binary that cannot load gets the repair message.
 */
export function explainNativeDependencyError(error: unknown): string | null {
  if (!error) return null;
  // A connector already explained itself (ConnectorNativeBindingError).
  if (error instanceof Error && error.name === 'ConnectorNativeBindingError') return error.message;
  if (!isNativeBindingError(error)) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (/duckdb/i.test(message) && !/better[-_]sqlite3/i.test(message)) return null;
  return betterSqlite3Help(error, probeBetterSqlite3().packageDir);
}
