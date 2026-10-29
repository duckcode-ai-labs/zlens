import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Native packages ZLens loads whose compiled binary arrives through the
 * package's own install script (`prebuild-install` / `node-pre-gyp`). npm 12
 * blocks dependency install scripts unless package.json lists the package in
 * `allowScripts`, and pnpm 10 skips them unless the build is approved, so the
 * JavaScript installs but the binary never does.
 */
export const NATIVE_INSTALL_SCRIPT_PACKAGES = ['better-sqlite3'] as const;

/**
 * Native packages whose binary arrives as a per-platform optional dependency
 * (`@duckdb/node-bindings-<os>-<arch>`), with no install script. The binary is
 * missing only when optional dependencies were skipped or node_modules was
 * copied from another platform.
 */
export const NATIVE_OPTIONAL_BINARY_PACKAGES = ['@duckdb/node-api'] as const;

/** Where the broken copy lives decides which commands repair it. */
export type NativeInstallContext =
  /** A project's own node_modules: run npm in `dir` (the folder with package.json). */
  | { kind: 'project'; dir: string }
  /** ZLens's per-project driver folder (`.dql/connectors`): run npm with `--prefix dir`. */
  | { kind: 'connectors'; dir: string }
  /** `npm install -g`. */
  | { kind: 'global' }
  /** The npx cache (`npx -p @zlens/cli zlens …`). */
  | { kind: 'npx' };

const BINDING_MISSING = [
  /Could not locate the bindings file/i, // `bindings` (better-sqlite3)
  /Cannot find module '[^']*\.node'/i, // a platform binary package (@duckdb/node-bindings-*)
  /better_sqlite3\.node/i,
  /duckdb\.node/i,
];
const ABI_MISMATCH = [/NODE_MODULE_VERSION/, /compiled against a different Node\.js version/i];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/** Whether loading a native package failed because its compiled binary is missing or built for another Node. */
export function isNativeBindingError(error: unknown): boolean {
  const message = messageOf(error);
  return BINDING_MISSING.some((pattern) => pattern.test(message)) || ABI_MISMATCH.some((pattern) => pattern.test(message));
}

/** Whether the binary exists but was built for a different Node.js version. */
export function isNodeAbiMismatch(error: unknown): boolean {
  const message = messageOf(error);
  return ABI_MISMATCH.some((pattern) => pattern.test(message));
}

/**
 * Classify the folder a package was resolved from: the npx cache, a global
 * install (the outermost node_modules has no package.json beside it), or a
 * project's own install.
 */
export function nativeInstallContextFor(packageDir: string): NativeInstallContext {
  if (packageDir.includes(`${sep}_npx${sep}`)) return { kind: 'npx' };
  const marker = `${sep}node_modules${sep}`;
  const index = packageDir.indexOf(marker);
  if (index < 0) return { kind: 'project', dir: packageDir };
  const root = packageDir.slice(0, index) || sep;
  if (root.endsWith(`${sep}.dql${sep}connectors`)) return { kind: 'connectors', dir: root };
  return existsSync(join(root, 'package.json')) ? { kind: 'project', dir: root } : { kind: 'global' };
}

/** The package manager that is running us, from `npm_config_user_agent` (set by `npm run` / `pnpm run`). */
export function packageManagerFromUserAgent(userAgent = process.env.npm_config_user_agent ?? ''): { name: 'npm' | 'pnpm' | 'other' | 'unknown'; major?: number } {
  const match = /^(npm|pnpm|yarn|bun)\/(\d+)/.exec(userAgent.trim());
  if (!match) return { name: 'unknown' };
  const name = match[1] === 'npm' || match[1] === 'pnpm' ? match[1] : 'other';
  return { name, major: Number(match[2]) };
}

export interface NativeBindingHelpOptions {
  packageName: string;
  /** What the package is for, in a few words ("the SQLite library ZLens keeps its local index in"). */
  role: string;
  error: unknown;
  context: NativeInstallContext;
  userAgent?: string;
}

function firstLine(text: string): string {
  // "Could not locate the bindings file. Tried:" is followed by a list of paths; keep the sentence.
  return (text.split('\n').map((line) => line.trim()).find(Boolean) ?? '').replace(/\s*Tried:$/, '');
}

/**
 * The message a person sees instead of "Could not locate the bindings file":
 * what happened, and the commands that repair it where it is installed.
 */
export function nativeBindingHelp(options: NativeBindingHelpOptions): string {
  const { packageName: pkg, role, error, context } = options;
  const pm = packageManagerFromUserAgent(options.userAgent);
  const abi = isNodeAbiMismatch(error);
  const lines: string[] = [];

  lines.push(`ZLens could not load ${pkg}, ${role}.`);
  if ((NATIVE_OPTIONAL_BINARY_PACKAGES as readonly string[]).includes(pkg)) {
    const npm = context.kind === 'connectors' ? `npm --prefix ${quote(context.dir)}` : context.kind === 'global' ? 'npm -g' : 'npm';
    lines.push(`Its binary for this computer (${process.platform}-${process.arch}) is missing. It comes as an optional dependency, so it is skipped by --omit=optional or --no-optional, and it is absent from a node_modules folder copied from another operating system.`);
    lines.push('');
    lines.push('Reinstall it here (nothing is compiled):');
    lines.push(`  ${npm} install ${pkg} --include=optional`);
    lines.push('');
    lines.push(`Underlying error: ${firstLine(messageOf(error))}`);
    return lines.join('\n');
  }
  if (abi) {
    lines.push(`Its native binary was built for a different Node.js version than this one (${process.version}). Rebuild it for this Node.`);
  } else if (pm.name === 'npm' && (pm.major ?? 0) < 12) {
    lines.push(`Its native binary is missing: its install script did not run (for example npm install --ignore-scripts) or could not download it.`);
  } else if (pm.name === 'pnpm') {
    lines.push(`Its native binary was never built: pnpm 10 and newer skip a dependency's build script until you approve it, and ${pkg} downloads its binary in that script.`);
  } else {
    lines.push(`Its native binary was never downloaded: npm 12 and newer block a dependency's install script unless package.json lists it in "allowScripts", and ${pkg} downloads its binary in that script (npm printed "install scripts blocked ... not covered by allowScripts").`);
  }
  lines.push('');

  if (context.kind === 'global') {
    lines.push('Fix the global install:');
    lines.push(`  npm install -g @zlens/cli --allow-scripts=${pkg}`);
    lines.push(`(or repair it in place: npm rebuild -g ${pkg} --allow-scripts=${pkg})`);
  } else if (context.kind === 'npx') {
    lines.push('npx installed ZLens without running the script. Install the CLI into your project instead (npm install -D @zlens/cli, with');
    lines.push(`"allowScripts": { "${pkg}": true } in package.json), or globally: npm install -g @zlens/cli --allow-scripts=${pkg}`);
  } else if (pm.name === 'pnpm' && context.kind === 'project') {
    lines.push(`Fix it in ${context.dir}:`);
    lines.push('  pnpm approve-builds');
    lines.push(`  pnpm rebuild ${pkg}`);
  } else {
    const npm = context.kind === 'connectors' ? `npm --prefix ${quote(context.dir)}` : 'npm';
    const where = context.kind === 'connectors' ? `${context.dir}/package.json` : 'package.json';
    lines.push(context.kind === 'connectors' ? 'Fix it (from any folder):' : `Fix it in ${context.dir}:`);
    if (abi || (pm.name === 'npm' && (pm.major ?? 0) < 12)) {
      lines.push(`  ${npm} rebuild ${pkg}`);
      if (!(pm.name === 'npm' && (pm.major ?? 0) < 12)) {
        lines.push(`(if npm 12 or newer says the script is blocked, run ${npm} install-scripts approve ${pkg} first)`);
      }
    } else {
      lines.push(`  ${npm} install-scripts approve ${pkg}`);
      lines.push(`  ${npm} rebuild ${pkg}`);
      lines.push('');
      lines.push(`Or add this to ${where} before npm install, so a fresh install works too:`);
      lines.push(`  "allowScripts": { "${pkg}": true }`);
      lines.push(`(npm 10 and 11 run the script on their own: there, ${npm} rebuild ${pkg} is enough.)`);
    }
  }
  lines.push('');
  lines.push(`Underlying error: ${firstLine(messageOf(error))}`);
  return lines.join('\n');
}

function quote(path: string): string {
  return /[\s"'$`\\]/.test(path) ? `"${path.replace(/(["$`\\])/g, '\\$1')}"` : path;
}
