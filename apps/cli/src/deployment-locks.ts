import { readEnv } from '@zlens/core';
import { noEgress } from '@zlens/connectors';
import { modelProviderAllowed } from './settings/provider-settings.js';

/**
 * Locks for ZLens installed as a packaged app (such as an app inside Snowflake), where whoever
 * installed it chose the connection and the model and the person using it may not change them.
 * Single user, no host: these are switches on the install, not permissions per person.
 *
 * - ZLENS_LOCK_CONNECTIONS=1: the project's connections are fixed. Nothing adds, edits, deletes,
 *   renames or switches a connection, imports one from a dbt profile, or installs a driver; a request
 *   cannot bring its own connection. Testing the connection, choosing schemas and syncing still work.
 * - ZLENS_MODEL_PROVIDERS (settings/provider-settings.ts): which model providers may be chosen.
 * - ZLENS_NO_EGRESS=1 (@zlens/connectors env.ts): nothing reaches the internet, so nothing installs at run
 *   time (MetricFlow, Ollama models) and nothing talks to an outside service (dbt Cloud; a Git repository or
 *   remote; MCP servers and hosted connectors; Slack, email and webhook deliveries are refused where they are
 *   sent, schedule/notifiers/index.ts).
 */
export function connectionsLocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(readEnv('ZLENS_LOCK_CONNECTIONS', env)?.trim() ?? '');
}

export const LOCKED_CONNECTIONS_REASON = 'The connection was set up with this install and cannot be changed here (ZLENS_LOCK_CONNECTIONS). Testing it, choosing schemas and syncing still work.';

export const NO_EGRESS_METRICFLOW_REASON = 'This install has no internet access (ZLENS_NO_EGRESS), so MetricFlow cannot be installed here. Metrics compile with ZLens\'s own engine.';
export const NO_EGRESS_DBT_CLOUD_REASON = 'This install has no internet access (ZLENS_NO_EGRESS), so it cannot use the dbt Cloud Semantic Layer. Metrics compile with ZLens\'s own engine.';
export const NO_EGRESS_MODEL_DOWNLOAD_REASON = 'This install has no internet access (ZLENS_NO_EGRESS), so it does not download embedding models.';
export const NO_EGRESS_GIT_REPOSITORY_REASON = 'This install has no internet access (ZLENS_NO_EGRESS), so it cannot read a Git repository. Use a project folder on this install.';
export const NO_EGRESS_GIT_REMOTE_REASON = 'This install has no internet access (ZLENS_NO_EGRESS), so it cannot reach a Git remote.';
export const NO_EGRESS_MCP_REASON = 'This install has no internet access (ZLENS_NO_EGRESS), so it connects to no MCP servers or hosted connectors.';

/** Git routes that reach a remote (or set one), refused without internet access. Local Git work is unaffected. */
const GIT_REMOTE_ROUTES = new Set([
  '/api/git/remote', '/api/git/remote/connect-own', '/api/git/push', '/api/git/fetch', '/api/git/pull',
  '/api/git/review', '/api/git/review/open', '/api/git/send-as-branch',
]);

/**
 * Why a request that names a Git repository to read (`repoUrl`, as the dbt project and semantic-layer imports
 * take) is refused without internet access; undefined when it names none or the install has internet access.
 */
export function noEgressRepositoryRefusal(body: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!noEgress(env) || !body || typeof body !== 'object') return undefined;
  const repoUrl = (body as { repoUrl?: unknown }).repoUrl;
  return typeof repoUrl === 'string' && repoUrl.trim() ? NO_EGRESS_GIT_REPOSITORY_REASON : undefined;
}

export function modelProviderRefusedReason(id: string): string {
  return `The ${id} model provider is not available on this install (ZLENS_MODEL_PROVIDERS).`;
}

/** The subscription sign-in routes' provider names, as model provider settings ids. */
const OAUTH_PROVIDER_IDS: Record<string, string> = { claude: 'claude-code', codex: 'codex' };

/**
 * Why a request is refused by this install's locks, from its method and path alone; undefined when it
 * is not. Routes whose answer depends on the body (saving or testing a model provider, embeddings)
 * check `modelProviderAllowed` themselves.
 */
export function deploymentLockRefusal(method: string, path: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (connectionsLocked(env)) {
    if (method === 'PUT' && path === '/api/connections') return LOCKED_CONNECTIONS_REASON;
    if (method === 'POST' && (path === '/api/connectors/install' || path === '/api/connections/dbt-profiles/preview')) return LOCKED_CONNECTIONS_REASON;
  }
  if (noEgress(env) && method === 'POST') {
    if (path === '/api/semantic-runtime/metricflow/install') return NO_EGRESS_METRICFLOW_REASON;
    if (path === '/api/semantic-runtime/dbt-cloud/test' || path === '/api/semantic-runtime/dbt-cloud/apply') return NO_EGRESS_DBT_CLOUD_REASON;
    if (path === '/api/settings/embeddings/install') return NO_EGRESS_MODEL_DOWNLOAD_REASON;
    if (path === '/api/settings/mcp') return NO_EGRESS_MCP_REASON;
    if (GIT_REMOTE_ROUTES.has(path)) return NO_EGRESS_GIT_REMOTE_REASON;
  }
  const signIn = /^\/api\/auth\/(claude|codex)\/(start|complete)$/.exec(path);
  if (signIn) {
    const id = OAUTH_PROVIDER_IDS[signIn[1]!]!;
    if (!modelProviderAllowed(id, env)) return modelProviderRefusedReason(id);
  }
  return undefined;
}
