/**
 * `ZLENS_<X>` first, then the old `DQL_<X>`; any other name is read as is.
 * A copy of `readEnv` from `@zlens/core` (packages/dql-core/src/env.ts), kept
 * here so this package stays free of dependencies. Keep the two identical.
 */
export function readEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
): string | undefined {
  const suffix = name.startsWith('ZLENS_') ? name.slice(6) : name.startsWith('DQL_') ? name.slice(4) : undefined;
  if (!suffix) return env[name];
  const current = env[`ZLENS_${suffix}`];
  return current !== undefined ? current : env[`DQL_${suffix}`];
}

/**
 * ZLENS_NO_EGRESS=1 (or true, on, yes): ZLens reaches nothing on the internet. No update check, no DuckDB
 * extension downloads, no driver installs from npm (drivers come with the install, `ZLENS_CONNECTOR_PATH`),
 * no MetricFlow install or embedding model download, no dbt Cloud Semantic Layer, no Git repository or remote,
 * no MCP servers or hosted connectors, and no Slack, email or webhook deliveries (apps/cli deployment-locks.ts,
 * llm/mcp-config.ts and schedule/notifiers; @zlens/core repo-resolver.ts). For a container with no outbound
 * access, such as an app inside Snowflake. Model providers follow ZLENS_MODEL_PROVIDERS.
 */
export function noEgress(env: Readonly<Record<string, string | undefined>> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}): boolean {
  return /^(1|true|on|yes)$/i.test(readEnv('ZLENS_NO_EGRESS', env)?.trim() ?? '');
}

/**
 * ZLENS_CONNECTOR_PATH: folders (separated like PATH) whose `node_modules` hold drivers installed with
 * ZLens itself, e.g. baked into a container image. Searched after the project's `.dql/connectors`.
 */
export function bundledConnectorFolders(env: Readonly<Record<string, string | undefined>> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}, delimiter = ((globalThis as { process?: { platform?: string } }).process?.platform === 'win32' ? ';' : ':')): string[] {
  return (readEnv('ZLENS_CONNECTOR_PATH', env) ?? '').split(delimiter).map((folder) => folder.trim()).filter(Boolean);
}
