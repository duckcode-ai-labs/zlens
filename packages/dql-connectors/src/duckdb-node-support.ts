/**
 * The `duckdb` npm package ZLens installs into `.dql/connectors` (1.4.4, the
 * last release of DuckDB's deprecated Node client) ships prebuilt binaries
 * only for these Node majors (ABI 115, 127, 137). On any other Node, npm
 * compiles DuckDB from source: over ten minutes on a fast laptop, and a
 * failure without Python and a C++ toolchain. ZLens says so instead of
 * starting that build. docs/design/duckdb-node-api-migration.md has the way out.
 */
export const DUCKDB_PREBUILT_NODE_MAJORS: readonly number[] = [20, 22, 24];

/** Set to 1 to let ZLens install `duckdb` on a Node without a prebuilt binary (a source build). */
export const DUCKDB_SOURCE_BUILD_ENV = 'ZLENS_DUCKDB_BUILD_FROM_SOURCE';

function nodeMajor(version: string): number {
  return Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
}

/** Whether the `duckdb` package has a prebuilt binary for this Node (by major). */
export function duckdbHasPrebuiltBinary(version: string = process.versions.node): boolean {
  return DUCKDB_PREBUILT_NODE_MAJORS.includes(nodeMajor(version));
}

/** Whether someone asked for the source build anyway. */
export function duckdbSourceBuildAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DUCKDB_SOURCE_BUILD_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * The one-line reason the DuckDB driver cannot be installed or loaded on this
 * Node, or null when it has a prebuilt binary.
 */
export function duckdbNoPrebuiltReason(version: string = process.versions.node): string | null {
  if (duckdbHasPrebuiltBinary(version)) return null;
  return `ZLens's DuckDB driver has no prebuilt binary for Node ${nodeMajor(version)} yet; use Node 24 LTS or 22.`;
}

/** The reason plus what to do about it, for the Connections page, startup and `zlens doctor`. */
export function duckdbNoPrebuiltHelp(version: string = process.versions.node): string | null {
  const reason = duckdbNoPrebuiltReason(version);
  if (!reason) return null;
  return [
    reason,
    `This is Node ${version}. Switch Node (for example "nvm install 24" or "fnm use 24"), then start zlens again: the driver installs on its own.`,
    `(To compile DuckDB from source on this Node instead, which takes over 10 minutes and needs Python and a C++ toolchain, set ${DUCKDB_SOURCE_BUILD_ENV}=1 and install it from the Connections page.)`,
  ].join('\n');
}

/** Thrown instead of installing or loading `duckdb` on a Node it has no prebuilt binary for. */
export class DuckDBNodeUnsupportedError extends Error {
  readonly code = 'DUCKDB_NODE_UNSUPPORTED';

  constructor(readonly nodeVersion: string = process.versions.node) {
    super(duckdbNoPrebuiltHelp(nodeVersion) ?? `ZLens's DuckDB driver could not be loaded on Node ${nodeVersion}.`);
    this.name = 'DuckDBNodeUnsupportedError';
  }
}
