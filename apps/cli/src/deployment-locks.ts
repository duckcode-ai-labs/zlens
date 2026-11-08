import { readEnv } from '@zlens/core';
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
 */
export function connectionsLocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(readEnv('ZLENS_LOCK_CONNECTIONS', env)?.trim() ?? '');
}

export const LOCKED_CONNECTIONS_REASON = 'The connection was set up with this install and cannot be changed here (ZLENS_LOCK_CONNECTIONS). Testing it, choosing schemas and syncing still work.';

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
  const signIn = /^\/api\/auth\/(claude|codex)\/(start|complete)$/.exec(path);
  if (signIn) {
    const id = OAUTH_PROVIDER_IDS[signIn[1]!]!;
    if (!modelProviderAllowed(id, env)) return modelProviderRefusedReason(id);
  }
  return undefined;
}
